/**
 * Freelance Expenses Importer (Gmail -> Drive -> Sheets)
 *
 * - Watches Gmail label Receipts/Auto
 * - Saves the "best" attachment (prefers Receipt over Invoice, prefers PDFs)
 * - Appends a row to the Expenses sheet
 * - Marks the thread with Receipts/Processed to avoid duplicates
 *
 * Drive structure (auto-created):
 *   Expenses/<YYYY>/<MM>/
 *
 * Sheet tabs:
 * - Expenses (main)
 * - Rules (Match | Vendor | Category)
 */

const CONFIG = {
  RECEIPTS_LABEL: "Receipts/Auto",
  PROCESSED_LABEL: "Receipts/Processed",
  SHEET_NAME: "Expenses",
  RULES_SHEET_NAME: "Rules",
  EXPENSES_ROOT_FOLDER_ID: "PASTE_YOUR_DRIVE_FOLDER_ID_HERE",
  MIN_ATTACHMENT_BYTES: 10 * 1024,
};

/**
 * Manual PDF parser registry.
 * Add new parsers here without touching the importer loop.
 */
const MANUAL_PDF_PARSERS = [
  {
    id: "CursorParser",
    matchesFilename: (name) => {
      const n = (name || "").toLowerCase();
      return n.includes("cursor") || n.includes("anysphere");
    },
    matchesContent: (text) => {
      const t = (text || "").toLowerCase();
      return t.includes("cursor pro") || t.includes("anysphere") || t.includes("date paid");
    },
    parse: (text) => parseCursorPdf_(text),
  },
  {
    id: "GetsafeParser",
    matchesFilename: (name) => {
      const n = (name || "").toLowerCase();
      return n.includes("getsafe") || n.includes("haftpflicht") || n.includes("hausrat") || n.includes("insurance");
    },
    matchesContent: (text) => {
      const t = (text || "").toLowerCase();
      return (
        t.includes("getsafe") &&
        (t.includes("leistungszeitraum") || t.includes("einzugsdatum") || t.includes("zahlbetrag") || t.includes("rechnung"))
      );
    },
    parse: (text) => parseGetsafePdf_(text),
  },
];

function importGmailReceipts() {
  const processedLabel =
    GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL) ||
    GmailApp.createLabel(CONFIG.PROCESSED_LABEL);

  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error(`Missing sheet tab: ${CONFIG.SHEET_NAME}`);

  const rules = loadRules_(ss.getSheetByName(CONFIG.RULES_SHEET_NAME));

  const query = `label:"${CONFIG.RECEIPTS_LABEL}" -label:"${CONFIG.PROCESSED_LABEL}" has:attachment`;
  const threads = GmailApp.search(query);

  for (const thread of threads) {
    const messages = thread.getMessages();
    let importedAnything = false;

    for (const msg of messages) {
      const from = msg.getFrom();
      const subject = msg.getSubject();

      const date = extractChargeDate_(msg) || msg.getDate();
      const money = extractAmountCurrency_(msg);
      const period = extractPeriod_(msg); // { start, end } or null

      const year = Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy");
      const month = Utilities.formatDate(date, Session.getScriptTimeZone(), "MM");

      const attachments = msg.getAttachments({ includeInlineImages: false });
      const chosen = chooseBestReceiptAttachment(attachments);
      if (!chosen) continue;

      const baseText = `${from} ${subject}`;
      const ruleHit = applyRules_(rules, baseText);

      const vendor = ruleHit?.vendor || inferVendor(from, subject);
      const category = ruleHit?.category || inferCategoryFallback_(vendor, subject);

      const periodStart = period?.start || date;
      const periodEnd = period?.end || "";

      const folder = getOrCreateYearMonthFolder_(year, month);

      const filename = buildFilename(date, vendor, subject, chosen.getName());
      const savedFile = folder.createFile(chosen.copyBlob()).setName(filename);

      sheet.appendRow([
        date,                    // Date
        Number(year),            // Year
        month,                   // Month
        vendor,                  // Vendor
        subject,                 // Description
        money?.amount ?? "",     // Amount
        money?.currency ?? "",   // Currency
        category ?? "",          // Category
        periodStart,             // Period Start
        periodEnd,               // Period End
        "gmail",                 // Source
        savedFile.getUrl(),      // Drive URL
        new Date(),              // Processed At
        `From: ${from}`,         // Notes
      ]);

      importedAnything = true;
    }

    if (importedAnything) {
      thread.addLabel(processedLabel);
    }
  }
}

