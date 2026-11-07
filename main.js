// ==================== Initial Settings ====================
// Keys are read from Script Properties
const PROPS = PropertiesService.getScriptProperties();
const TELEGRAM_TOKEN = PROPS.getProperty("TELEGRAM_TOKEN");
const GEMINI_API_KEY = PROPS.getProperty("GEMINI_API_KEY");
const SHEET_ID = PROPS.getProperty("SHEET_ID");

// Best default model for high speed and multimodal understanding (image/file)
const DEFAULT_MODEL = "gemini-3.5-flash-lite"; 
const MAX_HISTORY = 20;       // Maximum messages sent to the model (10 round-trips)
const READ_LAST_ROWS = 300;   // Read only the last 300 rows to maintain speed
const KEEP_ROWS = 2000;       
const SHEET_NAME = "history";

// ==================== Save Keys (Run only once for setup) ====================
function setSecrets() {
  PROPS.setProperties({
    TELEGRAM_TOKEN: "YOUR_TELEGRAM_TOKEN",
    GEMINI_API_KEY: "YOUR_GEMINI_API_KEY",
    SHEET_ID: "YOUR_SHEET_ID"
  });
  Logger.log("Settings saved. You can now remove the values from the code.");
}

// ==================== User Models List (Fast and Static) ====================
// You can change this list based on the output of logAvailableModelsFromAPI function (at the bottom of the code)
// Best default models for your key

function getAvailableModels() {
  return [
    "gemini-3.5-flash",       // Main and fast model
    "gemini-3.5-flash-lite",  // Ultra-lightweight version
    "gemini-omni-1.1-flash",  // Advanced multimodal model
    "gemini-4-argon"          // New generation model
  ];
}

// ==================== Receive Webhook Requests ====================
function doPost(e) {
  try {
    const update = JSON.parse(e.postData.contents);

    // Prevent processing duplicate updates
    if (isDuplicateUpdate(update.update_id)) {
      return HtmlService.createHtmlOutput("OK");
    }

    // Click on inline button (Model selection)
    if (update.callback_query) {
      handleCallbackQuery(update.callback_query);
      return HtmlService.createHtmlOutput("OK");
    }

    if (!update.message) {
      return HtmlService.createHtmlOutput("OK");
    }

    const chatId = update.message.chat.id;
    const messageId = update.message.message_id;
    let text = update.message.text || update.message.caption || "";
    
    // Detect file, photo, or voice message
    let fileId = null;
    let mimeType = null;

    if (update.message.photo) {
      const photo = update.message.photo[update.message.photo.length - 1]; // Highest quality
      fileId = photo.file_id;
      mimeType = "image/jpeg";
    } else if (update.message.voice) {
      fileId = update.message.voice.file_id;
      mimeType = update.message.voice.mime_type || "audio/ogg";
    } else if (update.message.document) {
      fileId = update.message.document.file_id;
      mimeType = update.message.document.mime_type || "application/pdf";
    }

    // Process main bot commands
    if (text === "/start" || text === "/help") {
      const welcomeMsg =
        "سلام! من دستیار هوشمند شما هستم 🤖\n\n" +
        "🔹 /models ← انتخاب مدل هوش مصنوعی\n" +
        "🔹 /new ← پاک کردن حافظه گفتگو\n" +
        "🔹 /persona [نقش] ← تعیین شخصیت (مثال: /persona تو یک وکیل هستی)\n\n" +
        "🎙 *می‌توانید عکس، فایل (PDF) یا ویس بفرستید تا تحلیل کنم!*";
      sendTelegramMessage(chatId, welcomeMsg);
      return HtmlService.createHtmlOutput("OK");
    }
    else if (text === "/models") {
      sendModelSelectionMenu(chatId);
      return HtmlService.createHtmlOutput("OK");
    }
    else if (text === "/new" || text === "/reset") {
      clearHistory(chatId);
      sendTelegramMessage(chatId, "🧹 حافظه گفتگو پاک شد. آماده برای مکالمه جدید!");
      return HtmlService.createHtmlOutput("OK");
    }
    else if (text.startsWith("/persona")) {
      const role = text.substring(8).trim();
      if (role === "") {
        setUserPersona(chatId, null);
        sendTelegramMessage(chatId, "🎭 نقش ربات حذف شد و به حالت عادی برگشت.");
      } else {
        setUserPersona(chatId, role);
        sendTelegramMessage(chatId, `🎭 نقش ربات تنظیم شد به:\n_"${role}"_`);
      }
      return HtmlService.createHtmlOutput("OK");
    }

    // Process file if it exists
    let fileBase64 = null;
    if (fileId) {
      sendChatAction(chatId, "upload_document");
      fileBase64 = getTelegramFileBase64(fileId);
      if (!text) text = "لطفاً این فایل را به دقت بررسی و تحلیل کن."; // Default text
    } else {
      sendChatAction(chatId, "typing");
    }

    if (!text && !fileBase64) return HtmlService.createHtmlOutput("OK");

    const currentModel = getUserModel(chatId);
    
    // Send live "Processing..." message
    const processingMsg = UrlFetchApp.fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "post", contentType: "application/json",
      payload: JSON.stringify({ chat_id: chatId, text: "⏳ _در حال تحلیل و تفکر..._", parse_mode: "Markdown" }),
      muteHttpExceptions: true
    });
    let processingMsgId = null;
    if (processingMsg.getResponseCode() === 200) {
      processingMsgId = JSON.parse(processingMsg.getContentText()).result.message_id;
    }

    // Request to Gemini AI
    const reply = askGemini(chatId, text, currentModel, fileBase64, mimeType);
    
    // Delete "Processing..." message
    if (processingMsgId) {
      UrlFetchApp.fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`, {
        method: "post", contentType: "application/json",
        payload: JSON.stringify({ chat_id: chatId, message_id: processingMsgId }),
        muteHttpExceptions: true
      });
    }

    // Send final response
    sendLongTelegramMessage(chatId, reply, messageId);

  } catch (err) {
    Logger.log("Error in doPost: " + err.toString());
  }

  return HtmlService.createHtmlOutput("OK");
}

// ==================== Duplicate Execution Prevention Functions ====================
function isDuplicateUpdate(updateId) {
  if (updateId === undefined) return false;
  const cache = CacheService.getScriptCache();
  const key = "upd_" + updateId;
  if (cache.get(key)) return true;
  cache.put(key, "1", 600); // 10 minutes
  return false;
}

// ==================== Memory and Google Sheet Management ====================
function getSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(["chatId", "role", "text", "time"]);
    sh.getRange("A:C").setNumberFormat("@");
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
      if (r[1] === "reset") { history = []; return; }
      if (r[1] !== "user" && r[1] !== "model") return;
      history.push({ role: r[1], parts: [{ text: String(r[2]) }] });
    });

    history = history.slice(-MAX_HISTORY);
    while (history.length && history[0].role !== "user") history.shift();
    return history;
  } catch (e) {
    return [];
  }
}

function appendHistory(chatId, role, text) {
  const safeText = String(text).substring(0, 49000); 
  getSheet().appendRow([String(chatId), role, safeText, new Date()]);
}

function clearHistory(chatId) {
  appendHistory(chatId, "reset", "");
}

// ==================== User Personal Settings ====================
function getUserModel(chatId) {
  return PROPS.getProperty("model_" + chatId) || DEFAULT_MODEL;
}

function setUserModel(chatId, modelName) {
  PROPS.setProperty("model_" + chatId, modelName);
}

function getUserPersona(chatId) {
  return PROPS.getProperty("persona_" + chatId);
}

function setUserPersona(chatId, personaText) {
  if (!personaText) {
    PROPS.deleteProperty("persona_" + chatId);
  } else {
    PROPS.setProperty("persona_" + chatId, personaText);
  }
}

// ==================== Download File from Telegram Server ====================
function getTelegramFileBase64(fileId) {
  try {
    const getFileUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`;
    const fileRes = JSON.parse(UrlFetchApp.fetch(getFileUrl).getContentText());
    if (!fileRes.ok) return null;

    const filePath = fileRes.result.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;

    const response = UrlFetchApp.fetch(downloadUrl);
    const blob = response.getBlob();
    return Utilities.base64Encode(blob.getBytes());
  } catch (e) {
    Logger.log("Error downloading file: " + e.toString());
    return null;
  }
}

