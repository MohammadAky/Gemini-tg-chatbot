// ==================== INITIAL SETTINGS ====================
// All keys are stored in Script Properties, not inside the code.
const PROPS_BALE = PropertiesService.getScriptProperties();
const BALE_TOKEN = PROPS_BALE.getProperty("BALE_TOKEN");
const GEMINI_API_KEY_BALE = PROPS_BALE.getProperty("GEMINI_API_KEY");
const SHEET_ID_BALE = PROPS_BALE.getProperty("SHEET_ID");

const DEFAULT_MODEL_BALE = "gemini-3.5-flash-lite"; // Use logModelsBale() to see available models for your key
const MAX_HISTORY_BALE = 20;       // Max messages sent to the model (10 turns)
const READ_LAST_ROWS_BALE = 300;   // Only read the last N rows from the sheet for better performance
const KEEP_ROWS_BALE = 2000;       // cleanupOldRowsBale() will keep only this many last rows
const SHEET_NAME_BALE = "history_bale";

// ==================== SAVE SECRETS (RUN ONCE ONLY, THEN REMOVE/COMMENT OUT) ====================
function setSecretsBale() {
  PROPS_BALE.setProperties({
    BALE_TOKEN: "YOUR_BALE_BOT_TOKEN",
    GEMINI_API_KEY: "YOUR_GEMINI_API_KEY",
    SHEET_ID: "YOUR_GOOGLE_SHEET_ID"
  });
  Logger.log("Saved. Now remove or comment out the values from the code.");
}

// ==================== HANDLE WEBHOOK REQUESTS ====================
function doPostBale(e) {
  try {
    const update = JSON.parse(e.postData.contents);

    // Prevent processing duplicate updates
    if (isDuplicateUpdateBale(update.update_id)) {
      return HtmlService.createHtmlOutput("OK");
    }

    // Handle inline keyboard button clicks (model selection)
    if (update.callback_query) {
      handleCallbackQueryBale(update.callback_query);
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
      sendBaleMessage(chatId, welcomeMsg);
    }
    else if (text === "/models") {
      sendModelSelectionMenuBale(chatId);
    }
    else if (text === "/new" || text === "/reset") {
      clearHistoryBale(chatId);
      sendBaleMessage(chatId, "🧹 Conversation memory cleared. Starting a new conversation.");
    }
    else {
      const currentModel = getUserModelBale(chatId);
      sendChatActionBale(chatId, "typing");

      const reply = askGeminiBale(chatId, text, currentModel);
      sendLongBaleMessage(chatId, reply, messageId);
    }
  } catch (err) {
    Logger.log("Error in doPostBale: " + err.toString());
  }

  return HtmlService.createHtmlOutput("OK");
}

// ==================== PREVENT DUPLICATE UPDATES ====================
function isDuplicateUpdateBale(updateId) {
  if (updateId === undefined) return false;
  const cache = CacheService.getScriptCache();
  const key = "upd_bale_" + updateId;
  if (cache.get(key)) return true;
  cache.put(key, "1", 600); // Cache for 10 minutes
  return false;
}

// ==================== CONVERSATION HISTORY IN GOOGLE SHEETS ====================
function getSheetBale() {
  const ss = SpreadsheetApp.openById(SHEET_ID_BALE);
  let sh = ss.getSheetByName(SHEET_NAME_BALE);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME_BALE);
    sh.appendRow(["chatId", "role", "text", "time"]);
    sh.getRange("A:C").setNumberFormat("@"); // Force plain text to avoid auto-conversion to formulas or numbers
  }
  return sh;
}

function getHistoryBale(chatId) {
  try {
    const sh = getSheetBale();
    const last = sh.getLastRow();
    if (last < 2) return [];

    const start = Math.max(2, last - READ_LAST_ROWS_BALE + 1);
    const rows = sh.getRange(start, 1, last - start + 1, 4).getValues();

    let history = [];
    rows.forEach(r => {
      if (String(r[0]) !== String(chatId)) return;
      if (r[1] === "reset") { history = []; return; } // Marker from /new command
      if (r[1] !== "user" && r[1] !== "model") return;
      history.push({ role: r[1], parts: [{ text: String(r[2]) }] });
    });

    history = history.slice(-MAX_HISTORY_BALE);
    // Ensure the first message is always from the user
    while (history.length && history[0].role !== "user") history.shift();
    return history;
  } catch (e) {
    Logger.log("getHistoryBale error: " + e.toString());
    return [];
  }
}

function appendHistoryBale(chatId, role, text) {
  // Google Sheets has a maximum limit of 50,000 characters per cell
  const safeText = String(text).substring(0, 49000);
  getSheetBale().appendRow([String(chatId), role, safeText, new Date()]);
}

function clearHistoryBale(chatId) {
  try {
    appendHistoryBale(chatId, "reset", ""); // Messages before this marker are ignored
  } catch (e) {
    Logger.log("clearHistoryBale error: " + e.toString());
  }
}