/**
 * Manual PDF importer (pluggable)
 * - scans Expenses/<YYYY>/<MM> folders
 * - for each PDF not already in sheet: picks parser by filename; if unclear, OCR + pick by content
 * - appends row to sheet
 */
function importManualPdfReceipts() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error("Missing Expenses sheet");

  const existingFileIds = getExistingDriveFileIds_(sheet);

  const root = DriveApp.getFolderById(CONFIG.EXPENSES_ROOT_FOLDER_ID);
  const yearFolders = root.getFolders();

  while (yearFolders.hasNext()) {
    const yearFolder = yearFolders.next();
    if (!/^\d{4}$/.test(yearFolder.getName())) continue;

    const monthFolders = yearFolder.getFolders();
    while (monthFolders.hasNext()) {
      const monthFolder = monthFolders.next();
      if (!/^\d{2}$/.test(monthFolder.getName())) continue;

      const files = monthFolder.getFiles();
      while (files.hasNext()) {
        const file = files.next();

        if (!isPdfFile_(file)) continue;
        if (existingFileIds.has(file.getId())) continue;

        const filename = file.getName();

        // 1) Try filename-based parser selection (no OCR)
        let parser = pickManualParserByFilename_(filename);

        // 2) If unknown, OCR once and try content-based selection
        let text = null;
        if (!parser) {
          text = extractPdfText_(file);
          if (!text) continue;
          parser = pickManualParserByContent_(text);
        }

        if (!parser) continue;

        // Parser needs text; OCR once total
        if (!text) {
          text = extractPdfText_(file);
          if (!text) continue;
        }

        const parsed = parser.parse(text);
        if (!parsed || !parsed.datePaid) continue;

        const date = parsed.datePaid;
        const year = Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy");
        const month = Utilities.formatDate(date, Session.getScriptTimeZone(), "MM");

        sheet.appendRow([
          date,                       // Date
          Number(year),               // Year
          month,                      // Month
          parsed.vendor,              // Vendor
          parsed.description,         // Description
          parsed.amount ?? "",        // Amount
          parsed.currency ?? "",      // Currency
          parsed.category ?? "",      // Category
          parsed.periodStart ?? date, // Period Start
          parsed.periodEnd ?? "",     // Period End
          "manual",                   // Source
          file.getUrl(),              // Drive URL
          new Date(),                 // Processed At
          `Imported by ${parser.id}`, // Notes
        ]);

        existingFileIds.add(file.getId());
      }
    }
  }
}

function pickManualParserByFilename_(filename) {
  for (const p of MANUAL_PDF_PARSERS) {
    if (p.matchesFilename && p.matchesFilename(filename)) return p;
  }
  return null;
}

function pickManualParserByContent_(text) {
  for (const p of MANUAL_PDF_PARSERS) {
    if (p.matchesContent && p.matchesContent(text)) return p;
  }
  return null;
}

/* -----------------------------
   Rules tab helpers
------------------------------ */

function loadRules_(rulesSheet) {
  if (!rulesSheet) return [];

  const values = rulesSheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const header = values[0].map(String);
  const idxMatch = header.indexOf("Match");
  const idxVendor = header.indexOf("Vendor");
  const idxCategory = header.indexOf("Category");

  if (idxMatch === -1 || idxVendor === -1 || idxCategory === -1) {
    throw new Error(`Rules sheet must have headers: Match | Vendor | Category`);
  }

  const rules = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const match = (row[idxMatch] || "").toString().trim();
    const vendor = (row[idxVendor] || "").toString().trim();
    const category = (row[idxCategory] || "").toString().trim();

    if (!match) continue;

    rules.push({
      match: match.toLowerCase(),
      vendor,
      category,
    });
  }

  return rules;
}

function applyRules_(rules, text) {
  if (!rules || rules.length === 0) return null;
  const hay = (text || "").toLowerCase();

  for (const r of rules) {
    if (hay.includes(r.match)) {
      return { vendor: r.vendor, category: r.category };
    }
  }
  return null;
}

