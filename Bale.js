// ==================== تنظیمات اولیه ====================
// کلیدها از Script Properties خوانده می‌شوند
const PROPS = PropertiesService.getScriptProperties();
const BALE_TOKEN = PROPS.getProperty("BALE_TOKEN");
const GEMINI_API_KEY = PROPS.getProperty("GEMINI_API_KEY");
const SHEET_ID = PROPS.getProperty("SHEET_ID");

// بهترین مدل پیش‌فرض برای سرعت بالا و درک چندوجهی
const DEFAULT_MODEL = "gemini-3.5-flash-lite"; 
const MAX_HISTORY = 20;       // حداکثر پیام‌های ارسالی به مدل (۱۰ رفت‌وبرگشت)
const READ_LAST_ROWS = 300;   // خواندن فقط ۳۰۰ ردیف آخر برای حفظ سرعت
const KEEP_ROWS = 2000;       
const SHEET_NAME = "history";

// ==================== لیست مدل‌های کاربران (سریع و ثابت) ====================
function getAvailableModels() {
  return [
    "gemini-3.5-flash",       // مدل اصلی و پرسرعت
    "gemini-3.5-flash-lite",  // نسخه فوق‌سبک
    "gemini-omni-1.1-flash",  // مدل پیشرفته چندوجهی
    "gemini-4-argon"          // مدل نسل جدید
  ];
}

// ==================== دریافت درخواست‌های وب‌هوک ====================
function doPost(e) {
  try {
    const update = JSON.parse(e.postData.contents);

    // جلوگیری از پردازش آپدیت تکراری
    if (isDuplicateUpdate(update.update_id)) {
      return HtmlService.createHtmlOutput("OK");
    }

    // کلیک روی دکمه شیشه‌ای (انتخاب مدل)
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
    
    // تشخیص ارسال فایل، عکس یا ویس در بله
    let fileId = null;
    let mimeType = null;

    if (update.message.photo) {
      const photo = update.message.photo[update.message.photo.length - 1]; // بالاترین کیفیت
      fileId = photo.file_id;
      mimeType = "image/jpeg";
    } else if (update.message.voice) {
      fileId = update.message.voice.file_id;
      mimeType = update.message.voice.mime_type || "audio/ogg";
    } else if (update.message.document) {
      fileId = update.message.document.file_id;
      mimeType = update.message.document.mime_type || "application/pdf";
    }

    // پردازش دستورات اصلی ربات
    if (text === "/start" || text === "/help") {
      const welcomeMsg =
        "سلام! من دستیار هوشمند شما هستم 🤖\n\n" +
        "🔹 /models ← انتخاب مدل هوش مصنوعی\n" +
        "🔹 /new ← پاک کردن حافظه گفتگو\n" +
        "🔹 /persona [نقش] ← تعیین شخصیت (مثال: /persona تو یک وکیل هستی)\n\n" +
        "🎙 *می‌توانید عکس، فایل (PDF) یا ویس بفرستید تا تحلیل کنم!*";
      sendBaleMessage(chatId, welcomeMsg);
      return HtmlService.createHtmlOutput("OK");
    }
    else if (text === "/models") {
      sendModelSelectionMenu(chatId);
      return HtmlService.createHtmlOutput("OK");
    }
    else if (text === "/new" || text === "/reset") {
      clearHistory(chatId);
      sendBaleMessage(chatId, "🧹 حافظه گفتگو پاک شد. آماده برای مکالمه جدید!");
      return HtmlService.createHtmlOutput("OK");
    }
    else if (text.startsWith("/persona")) {
      const role = text.substring(8).trim();
      if (role === "") {
        setUserPersona(chatId, null);
        sendBaleMessage(chatId, "🎭 نقش ربات حذف شد و به حالت عادی برگشت.");
      } else {
        setUserPersona(chatId, role);
        sendBaleMessage(chatId, `🎭 نقش ربات تنظیم شد به:\n_"${role}"_`);
      }
      return HtmlService.createHtmlOutput("OK");
    }

    // پردازش فایل در صورت وجود
    let fileBase64 = null;
    if (fileId) {
      sendChatAction(chatId, "upload_document");
      fileBase64 = getBaleFileBase64(fileId);
      if (!text) text = "لطفاً این فایل را به دقت بررسی و تحلیل کن."; // متن پیش‌فرض
    } else {
      sendChatAction(chatId, "typing");
    }

    if (!text && !fileBase64) return HtmlService.createHtmlOutput("OK");

    const currentModel = getUserModel(chatId);
    
    // ارسال پیام زنده "در حال پردازش..."
    const processingMsg = UrlFetchApp.fetch(`https://tapi.bale.ai/bot${BALE_TOKEN}/sendMessage`, {
      method: "post", contentType: "application/json",
      payload: JSON.stringify({ chat_id: chatId, text: "⏳ _در حال تحلیل و تفکر..._", parse_mode: "Markdown" }),
      muteHttpExceptions: true
    });
    let processingMsgId = null;
    if (processingMsg.getResponseCode() === 200) {
      processingMsgId = JSON.parse(processingMsg.getContentText()).result.message_id;
    }

    // درخواست به هوش مصنوعی جمنای
    const reply = askGemini(chatId, text, currentModel, fileBase64, mimeType);
    
    // حذف پیام "در حال پردازش..."
    if (processingMsgId) {
      UrlFetchApp.fetch(`https://tapi.bale.ai/bot${BALE_TOKEN}/deleteMessage`, {
        method: "post", contentType: "application/json",
        payload: JSON.stringify({ chat_id: chatId, message_id: processingMsgId }),
        muteHttpExceptions: true
      });
    }

    // ارسال پاسخ نهایی
    sendLongBaleMessage(chatId, reply, messageId);

  } catch (err) {
    Logger.log("Error in doPost: " + err.toString());
  }

  return HtmlService.createHtmlOutput("OK");
}

