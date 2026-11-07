// ==================== تنظیمات اولیه ====================
// تمام کلیدها در Script Properties ذخیره می‌شوند، نه داخل کد.
const PROPS_BALE = PropertiesService.getScriptProperties();
const BALE_TOKEN = PROPS_BALE.getProperty("BALE_TOKEN");
const GEMINI_API_KEY_BALE = PROPS_BALE.getProperty("GEMINI_API_KEY");
const SHEET_ID_BALE = PROPS_BALE.getProperty("SHEET_ID");

const DEFAULT_MODEL_BALE = "gemini-3.5-flash-lite"; // برای دیدن مدل‌های فعال کلید خود از logModelsBale() استفاده کنید
const MAX_HISTORY_BALE = 20;       // حداکثر پیام‌های ارسالی به مدل (۱۰ رفت‌وبرگشت)
const READ_LAST_ROWS_BALE = 300;   // خواندن فقط N ردیف آخر از شیت برای عملکرد بهتر (سرعت بالاتر)
const KEEP_ROWS_BALE = 2000;       // تابع cleanupOldRowsBale() فقط این تعداد از ردیف‌های آخر را نگه می‌دارد
const SHEET_NAME_BALE = "history_bale";

// ==================== ذخیره کلیدها (فقط یک‌بار اجرا کنید، سپس مقادیر را حذف یا کامنت کنید) ====================
function setSecretsBale() {
  PROPS_BALE.setProperties({
    BALE_TOKEN: "YOUR_BALE_BOT_TOKEN",
    GEMINI_API_KEY: "YOUR_GEMINI_API_KEY",
    SHEET_ID: "YOUR_GOOGLE_SHEET_ID"
  });
  Logger.log("ذخیره شد. حالا می‌توانید مقادیر را از کد پاک یا کامنت کنید.");
}

// ==================== دریافت درخواست‌های وب‌هوک ====================
function doPost(e) {
  try {
    const update = JSON.parse(e.postData.contents);

    // جلوگیری از پردازش آپدیت‌های تکراری
    if (isDuplicateUpdateBale(update.update_id)) {
      return HtmlService.createHtmlOutput("OK");
    }

    // پردازش کلیک روی دکمه‌های شیشه‌ای (انتخاب مدل)
    if (update.callback_query) {
      handleCallbackQueryBale(update.callback_query);
      return HtmlService.createHtmlOutput("OK");
    }

    // نادیده گرفتن آپدیت‌های بدون متن
    if (!update.message || !update.message.text) {
      return HtmlService.createHtmlOutput("OK");
    }

    const chatId = update.message.chat.id;
    const text = update.message.text.trim();
    const messageId = update.message.message_id;

    if (text === "/start" || text === "/help") {
      const welcomeMsg =
        "سلام! من یک ربات هوش مصنوعی متصل به جمنای هستم. من مکالمه ما را به خاطر می‌سپارم.\n\n" +
        "🔹 /models - مشاهده و انتخاب مدل‌ها\n" +
        "🔹 /new - پاک کردن حافظه و شروع یک گفتگوی جدید";
      sendBaleMessage(chatId, welcomeMsg);
    }
    else if (text === "/models") {
      sendModelSelectionMenuBale(chatId);
    }
    else if (text === "/new" || text === "/reset") {
      clearHistoryBale(chatId);
      sendBaleMessage(chatId, "🧹 حافظه گفتگو پاک شد. در حال شروع مکالمه جدید.");
    }
    else {
      const currentModel = getUserModelBale(chatId);
      sendChatActionBale(chatId, "typing");

      const reply = askGeminiBale(chatId, text, currentModel);
      sendLongBaleMessage(chatId, reply, messageId);
    }
  } catch (err) {
    Logger.log("Error in doPost: " + err.toString());
  }

  return HtmlService.createHtmlOutput("OK");
}

// ==================== جلوگیری از آپدیت‌های تکراری ====================
function isDuplicateUpdateBale(updateId) {
  if (updateId === undefined) return false;
  const cache = CacheService.getScriptCache();
  const key = "upd_bale_" + updateId;
  if (cache.get(key)) return true;
  cache.put(key, "1", 600); // کش برای ۱۰ دقیقه
  return false;
}

// ==================== تاریخچه گفتگو در گوگل شیت ====================
function getSheetBale() {
  const ss = SpreadsheetApp.openById(SHEET_ID_BALE);
  let sh = ss.getSheetByName(SHEET_NAME_BALE);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME_BALE);
    sh.appendRow(["chatId", "role", "text", "time"]);
    sh.getRange("A:C").setNumberFormat("@"); // اجبار به فرمت متن ساده برای جلوگیری از تبدیل خودکار به فرمول یا عدد
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
      if (r[1] === "reset") { history = []; return; } // نشانگر دستور /new
      if (r[1] !== "user" && r[1] !== "model") return;
      history.push({ role: r[1], parts: [{ text: String(r[2]) }] });
    });

    history = history.slice(-MAX_HISTORY_BALE);
    // اطمینان از اینکه اولین پیام همیشه از طرف کاربر است
    while (history.length && history[0].role !== "user") history.shift();
    return history;
  } catch (e) {
    Logger.log("getHistoryBale error: " + e.toString());
    return [];
  }
}