/* -----------------------------
   Attachment selection
------------------------------ */

function chooseBestReceiptAttachment(atts) {
  if (!atts || atts.length === 0) return null;

  const usable = atts.filter(att => {
    try {
      const size = att.getBytes().length;
      return size >= CONFIG.MIN_ATTACHMENT_BYTES;
    } catch (e) {
      return true;
    }
  });

  const candidates = usable.length ? usable : atts;

  const pdfs = candidates.filter(isPdf_);
  const pool = pdfs.length ? pdfs : candidates;

  const receiptByName = pool.find(att =>
    (att.getName() || "").toLowerCase().includes("receipt")
  );
  if (receiptByName) return receiptByName;

  const notInvoice = pool.find(att =>
    !(att.getName() || "").toLowerCase().includes("invoice")
  );
  if (notInvoice) return notInvoice;

  return pool
    .slice()
    .sort((a, b) => safeSize_(b) - safeSize_(a))[0];
}

function isPdf_(att) {
  const name = (att.getName() || "").toLowerCase();
  const ct = (att.getContentType() || "").toLowerCase();
  return name.endsWith(".pdf") || ct.includes("pdf");
}

function safeSize_(att) {
  try {
    return att.getBytes().length || 0;
  } catch (e) {
    return 0;
  }
}

/* -----------------------------
   Stripe extraction (date + money)
------------------------------ */

