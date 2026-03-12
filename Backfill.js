/**
 * Fills in the "Amount EUR" column for existing rows that have an amount and
 * currency but no EUR conversion yet. Fetches historical rates from Frankfurter.
 * Safe to re-run — skips rows that already have a value in "Amount EUR".
 */
function backfillEurAmounts() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error(`Missing sheet tab: ${CONFIG.SHEET_NAME}`);

  const range = sheet.getDataRange();
  const data = range.getValues();
  const header = data[0].map(String);

  const idx = (name) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`Missing column "${name}" in Expenses header`);
    return i;
  };

  const cDate = idx("Date");
  const cAmount = idx("Amount");
  const cCurrency = idx("Currency");
  const cAmountEur = idx("Amount EUR");

  let filled = 0;
  let skipped = 0;

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (row[cAmountEur] !== "" && row[cAmountEur] != null) { skipped++; continue; }

    const date = row[cDate];
    const amount = row[cAmount];
    const currency = row[cCurrency];
    if (!(date instanceof Date) || isNaN(date) || !amount || !currency) continue;

    const eur = convertToEur_(Number(amount), String(currency), date);
    if (eur != null) {
      data[r][cAmountEur] = eur;
      filled++;
    }
  }

  range.setValues(data);
  Logger.log(`[backfill EUR] Done. Filled: ${filled}, already had value: ${skipped}.`);
}

function backfillExistingRows() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error(`Missing sheet tab: ${CONFIG.SHEET_NAME}`);

  const rules = loadRules_(ss.getSheetByName(CONFIG.RULES_SHEET_NAME));

  const range = sheet.getDataRange();
  const data = range.getValues();
  const header = data[0].map(String);

  const idx = (name) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`Missing column "${name}" in Expenses header`);
    return i;
  };

  const cDate = idx("Date");
  const cYear = idx("Year");
  const cMonth = idx("Month");
  const cVendor = idx("Vendor");
  const cDesc = idx("Description");
  const cCurrency = idx("Currency");
  const cCategory = idx("Category");
  const cPeriodStart = idx("Period Start");
  const cPeriodEnd = idx("Period End");
  const cNotes = idx("Notes");

  const tz = Session.getScriptTimeZone();

  for (let r = 1; r < data.length; r++) {
    const row = data[r];

    const date = row[cDate];
    if (!(date instanceof Date) || isNaN(date)) continue;

    // Year/Month
    if (!row[cYear]) row[cYear] = Number(Utilities.formatDate(date, tz, "yyyy"));
    if (!row[cMonth]) row[cMonth] = Utilities.formatDate(date, tz, "MM");

    // Period Start default (you'll refine later)
    if (!row[cPeriodStart]) row[cPeriodStart] = date;
    // Period End stays as-is

    // Vendor/Category from rules, only if empty
    const baseText = `${row[cNotes] || ""} ${row[cDesc] || ""}`;
    const hit = applyRules_(rules, baseText);

    if (!row[cVendor] && hit?.vendor) row[cVendor] = hit.vendor;
    if (!row[cCategory] && hit?.category) row[cCategory] = hit.category;

    // If still missing category, use fallback
    if (!row[cCategory]) row[cCategory] = inferCategoryFallback_(row[cVendor], row[cDesc]);

    // Currency: don’t guess; leave empty if missing
    // (If you want PDF-based fill later, we can add a separate backfill.)
    if (row[cCurrency] === null) row[cCurrency] = "";
  }

  range.setValues(data);
}