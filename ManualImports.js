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

        let parser = pickManualParserByFilename_(filename);

        let text = null;
        if (!parser) {
          text = extractPdfText_(file);
          if (!text) continue;
          parser = pickManualParserByContent_(text);
        }

        if (!parser) continue;

        if (!text) {
          text = extractPdfText_(file);
          if (!text) continue;
        }

        const parsed = parser.parse(text);
        if (!parsed || !parsed.datePaid) continue;

        const date = parsed.datePaid;
        const year = Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy");
        const month = Utilities.formatDate(date, Session.getScriptTimeZone(), "MM");

        const amountEur = convertToEur_(parsed.amount ?? null, parsed.currency ?? null, date);

        sheet.appendRow([
          date,                       // Date
          Number(year),               // Year
          month,                      // Month
          parsed.vendor,              // Vendor
          parsed.description,         // Description
          parsed.amount ?? "",        // Amount
          parsed.currency ?? "",      // Currency
          amountEur ?? "",            // Amount EUR
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