function extractStripeChargeDate(msg) {
  const body = msg.getPlainBody();

  const patterns = [
    /Date:\s*([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i,
    /Paid on\s*([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i,
  ];

  for (const p of patterns) {
    const m = body.match(p);
    if (m) {
      const parsed = new Date(m[1]);
      if (!isNaN(parsed)) return parsed;
    }
  }
  return null;
}

function extractStripeAmountCurrency(msg) {
  const body = msg.getPlainBody();

  const linesToTry = [
    /Amount paid:\s*([^\n]+)/i,
    /Total:\s*([^\n]+)/i,
    /Amount:\s*([^\n]+)/i,
    /You paid\s*([^\n]+)/i,
  ];

  let candidate = null;
  for (const re of linesToTry) {
    const m = body.match(re);
    if (m && m[1]) {
      candidate = m[1].trim();
      break;
    }
  }

  if (!candidate) {
    const m = body.match(/(EUR|USD|GBP|NOK|SEK|DKK|CHF)\s*([0-9][0-9.,]*)/i)
      || body.match(/([€$£])\s*([0-9][0-9.,]*)/);
    if (!m) return null;
    candidate = `${m[1]} ${m[2]}`.trim();
  }

  return parseMoney_(candidate);
}

function parseMoney_(text) {
  const t = (text || "").replace(/\u00A0/g, " ").trim();
  const upper = t.toUpperCase();

  let currency = "";
  if (upper.includes("EUR") || t.includes("€")) currency = "EUR";
  else if (upper.includes("USD") || t.includes("$")) currency = "USD";
  else if (upper.includes("GBP") || t.includes("£")) currency = "GBP";
  else if (upper.includes("NOK")) currency = "NOK";
  else if (upper.includes("SEK")) currency = "SEK";
  else if (upper.includes("DKK")) currency = "DKK";
  else if (upper.includes("CHF")) currency = "CHF";

  const numMatch = t.match(/([0-9][0-9.,]*)/);
  if (!numMatch) return null;

  let num = numMatch[1];

  if (num.includes(",") && num.includes(".")) num = num.replace(/,/g, "");
  else if (num.includes(",") && !num.includes(".")) num = num.replace(/,/g, ".");

  const amount = Number(num);
  if (Number.isNaN(amount)) return null;

  return { amount, currency };
}

/* -----------------------------
   Vendor/category inference fallbacks
------------------------------ */

function inferVendor(from, subject) {
  const display = (from.split("<")[0] || "").replace(/"|'/g, "").trim();
  if (display) return display;

  const m = (from || "").match(/@([a-z0-9.-]+)/i);
  if (m) return m[1];

  const subj = (subject || "").trim();
  return subj ? subj.split(" ")[0] : "Unknown";
}

function inferCategoryFallback_(vendor, subject) {
  const v = (vendor || "").toLowerCase();
  const s = (subject || "").toLowerCase();

  if (v.includes("fly") || s.includes("fly")) return "Hosting";
  if (v.includes("vercel") || s.includes("vercel")) return "Hosting";
  if (v.includes("figma") || s.includes("figma")) return "Design";
  if (v.includes("github") || s.includes("github")) return "Dev Tools";

  return "Software";
}

/* -----------------------------
   Drive folder routing (Expenses/<YYYY>/<MM>)
------------------------------ */

function getOrCreateYearMonthFolder_(year, month) {
  if (!CONFIG.EXPENSES_ROOT_FOLDER_ID || CONFIG.EXPENSES_ROOT_FOLDER_ID.includes("PASTE_")) {
    throw new Error("Set CONFIG.EXPENSES_ROOT_FOLDER_ID to your Drive 'Expenses' folder ID.");
  }

  const root = DriveApp.getFolderById(CONFIG.EXPENSES_ROOT_FOLDER_ID);
  const yearFolder = getOrCreateSubfolder_(root, String(year));
  const monthFolder = getOrCreateSubfolder_(yearFolder, String(month).padStart(2, "0"));
  return monthFolder;
}

function getOrCreateSubfolder_(parentFolder, name) {
  const it = parentFolder.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parentFolder.createFolder(name);
}

/* -----------------------------
   Filename helper
------------------------------ */

function buildFilename(date, vendor, subject, originalName) {
  const d = Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd");
  const base = `${d} - ${vendor} - ${subject} - ${originalName}`;
  return base
    .replace(/[\\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

/* -----------------------------
   PDF text extraction (Drive API v3)
   Requires: Apps Script -> Services -> Drive API enabled
------------------------------ */

function extractPdfText_(file) {
  const pdfBlob = file.getBlob();

  const doc = Drive.Files.create(
    { name: file.getName(), mimeType: MimeType.GOOGLE_DOCS },
    pdfBlob,
    { ocr: true } // auto-detect language
  );

  const text = DocumentApp.openById(doc.id).getBody().getText();
  DriveApp.getFileById(doc.id).setTrashed(true);

  return text;
}

/* -----------------------------
   Manual PDF parsers
------------------------------ */

function parseCursorPdf_(text) {
  const t = text.replace(/\s+/g, " ").trim();

  const dateMatch = t.match(/Date paid\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
  if (!dateMatch) return null;
  const datePaid = new Date(dateMatch[1]);

  const amountMatch = t.match(/\$([0-9]+\.[0-9]{2})\s+paid/i);
  if (!amountMatch) return null;
  const amount = Number(amountMatch[1]);

  const periodMatch = t.match(/([A-Za-z]{3}\s+\d{1,2})\s+–\s+([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/);
  let periodStart = datePaid;
  let periodEnd = "";

  if (periodMatch) {
    periodStart = new Date(`${periodMatch[1]}, ${datePaid.getFullYear()}`);
    periodEnd = new Date(periodMatch[2]);
  }

  return {
    vendor: "Cursor",
    description: "Cursor Pro subscription",
    amount,
    currency: "USD",
    category: "Dev Tools",
    datePaid,
    periodStart,
    periodEnd,
  };
}

function parseGetsafePdf_(text) {
  const t = text.replace(/\s+/g, " ").trim();

  // Product name
  const productMatch = t.match(/Rechnung\s+Getsafe\s+([A-Za-zÄÖÜäöüß]+)/i);
  const product = productMatch ? productMatch[1] : "Versicherung";

  // Find the table row that starts after "... Zahlbetrag"
  // Example row (OCR):
  // "... Einzugsdatum Leistungszeitraum ... Zahlbetrag 12.11.2025 12.11.2025 - 12.11.2026 ... 32,21€ 11,44€ 20,77€"
  const rowMatch = t.match(
    /Zahlbetrag\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4}).*?([0-9]+,[0-9]{2})€\s+([0-9]+,[0-9]{2})€\s+([0-9]+,[0-9]{2})€/i
  );

  if (!rowMatch) return null;

  const debitDateStr = rowMatch[1];
  const periodStartStr = rowMatch[2];
  const periodEndStr = rowMatch[3];

  // Last captured amount is Zahlbetrag (paid)
  const zahlbetragStr = rowMatch[6];

  const datePaid = parseGermanDate_(debitDateStr);
  const periodStart = parseGermanDate_(periodStartStr);
  const periodEnd = parseGermanDate_(periodEndStr);
  const amount = Number(zahlbetragStr.replace(",", "."));

  if (!datePaid || !periodStart || !periodEnd || Number.isNaN(amount)) return null;

  return {
    vendor: "Getsafe",
    description: `Getsafe ${product}`,
    amount,
    currency: "EUR",
    category: "Insurance",
    datePaid,
    periodStart,
    periodEnd,
  };
}

function parseGermanDate_(ddmmyyyy) {
  const m = ddmmyyyy.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return null;
  const d = new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00`);
  return isNaN(d) ? null : d;
}

/* -----------------------------
   Dedupe + file helpers
------------------------------ */

function getExistingDriveFileIds_(sheet) {
  const data = sheet.getDataRange().getValues();
  const header = data[0];
  const idx = header.indexOf("Drive URL");
  const ids = new Set();

  for (let i = 1; i < data.length; i++) {
    const url = data[i][idx];
    const id = extractDriveFileId_(url);
    if (id) ids.add(id);
  }
  return ids;
}

function extractDriveFileId_(url) {
  if (!url || typeof url !== "string") return null;

  let m = url.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];

  m = url.match(/\/d\/([a-zA-Z0-9_-]{10,})\//);
  if (m) return m[1];

  m = url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];

  return null;
}

function isPdfFile_(file) {
  const name = file.getName().toLowerCase();
  const mime = (file.getMimeType() || "").toLowerCase();
  return name.endsWith(".pdf") || mime.includes("pdf");
}

/* -----------------------------
   Gmail extractors (Stripe + GitHub)
------------------------------ */

function extractChargeDate_(msg) {
  return extractStripeChargeDate(msg) || extractGitHubChargeDate_(msg);
}

function extractAmountCurrency_(msg) {
  return extractStripeAmountCurrency(msg) || extractGitHubAmountCurrency_(msg);
}

function extractPeriod_(msg) {
  const body = msg.getPlainBody();
  const m = body.match(/([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})\s*[–-]\s*([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/);
  if (!m) return null;

  const start = new Date(m[1]);
  const end = new Date(m[2]);
  if (isNaN(start) || isNaN(end)) return null;

  return { start, end };
}

function extractGitHubChargeDate_(msg) {
  const body = msg.getPlainBody();
  const m = body.match(/Date\s+(\d{4}-\d{2}-\d{2})/i);
  if (!m) return null;

  const d = new Date(`${m[1]}T00:00:00`);
  return isNaN(d) ? null : d;
}

function extractGitHubAmountCurrency_(msg) {
  const body = msg.getPlainBody();
  const m = body.match(/Total\s+([$€£])\s*([0-9][0-9.,]*)\s*(USD|EUR|GBP|NOK|SEK|DKK|CHF)?/i);
  if (!m) return null;

  const symbol = m[1];
  let num = m[2];

  if (num.includes(",") && num.includes(".")) num = num.replace(/,/g, "");
  else if (num.includes(",") && !num.includes(".")) num = num.replace(/,/g, ".");

  const amount = Number(num);
  if (Number.isNaN(amount)) return null;

  let currency = (m[3] || "").toUpperCase();
  if (!currency) {
    if (symbol === "$") currency = "USD";
    if (symbol === "€") currency = "EUR";
    if (symbol === "£") currency = "GBP";
  }

  return { amount, currency };
}

function debugManualImportOneFile() {
  // Put ONE of the Getsafe PDF file IDs here (from Drive URL)
  const FILE_ID = "1J-EiFAZjJekxXEOGsMQJSOgXz-vzS7zd";

  const file = DriveApp.getFileById(FILE_ID);
  Logger.log("Filename: " + file.getName());

  const text = extractPdfText_(file);
  Logger.log("OCR text (first 800 chars): " + (text || "").slice(0, 800));

  const parsed = parseGetsafePdf_(text);
  Logger.log("Parsed: " + JSON.stringify(parsed));
}