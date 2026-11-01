// ==================== INITIAL SETTINGS ====================
// All keys are stored in Script Properties, not inside the code.
const PROPS = PropertiesService.getScriptProperties();
const TELEGRAM_TOKEN = PROPS.getProperty("TELEGRAM_TOKEN");
const GEMINI_API_KEY = PROPS.getProperty("GEMINI_API_KEY");
const SHEET_ID = PROPS.getProperty("SHEET_ID");

const DEFAULT_MODEL = "gemini-3.5-flash-lite"; // Use logModels() to see available models for your key
const MAX_HISTORY = 20;       // Max messages sent to the model (10 turns)
const READ_LAST_ROWS = 300;   // Only read the last N rows from the sheet for better performance
const KEEP_ROWS = 2000;       // cleanupOldRows() will keep only this many last rows
const SHEET_NAME = "history";

// ==================== SAVE SECRETS (RUN ONCE ONLY, THEN REMOVE/COMMENT OUT) ====================
function setSecrets() {
  PROPS.setProperties({
    TELEGRAM_TOKEN: "YOUR_TELEGRAM_BOT_TOKEN",
    GEMINI_API_KEY: "YOUR_GEMINI_API_KEY",
    SHEET_ID: "YOUR_GOOGLE_SHEET_ID"
  });
  Logger.log("Saved. Now remove or comment out the values from the code.");
}

// ==================== HANDLE WEBHOOK REQUESTS ====================
function doPost(e) {
  try {
    const update = JSON.parse(e.postData.contents);

    // Prevent processing duplicate updates
    if (isDuplicateUpdate(update.update_id)) {
      return HtmlService.createHtmlOutput("OK");
    }

    // Handle inline keyboard button clicks (model selection)
    if (update.callback_query) {
      handleCallbackQuery(update.callback_query);
      return HtmlService.createHtmlOutput("OK");
    }

    // Ignore updates without text messages
    if (!update.message || !update.message.text) {
      return HtmlService.createHtmlOutput("OK");
    }

    const chatId = update.message.chat.id;
    const text = update.message.text.trim();
    const messageId = update.message.message_id;

    if (text === "/start" || text === "/help") {
      const welcomeMsg =
        "Hi! I'm an AI bot connected to Gemini. I remember our conversation.\n\n" +
        "🔹 /models - View and select models\n" +
        "🔹 /new - Clear memory and start a new conversation";
      sendTelegramMessage(chatId, welcomeMsg);
    }
    else if (text === "/models") {
      sendModelSelectionMenu(chatId);
    }
    else if (text === "/new" || text === "/reset") {
      clearHistory(chatId);
      sendTelegramMessage(chatId, "🧹 Conversation memory cleared. Starting a new conversation.");
    }
    else {
      const currentModel = getUserModel(chatId);
      sendChatAction(chatId, "typing");

      const reply = askGemini(chatId, text, currentModel);
      sendLongTelegramMessage(chatId, reply, messageId);
    }
  } catch (err) {
    Logger.log("Error in doPost: " + err.toString());
  }

  return HtmlService.createHtmlOutput("OK");
}

// ==================== PREVENT DUPLICATE UPDATES ====================
function isDuplicateUpdate(updateId) {
  if (updateId === undefined) return false;
  const cache = CacheService.getScriptCache();
  const key = "upd_" + updateId;
  if (cache.get(key)) return true;
  cache.put(key, "1", 600); // Cache for 10 minutes
  return false;
}

// ==================== CONVERSATION HISTORY IN GOOGLE SHEETS ====================
function getSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(["chatId", "role", "text", "time"]);
    sh.getRange("A:C").setNumberFormat("@"); // Force plain text to avoid auto-conversion to formulas or numbers
  }
  return sh;
}

