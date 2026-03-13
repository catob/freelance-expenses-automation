/**
 * Freelance Expense Overview
 * Uses the "Amount EUR" column for all totals — no currency splitting needed.
 *
 * Run buildOverview() manually to create or fully rebuild the sheet.
 * refreshOverview() is called automatically at the end of each import run.
 * The year dropdown in B2 shows/hides year blocks without rebuilding.
 */

const OVERVIEW_SHEET_NAME = "📊 Overview";

// Column indices in the Expenses sheet (1-based)
const OV_COL_YEAR       = 2;
const OV_COL_MONTH      = 3;
const OV_COL_AMOUNT_EUR = 8;
const OV_COL_CATEGORY   = 9;

const OV_COLORS = {
  headerBg:     "#1a1a2e",
  headerFg:     "#ffffff",
  subHeaderBg:  "#16213e",
  subHeaderFg:  "#e0e0e0",
  categoryBg:   "#f0f4ff",
  rowEven:      "#f8f9ff",
  rowOdd:       "#ffffff",
  totalBg:      "#fff3cd",
  grandTotalBg: "#ffd700",
  grandTotalFg: "#1a1a2e",
  border:       "#cccccc",
};

const OV_MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun",
                        "Jul","Aug","Sep","Oct","Nov","Dec"];

// ── MAIN ─────────────────────────────────────────────────────────────────────

function buildOverview() {
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!dataSheet) {
    SpreadsheetApp.getUi().alert(`Sheet "${CONFIG.SHEET_NAME}" not found.`);
    return;
  }

  const raw  = dataSheet.getDataRange().getValues();
  const rows = raw.slice(1).filter(r => r[OV_COL_YEAR-1] && r[OV_COL_AMOUNT_EUR-1]);

  const years      = [...new Set(rows.map(r => Number(r[OV_COL_YEAR-1])))].sort();
  const categories = [...new Set(rows.map(r => String(r[OV_COL_CATEGORY-1]).trim()))].sort();

  // pivot[year][category][month 0-11] = total EUR
  const pivot = {};
  years.forEach(y => {
    pivot[y] = {};
    categories.forEach(cat => { pivot[y][cat] = Array(12).fill(0); });
  });

  rows.forEach(r => {
    const year  = Number(r[OV_COL_YEAR-1]);
    const month = Number(r[OV_COL_MONTH-1]);
    const cat   = String(r[OV_COL_CATEGORY-1]).trim();
    const eur   = Number(r[OV_COL_AMOUNT_EUR-1]);
    if (pivot[year] && pivot[year][cat] && month >= 1 && month <= 12) {
      pivot[year][cat][month - 1] += eur;
    }
  });

  // Get or create overview sheet
  let sheet = ss.getSheetByName(OVERVIEW_SHEET_NAME);
  if (sheet) {
    sheet.clearContents();
    sheet.clearFormats();
    if (sheet.getMaxRows() > 1) sheet.showRows(1, sheet.getMaxRows());
  } else {
    sheet = ss.insertSheet(OVERVIEW_SHEET_NAME, 0);
  }

  // Title
  sheet.getRange("A1").setValue("📊 Freelance Expense Overview")
       .setFontSize(16).setFontWeight("bold").setFontColor(OV_COLORS.headerBg);

  // Year selector
  sheet.getRange("A2").setValue("Select Year:").setFontWeight("bold");
  const yearCell = sheet.getRange("B2");
  yearCell.setValue(years[years.length - 1])
          .setBackground("#fff9c4").setFontWeight("bold").setFontSize(12);
  yearCell.setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(years.map(String), true)
      .setAllowInvalid(false).build()
  );
  sheet.getRange("C2").setValue("← select year to filter")
       .setFontColor("#888888").setFontStyle("italic");

  // Write year tables
  const yearRowMap = {};
  let startRow = 4;

  years.forEach(year => {
    const blockStart = startRow;
    startRow = ovWriteYearTable_(sheet, year, categories, pivot[year], startRow);
    yearRowMap[year] = { start: blockStart, end: startRow - 1 };
    startRow += 2;
  });

  // Store yearRowMap in hidden cell P1 for the onEdit trigger
  sheet.getRange("P1").setValue(JSON.stringify(yearRowMap))
       .setFontColor("#ffffff").setFontSize(1);

  // Column widths
  sheet.setColumnWidth(1, 160);
  for (let c = 2; c <= 13; c++) sheet.setColumnWidth(c, 72);
  sheet.setColumnWidth(14, 90);
  sheet.setFrozenRows(3);

  // Show only the latest year initially
  ovApplyYearFilter_(sheet, years[years.length - 1], yearRowMap);

  ovInstallTrigger_(ss);
}