// ==================== توابع جلوگیری از اجرای تکراری ====================
function isDuplicateUpdate(updateId) {
  if (updateId === undefined) return false;
  const cache = CacheService.getScriptCache();
  const key = "upd_" + updateId;
  if (cache.get(key)) return true;
  cache.put(key, "1", 600); // 10 دقیقه
  return false;
}

// ==================== مدیریت حافظه و Google Sheet ====================
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

// ==================== تنظیمات شخصی کاربر ====================
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

// ==================== دانلود فایل از سرور بله ====================
function getBaleFileBase64(fileId) {
  try {
    const getFileUrl = `https://tapi.bale.ai/bot${BALE_TOKEN}/getFile?file_id=${fileId}`;
    const fileRes = JSON.parse(UrlFetchApp.fetch(getFileUrl).getContentText());
    if (!fileRes.ok) return null;

    const filePath = fileRes.result.file_path;
    const downloadUrl = `https://tapi.bale.ai/file/bot${BALE_TOKEN}/${filePath}`;

    const response = UrlFetchApp.fetch(downloadUrl);
    const blob = response.getBlob();
    return Utilities.base64Encode(blob.getBytes());
  } catch (e) {
    Logger.log("Error downloading file: " + e.toString());
    return null;
  }
}

// ==================== موتور ارتباط با جمنای ====================
function askGemini(chatId, promptText, modelName, fileBase64 = null, mimeType = null) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

  const contents = getHistory(chatId);
  
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

  // تزریق زمان زنده و دستورات شخصیتی
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

// ==================== ارسال پیام در بله با فرمت تمیز ====================
function formatBaleMarkdown(text) {
  if (!text) return "";
  // بله از Markdown پایه پشتیبانی می‌کند. تبدیل ** به * برای جلوگیری از بهم ریختگی متن‌های بولد جمنای
  text = text.replace(/\*\*(.*?)\*\*/g, '*$1*'); 
  return text;
}

function sendBaleMessage(chatId, text, replyMarkup = null, replyToId = null) {
  const url = `https://tapi.bale.ai/bot${BALE_TOKEN}/sendMessage`;
  const formattedText = formatBaleMarkdown(text);

  const payload = {
    chat_id: chatId,
    text: formattedText,
    parse_mode: "Markdown"
  };

  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (replyToId) payload.reply_to_message_id = replyToId;

  const response = UrlFetchApp.fetch(url, {
    method: "post", contentType: "application/json",
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });

  // اگر پارس کردن مارک‌داون در بله به خطا خورد (مثلاً کد بلاک‌های پیچیده)، متن را به صورت ساده ارسال می‌کنیم
  if (response.getResponseCode() !== 200) {
    delete payload.parse_mode;
    payload.text = text; 
    UrlFetchApp.fetch(url, {
      method: "post", contentType: "application/json",
      payload: JSON.stringify(payload), muteHttpExceptions: true
    });
  }
}

function sendLongBaleMessage(chatId, text, replyToId = null) {
  const MAX_LENGTH = 4000;
  if (!text) return;
  for (let i = 0; i < text.length; i += MAX_LENGTH) {
    const chunk = text.substring(i, i + MAX_LENGTH);
    sendBaleMessage(chatId, chunk, null, i === 0 ? replyToId : null);
  }
}

function sendChatAction(chatId, action) {
  const url = `https://tapi.bale.ai/bot${BALE_TOKEN}/sendChatAction`;
  UrlFetchApp.fetch(url, {
    method: "post", contentType: "application/json",
    payload: JSON.stringify({ chat_id: chatId, action: action }), muteHttpExceptions: true
  });
}

// ==================== مدیریت منوی انتخاب مدل ====================
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
  sendBaleMessage(chatId, "⚡️ لیست مدل‌های فعال برای شما:", keyboard);
}

function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  if (data.startsWith("set_model:")) {
    const selectedModel = data.substring("set_model:".length);
    setUserModel(chatId, selectedModel);
    
    UrlFetchApp.fetch(`https://tapi.bale.ai/bot${BALE_TOKEN}/answerCallbackQuery`, {
      method: "post", contentType: "application/json",
      payload: JSON.stringify({ callback_query_id: callbackQuery.id, text: "مدل با موفقیت تنظیم شد!" }),
      muteHttpExceptions: true
    });
    
    sendBaleMessage(chatId, `✅ مدل فعال شما با موفقیت تغییر کرد به:\n\`${selectedModel}\``);
  }
}

// ==================== تنظیم وب‌هوک ====================
// فقط در صورت تغییر آدرس Web App یا توکن، این تابع را به صورت دستی از بالا اجرا کنید
function setWebhook() {
  const WEBHOOK_URL = "https://script.google.com/macros/s/YOUR_UNIQUE_ID/exec"; // لینک وب اپلیکیشن خود را اینجا قرار دهید

  const url = `https://tapi.bale.ai/bot${BALE_TOKEN}/setWebhook?url=${encodeURIComponent(WEBHOOK_URL)}`;
  const response = UrlFetchApp.fetch(url);
  Logger.log(response.getContentText());
}