function getHistory(chatId) {
  try {
    const sh = getSheet();
    const last = sh.getLastRow();
    if (last < 2) return [];

    const start = Math.max(2, last - READ_LAST_ROWS + 1);
    const rows = sh.getRange(start, 1, last - start + 1, 4).getValues();

    let history = [];
    rows.forEach(r => {
      if (String(r[0]) !== String(chatId)) return;
      if (r[1] === "reset") { history = []; return; } // Marker from /new command
      if (r[1] !== "user" && r[1] !== "model") return;
      history.push({ role: r[1], parts: [{ text: String(r[2]) }] });
    });

    history = history.slice(-MAX_HISTORY);
    // Ensure the first message is always from the user
    while (history.length && history[0].role !== "user") history.shift();
    return history;
  } catch (e) {
    Logger.log("getHistory error: " + e.toString());
    return [];
  }
}

function appendHistory(chatId, role, text) {
  // Google Sheets has a maximum limit of 50,000 characters per cell
  const safeText = String(text).substring(0, 49000);
  getSheet().appendRow([String(chatId), role, safeText, new Date()]);
}

function clearHistory(chatId) {
  try {
    appendHistory(chatId, "reset", ""); // Messages before this marker are ignored
  } catch (e) {
    Logger.log("clearHistory error: " + e.toString());
  }
}

// ==================== FETCH AVAILABLE MODELS FROM GEMINI API ====================
function getAvailableModels() {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}&pageSize=100`;
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const json = JSON.parse(response.getContentText());

    if (json.models) {
      return json.models
        .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent"))
        .map(m => m.name.replace("models/", ""));
    }
  } catch (e) {
    Logger.log("Error fetching models: " + e.toString());
  }
  return [DEFAULT_MODEL];
}

// ==================== COMMUNICATE WITH GEMINI API (WITH HISTORY) ====================
function askGemini(chatId, promptText, modelName) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

  // Previous history + new message
  const contents = getHistory(chatId);
  contents.push({ role: "user", parts: [{ text: promptText }] });

  const payload = {
    contents: contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2000
    }
  };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const json = JSON.parse(response.getContentText());

    if (json.candidates && json.candidates[0].content &&
        json.candidates[0].content.parts && json.candidates[0].content.parts[0].text) {

      const reply = json.candidates[0].content.parts
        .map(p => p.text || "")
        .join("");

      // Only save successful responses to history
      try {
        appendHistory(chatId, "user", promptText);
        appendHistory(chatId, "model", reply);
      } catch (e) {
        Logger.log("append error: " + e.toString());
      }

      return reply;
    } else if (json.error) {
      return "Gemini API Error: " + json.error.message;
    } else {
      return "No response received from the model.";
    }
  } catch (error) {
    return "Error connecting to server: " + error.toString();
  }
}

// ==================== MANAGE USER'S SELECTED MODEL (PERSISTENT) ====================
function getUserModel(chatId) {
  return PROPS.getProperty("model_" + chatId) || DEFAULT_MODEL;
}

function setUserModel(chatId, modelName) {
  PROPS.setProperty("model_" + chatId, modelName);
}

// ==================== SEND LONG MESSAGES (SPLIT IF > 4000 CHARACTERS) ====================
function sendLongTelegramMessage(chatId, text, replyToId = null) {
  const MAX_LENGTH = 4000;
  if (!text) return;

  for (let i = 0; i < text.length; i += MAX_LENGTH) {
    const chunk = text.substring(i, i + MAX_LENGTH);
    // Only reply to the original message for the first chunk
    sendTelegramMessage(chatId, chunk, null, i === 0 ? replyToId : null);
  }
}

// ==================== TELEGRAM API CORE FUNCTIONS ====================
function sendTelegramMessage(chatId, text, replyMarkup = null, replyToId = null) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown"
  };

  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  if (replyToId) {
    payload.reply_parameters = {
      message_id: replyToId,
      allow_sending_without_reply: true
    };
  }

  const response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  // If Markdown parsing fails, resend without formatting
  if (response.getResponseCode() !== 200) {
    delete payload.parse_mode;
    UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  }
}

function sendChatAction(chatId, action) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendChatAction`;
  UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ chat_id: chatId, action: action }),
    muteHttpExceptions: true
  });
}