// ==================== Gemini Communication Engine ====================
function askGemini(chatId, promptText, modelName, fileBase64 = null, mimeType = null) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

  const contents = getHistory(chatId);
  
  // Structuring user message along with attachments
  const userParts = [];
  if (promptText) {
    userParts.push({ text: promptText });
  }
  if (fileBase64 && mimeType) {
    userParts.push({
      inlineData: { mimeType: mimeType, data: fileBase64 }
    });
  }
  contents.push({ role: "user", parts: userParts });

  const payload = {
    contents: contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 2500 }
  };

  // Injecting live time and persona instructions
  const now = Utilities.formatDate(new Date(), "Asia/Tehran", "yyyy/MM/dd HH:mm:ss");
  let systemContext = "تو یک دستیار هوشمند هستی. تاریخ و ساعت دقیق فعلی سیستم به وقت ایران: " + now;
  
  const persona = getUserPersona(chatId);
  if (persona) {
    systemContext += "\n\nنقش و شخصیت تو برای این مکالمه:\n" + persona;
  }

  payload.systemInstruction = {
    parts: [{ text: systemContext }]
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

    if (json.candidates && json.candidates[0].content) {
      const reply = json.candidates[0].content.parts.map(p => p.text || "").join("");

      // Prevent saving base64 in the sheet
      const historyPromptText = fileBase64 ? (promptText + "\n[فایل/عکس پیوست شد]") : promptText;
      try {
        appendHistory(chatId, "user", historyPromptText);
        appendHistory(chatId, "model", reply);
      } catch (e) {}

      return reply;
    } else if (json.error) {
      return "خطای API جمنای: " + json.error.message;
    } else {
      return "پاسخی از مدل دریافت نشد. لطفاً دوباره تلاش کنید.";
    }
  } catch (error) {
    return "خطایی در سرور رخ داد: " + error.toString();
  }
}

