/**
 * Freelance Expenses Importer (Gmail -> Drive -> Sheets)
 *
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
  Logger.log("[import] Query: " + query);
  Logger.log("[import] Threads found: " + threads.length);
  let rowsAppended = 0;
  let filesSaved = 0;

  for (const thread of threads) {
    const messages = thread.getMessages();
    let importedAnything = false;

    for (const msg of messages) {
      const from = msg.getFrom();
      const subject = msg.getSubject();

      // Generic extractors (scored; NOT first-match)
      const date = extractChargeDate_(msg) || msg.getDate();
      const money = extractAmountCurrency_(msg); // {amount, currency} or null
      const period = extractPeriod_(msg); // {start, end} or null

      const year = Utilities.formatDate(
        date,
        Session.getScriptTimeZone(),
        "yyyy",
      );
      const month = Utilities.formatDate(
        date,
        Session.getScriptTimeZone(),
        "MM",
      );

      const attachments = msg.getAttachments({ includeInlineImages: false });
      const chosen = chooseBestReceiptAttachment(attachments);
      if (!chosen) {
        Logger.log("[import] No attachment selected for: " + subject);
        continue;
      }

      // Vendor/category via Rules tab (fallbacks)
      const baseText = `${from} ${subject}`;
      const ruleHit = applyRules_(rules, baseText);

      const vendor = ruleHit?.vendor || inferVendor(from, subject);
      const category =
        ruleHit?.category || inferCategoryFallback_(vendor, subject);

      const periodStart = period?.start || date;
      const periodEnd = period?.end || "";

      const folder = getOrCreateYearMonthFolder_(year, month);
      const filename = buildFilename(date, vendor, subject, chosen.getName());
      const savedFile = folder.createFile(chosen.copyBlob()).setName(filename);
      filesSaved++;

      const amountEur = convertToEur_(
        money?.amount ?? null,
        money?.currency ?? null,
        date,
      );

      sheet.appendRow([
        date, // Date
        Number(year), // Year
        month, // Month
        vendor, // Vendor
        subject, // Description
        money?.amount ?? "", // Amount
        money?.currency ?? "", // Currency
        amountEur ?? "", // Amount EUR
        category ?? "", // Category
        periodStart, // Period Start
        periodEnd, // Period End
        "gmail", // Source
        savedFile.getUrl(), // Drive URL
        new Date(), // Processed At
        `From: ${from}`, // Notes
      ]);
      rowsAppended++;
      Logger.log(
        `[import] Added row for "${subject}" | amount=${money?.amount ?? ""} ${money?.currency ?? ""} | file=${savedFile.getName()}`,
      );

      importedAnything = true;
    }

    if (importedAnything) {
      thread.addLabel(processedLabel);
      Logger.log("[import] Marked thread as processed.");
    }
  }

  Logger.log(
    `[import] Done. Rows appended: ${rowsAppended}. Files saved: ${filesSaved}.`,
  );

  if (rowsAppended > 0) refreshOverview();
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
  if (v.includes("github") || s.includes("github")) return "Dev Tools";
  if (v.includes("torguard") || s.includes("torguard")) return "Dev Tools";
  if (v.includes("ionos") || s.includes("ionos")) return "Domain";
  if (
    v.includes("anthropic") ||
    s.includes("anthropic") ||
    s.includes("claude")
  )
    return "AI Tools";
  if (v.includes("1password") || s.includes("1password")) return "Security";

  return "Software";
}

/* -----------------------------
   Filename helper
------------------------------ */

function buildFilename(date, vendor, subject, originalName) {
  const d = Utilities.formatDate(
    date,
    Session.getScriptTimeZone(),
    "yyyy-MM-dd",
  );
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
    { ocr: true }, // auto-detect language
  );

  const text = DocumentApp.openById(doc.id).getBody().getText();
  DriveApp.getFileById(doc.id).setTrashed(true);

  return text;
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