// Called at the end of each import run to keep the overview current.
function refreshOverview() {
  buildOverview();
}

// ── WRITE ONE YEAR BLOCK ──────────────────────────────────────────────────

function ovWriteYearTable_(sheet, year, categories, yearData, startRow) {
  const NUM_COLS = 14; // Category + 12 months + Total

  // Year banner
  sheet.getRange(startRow, 1, 1, NUM_COLS).merge()
       .setValue(`📅  ${year}`)
       .setBackground(OV_COLORS.headerBg).setFontColor(OV_COLORS.headerFg)
       .setFontSize(13).setFontWeight("bold").setHorizontalAlignment("center");
  startRow++;

  // Month headers
  const headers = ["Category", ...OV_MONTH_NAMES, "TOTAL"];
  sheet.getRange(startRow, 1, 1, NUM_COLS).setValues([headers])
       .setBackground(OV_COLORS.subHeaderBg).setFontColor(OV_COLORS.subHeaderFg)
       .setFontWeight("bold").setHorizontalAlignment("center");
  sheet.getRange(startRow, 1).setHorizontalAlignment("left");
  startRow++;

  // One row per category
  categories.forEach((cat, idx) => {
    const months   = yearData[cat];
    const rowTotal = months.reduce((a, b) => a + b, 0);
    const rowData  = [cat, ...months.map(v => v > 0 ? +v.toFixed(2) : ""), +rowTotal.toFixed(2)];

    const range = sheet.getRange(startRow, 1, 1, NUM_COLS);
    range.setValues([rowData])
         .setBackground(idx % 2 === 0 ? OV_COLORS.rowEven : OV_COLORS.rowOdd);

    sheet.getRange(startRow, 1).setFontWeight("bold").setBackground(OV_COLORS.categoryBg);
    sheet.getRange(startRow, NUM_COLS).setBackground(OV_COLORS.totalBg).setFontWeight("bold");
    sheet.getRange(startRow, 2, 1, NUM_COLS - 1).setNumberFormat("€#,##0.00");
    range.setBorder(null, null, true, null, null, null,
                    OV_COLORS.border, SpreadsheetApp.BorderStyle.SOLID);
    startRow++;
  });

  // Grand total row
  const grandMonths = Array(12).fill(0);
  categories.forEach(cat => yearData[cat].forEach((v, i) => { grandMonths[i] += v; }));
  const grandTotal = grandMonths.reduce((a, b) => a + b, 0);

  sheet.getRange(startRow, 1, 1, NUM_COLS)
       .setValues([["TOTAL", ...grandMonths.map(v => +v.toFixed(2)), +grandTotal.toFixed(2)]])
       .setBackground(OV_COLORS.grandTotalBg).setFontColor(OV_COLORS.grandTotalFg)
       .setFontWeight("bold");
  sheet.getRange(startRow, 2, 1, NUM_COLS - 1).setNumberFormat("€#,##0.00");

  return startRow + 1;
}

// ── YEAR FILTER ───────────────────────────────────────────────────────────

function ovApplyYearFilter_(sheet, selectedYear, yearRowMap) {
  const maxRows = sheet.getMaxRows();
  if (maxRows > 3) sheet.showRows(4, maxRows - 3);

  Object.entries(yearRowMap).forEach(([year, range]) => {
    if (String(year) !== String(selectedYear)) {
      const count = range.end - range.start + 1;
      if (count > 0) sheet.hideRows(range.start, count);
    }
  });
}

// ── TRIGGER ───────────────────────────────────────────────────────────────

function ovInstallTrigger_(ss) {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "onExpenseYearChange")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("onExpenseYearChange").forSpreadsheet(ss).onEdit().create();
}

// Installable onEdit trigger — handles the year dropdown only.
// (Rebuilding on every Expenses edit would be too slow.)
function onExpenseYearChange(e) {
  if (!e) return;
  const sheet = e.range.getSheet();
  if (sheet.getName() !== OVERVIEW_SHEET_NAME) return;
  if (e.range.getRow() !== 2 || e.range.getColumn() !== 2) return;

  let yearRowMap;
  try { yearRowMap = JSON.parse(sheet.getRange("P1").getValue()); }
  catch(err) { return; }

  ovApplyYearFilter_(sheet, String(e.value), yearRowMap);
}