// ==================== Beautiful Rendering of Texts and Codes in Telegram ====================
function convertToTelegramMarkdownV2(text) {
  if (!text) return "";
  
  // 1. Protect code blocks (using @ instead of _ to prevent conflicts)
  let codeBlocks = [];
  text = text.replace(/```([\s\S]*?)```/g, (match) => {
    codeBlocks.push(match);
    return `@@CB${codeBlocks.length - 1}@@`;
  });
  let inlineCodes = [];
  text = text.replace(/`([^`]+)`/g, (match) => {
    inlineCodes.push(match);
    return `@@IC${inlineCodes.length - 1}@@`;
  });

  // 2. Escape Telegram sensitive characters
  const specialChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  specialChars.forEach(char => {
    const regex = new RegExp('\\' + char, 'g');
    text = text.replace(regex, '\\' + char);
  });

  // 3. Convert Gemini markdown syntax to Telegram
  text = text.replace(/\\\*\\\*(.*?)\\\*\\\*/g, '*$1*'); // Bold
  text = text.replace(/\\\*(.*?)\\\*/g, '_$1_');         // Italic

  // 4. Restore codes safely
  text = text.replace(/@@CB(\d+)@@/g, (match, p1) => codeBlocks[p1]);
  text = text.replace(/@@IC(\d+)@@/g, (match, p1) => inlineCodes[p1]);

  return text;
}

function sendTelegramMessage(chatId, text, replyMarkup = null, replyToId = null) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const formattedText = convertToTelegramMarkdownV2(text);

  const payload = {
    chat_id: chatId,
    text: formattedText,
    parse_mode: "MarkdownV2"
  };

  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (replyToId) {
    payload.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
  }

  const response = UrlFetchApp.fetch(url, {
    method: "post", contentType: "application/json",
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    delete payload.parse_mode;
    payload.text = text; 
    UrlFetchApp.fetch(url, {
      method: "post", contentType: "application/json",
      payload: JSON.stringify(payload), muteHttpExceptions: true
    });
  }
}

function sendLongTelegramMessage(chatId, text, replyToId = null) {
  const MAX_LENGTH = 4000;
  if (!text) return;
  for (let i = 0; i < text.length; i += MAX_LENGTH) {
    const chunk = text.substring(i, i + MAX_LENGTH);
    sendTelegramMessage(chatId, chunk, null, i === 0 ? replyToId : null);
  }
}

function sendChatAction(chatId, action) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendChatAction`;
  UrlFetchApp.fetch(url, {
    method: "post", contentType: "application/json",
    payload: JSON.stringify({ chat_id: chatId, action: action }), muteHttpExceptions: true
  });
}

// ==================== Model Selection Menu Management ====================
function sendModelSelectionMenu(chatId) {
  const currentModel = getUserModel(chatId);
  const models = getAvailableModels();

  let inlineKeyboard = [];
  let currentRow = [];

  models.forEach((modelName) => {
    const isSelected = (modelName === currentModel);
    const label = (isSelected ? "✅ " : "") + modelName;
    currentRow.push({ text: label, callback_data: "set_model:" + modelName });
    
    if (currentRow.length === 2) { 
        inlineKeyboard.push(currentRow); 
        currentRow = []; 
    }
  });
  
  if (currentRow.length > 0) inlineKeyboard.push(currentRow);

  const keyboard = { inline_keyboard: inlineKeyboard };
  sendTelegramMessage(chatId, "⚡️ لیست مدل‌های فعال برای شما:", keyboard);
}

function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  if (data.startsWith("set_model:")) {
    const selectedModel = data.substring("set_model:".length);
    setUserModel(chatId, selectedModel);
    
    UrlFetchApp.fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
      method: "post", contentType: "application/json",
      payload: JSON.stringify({ callback_query_id: callbackQuery.id, text: "مدل با موفقیت تنظیم شد!" }),
      muteHttpExceptions: true
    });
    
    sendTelegramMessage(chatId, `✅ مدل فعال شما با موفقیت تغییر کرد به:\n\`${selectedModel}\``);
  }
}

// ==================== Admin Tool (Run in Google Apps Script environment) ====================
function logAvailableModelsFromAPI() {
  Logger.log("در حال ارتباط با API برای دریافت مدل‌های در دسترس...");
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}&pageSize=100`;
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    
    if (response.getResponseCode() === 200) {
      const json = JSON.parse(response.getContentText());
      if (json.models) {
        const activeModels = json.models
          .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent"))
          .map(m => m.name.replace("models/", ""));
          
        Logger.log("✅ لیست تمام مدل‌های فعال برای کلید شما:\n");
        activeModels.forEach((model, idx) => {
          Logger.log(`${idx + 1}. ${model}`);
        });
        Logger.log("\n💡 راهنمایی: نام مدل‌های بالا را می‌توانید در تابع 'getAvailableModels' کپی کنید.");
      }
    } else {
      Logger.log("❌ خطای API: " + response.getContentText());
    }
  } catch (e) {
    Logger.log("❌ ارور در دریافت اطلاعات: " + e.toString());
  }
}