// ==================== BUILD LIVE MODEL SELECTION MENU ====================
function sendModelSelectionMenu(chatId) {
  const currentModel = getUserModel(chatId);
  const models = getAvailableModels();

  let inlineKeyboard = [];
  let currentRow = [];

  models.forEach((modelName) => {
    const isSelected = (modelName === currentModel);
    const label = (isSelected ? "✅ " : "") + modelName;

    currentRow.push({
      text: label,
      callback_data: "set_model:" + modelName
    });

    if (currentRow.length === 2) {
      inlineKeyboard.push(currentRow);
      currentRow = [];
    }
  });

  if (currentRow.length > 0) {
    inlineKeyboard.push(currentRow);
  }

  const keyboard = { inline_keyboard: inlineKeyboard };
  sendTelegramMessage(
    chatId,
    "⚡️ Live list of active models for your key (click on a model to switch):",
    keyboard
  );
}

// ==================== HANDLE MODEL SELECTION BUTTON CLICKS ====================
function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  if (data.startsWith("set_model:")) {
    const selectedModel = data.substring("set_model:".length);
    setUserModel(chatId, selectedModel);

    UrlFetchApp.fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        callback_query_id: callbackQuery.id,
        text: "Model set successfully!"
      }),
      muteHttpExceptions: true
    });

    sendTelegramMessage(chatId, `✅ Your active model has been successfully changed to:\n\`${selectedModel}\``);
  }
}

// ==================== SET WEBHOOK (RUN ONCE ONLY) ====================
function setWebhook() {
  const WEBHOOK_URL = "YOUR_WEB_APP_URL_HERE (must end with /exec)";

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${encodeURIComponent(WEBHOOK_URL)}`;
  const response = UrlFetchApp.fetch(url);
  Logger.log(response.getContentText());
}

// ==================== HELPER UTILITIES (RUN FROM EDITOR) ====================

// View list of models in logs
function logModels() {
  const models = getAvailableModels();
  Logger.log("Number of models: " + models.length);
  models.forEach((name, i) => Logger.log((i + 1) + ". " + name));
}

// View raw API response if model list is empty
function logModelsRaw() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}&pageSize=100`;
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log("Response code: " + response.getResponseCode());
  Logger.log(response.getContentText().substring(0, 1500));
}

// View history being sent to the model
function debugHistory() {
  const chatId = "YOUR_TELEGRAM_CHAT_ID";
  Logger.log(JSON.stringify(getHistory(chatId), null, 2));
}

// View memory usage
function checkMemoryUsage() {
  const chatId = "YOUR_TELEGRAM_CHAT_ID";
  const sh = getSheet();
  const totalRows = Math.max(0, sh.getLastRow() - 1);

  const history = getHistory(chatId);
  const json = JSON.stringify(history);
  const bytes = Utilities.newBlob(json).getBytes().length;

  Logger.log("Total rows in sheet (all chats): " + totalRows);
  Logger.log("Messages sent to model: " + history.length + " of " + MAX_HISTORY);
  Logger.log("Payload size: " + (bytes / 1024).toFixed(1) + " KB");
  Logger.log("Approximate tokens: " + Math.round(json.length / 3));
}

// Clean up old rows (run manually or set a weekly trigger)
function cleanupOldRows() {
  const sh = getSheet();
  const last = sh.getLastRow();
  const dataRows = last - 1;
  if (dataRows <= KEEP_ROWS) {
    Logger.log("No cleanup needed. Rows: " + dataRows);
    return;
  }
  const toDelete = dataRows - KEEP_ROWS;
  sh.deleteRows(2, toDelete);
  Logger.log(toDelete + " old rows deleted.");
}