// ==================== FETCH AVAILABLE MODELS FROM GEMINI API ====================
function getAvailableModelsBale() {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY_BALE}&pageSize=100`;
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
  return [DEFAULT_MODEL_BALE];
}

// ==================== COMMUNICATE WITH GEMINI API (WITH HISTORY) ====================
function askGeminiBale(chatId, promptText, modelName) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY_BALE}`;

  // Previous history + new message
  const contents = getHistoryBale(chatId);
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
        appendHistoryBale(chatId, "user", promptText);
        appendHistoryBale(chatId, "model", reply);
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
function getUserModelBale(chatId) {
  return PROPS_BALE.getProperty("model_bale_" + chatId) || DEFAULT_MODEL_BALE;
}

function setUserModelBale(chatId, modelName) {
  PROPS_BALE.setProperty("model_bale_" + chatId, modelName);
}

// ==================== SEND LONG MESSAGES (SPLIT IF > 4000 CHARACTERS) ====================
function sendLongBaleMessage(chatId, text, replyToId = null) {
  const MAX_LENGTH = 4000;
  if (!text) return;

  for (let i = 0; i < text.length; i += MAX_LENGTH) {
    const chunk = text.substring(i, i + MAX_LENGTH);
    // Only reply to the original message for the first chunk
    sendBaleMessage(chatId, chunk, null, i === 0 ? replyToId : null);
  }
}

// ==================== BALE API CORE FUNCTIONS ====================
function sendBaleMessage(chatId, text, replyMarkup = null, replyToId = null) {
  const url = `https://tapi.bale.ai/bot${BALE_TOKEN}/sendMessage`;

  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown"
  };

  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  if (replyToId) {
    payload.reply_to_message_id = replyToId;
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

function sendChatActionBale(chatId, action) {
  const url = `https://tapi.bale.ai/bot${BALE_TOKEN}/sendChatAction`;
  UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ chat_id: chatId, action: action }),
    muteHttpExceptions: true
  });
}

// ==================== BUILD LIVE MODEL SELECTION MENU ====================
function sendModelSelectionMenuBale(chatId) {
  const currentModel = getUserModelBale(chatId);
  const models = getAvailableModelsBale();

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
  sendBaleMessage(
    chatId,
    "⚡️ Live list of active models for your key (tap a model to switch):",
    keyboard
  );
}

// ==================== HANDLE MODEL SELECTION BUTTON CLICKS ====================
function handleCallbackQueryBale(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  if (data.startsWith("set_model:")) {
    const selectedModel = data.substring("set_model:".length);
    setUserModelBale(chatId, selectedModel);

    UrlFetchApp.fetch(`https://tapi.bale.ai/bot${BALE_TOKEN}/answerCallbackQuery`, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        callback_query_id: callbackQuery.id,
        text: "Model set successfully!"
      }),
      muteHttpExceptions: true
    });

    sendBaleMessage(chatId, `✅ Your active model has been successfully changed to:\n\`${selectedModel}\``);
  }
}

// ==================== SET WEBHOOK (RUN ONCE ONLY) ====================
function setWebhookBale() {
  const WEBHOOK_URL = "YOUR_WEB_APP_URL_HERE (must end with /exec)";

  const url = `https://tapi.bale.ai/bot${BALE_TOKEN}/setWebhook?url=${encodeURIComponent(WEBHOOK_URL)}`;
  const response = UrlFetchApp.fetch(url);
  Logger.log(response.getContentText());
}

// ==================== HELPER UTILITIES (RUN FROM EDITOR) ====================

// View list of models in logs
function logModelsBale() {
  const models = getAvailableModelsBale();
  Logger.log("Number of models: " + models.length);
  models.forEach((name, i) => Logger.log((i + 1) + ". " + name));
}

// View raw API response if model list is empty
function logModelsRawBale() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY_BALE}&pageSize=100`;
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log("Response code: " + response.getResponseCode());
  Logger.log(response.getContentText().substring(0, 1500));
}

// View history being sent to the model
function debugHistoryBale() {
  const chatId = "YOUR_BALE_CHAT_ID";
  Logger.log(JSON.stringify(getHistoryBale(chatId), null, 2));
}

// View memory usage
function checkMemoryUsageBale() {
  const chatId = "YOUR_BALE_CHAT_ID";
  const sh = getSheetBale();
  const totalRows = Math.max(0, sh.getLastRow() - 1);

  const history = getHistoryBale(chatId);
  const json = JSON.stringify(history);
  const bytes = Utilities.newBlob(json).getBytes().length;

  Logger.log("Total rows in sheet (all chats): " + totalRows);
  Logger.log("Messages sent to model: " + history.length + " of " + MAX_HISTORY_BALE);
  Logger.log("Payload size: " + (bytes / 1024).toFixed(1) + " KB");
  Logger.log("Approximate tokens: " + Math.round(json.length / 3));
}

// Clean up old rows (run manually or set a weekly trigger)
function cleanupOldRowsBale() {
  const sh = getSheetBale();
  const last = sh.getLastRow();
  const dataRows = last - 1;
  if (dataRows <= KEEP_ROWS_BALE) {
    Logger.log("No cleanup needed. Rows: " + dataRows);
    return;
  }
  const toDelete = dataRows - KEEP_ROWS_BALE;
  sh.deleteRows(2, toDelete);
  Logger.log(toDelete + " old rows deleted.");
}