function appendHistoryBale(chatId, role, text) {
  // گوگل شیت محدودیت ۵۰,۰۰۰ کاراکتر در هر سلول دارد
  const safeText = String(text).substring(0, 49000);
  getSheetBale().appendRow([String(chatId), role, safeText, new Date()]);
}

function clearHistoryBale(chatId) {
  try {
    appendHistoryBale(chatId, "reset", ""); // پیام‌های قبل از این نشانگر نادیده گرفته می‌شوند
  } catch (e) {
    Logger.log("clearHistoryBale error: " + e.toString());
  }
}

// ==================== دریافت مدل‌های در دسترس از API جمنای ====================
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

// ==================== ارتباط با API جمنای (همراه با تاریخچه) ====================
function askGeminiBale(chatId, promptText, modelName) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY_BALE}`;

  // تاریخچه قبلی + پیام جدید
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

      // فقط پاسخ‌های موفق در تاریخچه ذخیره شوند
      try {
        appendHistoryBale(chatId, "user", promptText);
        appendHistoryBale(chatId, "model", reply);
      } catch (e) {
        Logger.log("append error: " + e.toString());
      }

      return reply;
    } else if (json.error) {
      return "خطای API جمنای: " + json.error.message;
    } else {
      return "پاسخی از مدل دریافت نشد.";
    }
  } catch (error) {
    return "خطا در ارتباط با سرور: " + error.toString();
  }
}

// ==================== مدیریت مدل انتخاب‌شده کاربر (دائمی) ====================
function getUserModelBale(chatId) {
  return PROPS_BALE.getProperty("model_bale_" + chatId) || DEFAULT_MODEL_BALE;
}

function setUserModelBale(chatId, modelName) {
  PROPS_BALE.setProperty("model_bale_" + chatId, modelName);
}

// ==================== ارسال پیام‌های طولانی (تقسیم در صورت بیشتر بودن از 4000 کاراکتر) ====================
function sendLongBaleMessage(chatId, text, replyToId = null) {
  const MAX_LENGTH = 4000;
  if (!text) return;

  for (let i = 0; i < text.length; i += MAX_LENGTH) {
    const chunk = text.substring(i, i + MAX_LENGTH);
    // فقط برای بخش اول به پیام اصلی ریپلای زده شود
    sendBaleMessage(chatId, chunk, null, i === 0 ? replyToId : null);
  }
}

// ==================== توابع اصلی API بله ====================
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

  // اگر پارس کردن مارک‌داون شکست خورد، بدون فرمت دوباره ارسال کن
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

// ==================== ساخت منوی زنده انتخاب مدل ====================
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
    "⚡️ لیست زنده مدل‌های فعال برای کلید شما (برای تغییر مدل روی آن کلیک کنید):",
    keyboard
  );
}

// ==================== پردازش کلیک روی دکمه‌های انتخاب مدل ====================
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
        text: "مدل با موفقیت تنظیم شد!"
      }),
      muteHttpExceptions: true
    });

    sendBaleMessage(chatId, `✅ مدل فعال شما با موفقیت تغییر کرد به:\n\`${selectedModel}\``);
  }
}

// ==================== تنظیم وب‌هوک (فقط یک‌بار اجرا شود) ====================
function setWebhookBale() {
  const WEBHOOK_URL = "YOUR_WEB_APP_URL_HERE (حتماً باید با /exec تمام شود)";

  const url = `https://tapi.bale.ai/bot${BALE_TOKEN}/setWebhook?url=${encodeURIComponent(WEBHOOK_URL)}`;
  const response = UrlFetchApp.fetch(url);
  Logger.log(response.getContentText());
}

// ==================== ابزارهای کمکی (از داخل ادیتور اجرا شوند) ====================

// مشاهده لیست مدل‌ها در لاگ‌ها
function logModelsBale() {
  const models = getAvailableModelsBale();
  Logger.log("Number of models: " + models.length);
  models.forEach((name, i) => Logger.log((i + 1) + ". " + name));
}

// مشاهده پاسخ خام API در صورت خالی بودن لیست مدل‌ها
function logModelsRawBale() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY_BALE}&pageSize=100`;
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log("Response code: " + response.getResponseCode());
  Logger.log(response.getContentText().substring(0, 1500));
}

// مشاهده تاریخچه‌ای که به مدل ارسال می‌شود
function debugHistoryBale() {
  const chatId = "YOUR_BALE_CHAT_ID";
  Logger.log(JSON.stringify(getHistoryBale(chatId), null, 2));
}

// بررسی میزان مصرف حافظه
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

// پاک‌سازی ردیف‌های قدیمی (دستی اجرا کنید یا تریگر هفتگی بسازید)
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