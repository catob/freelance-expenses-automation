# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Google Apps Script project that automates receipt/invoice processing for freelancers. It monitors Gmail, saves PDFs to Drive, extracts financial data, and populates a Google Sheet expense tracker.

## Deployment

This project uses [clasp](https://github.com/google/clasp) to sync with Google Apps Script:

```bash
clasp push   # Deploy local .js files to Google Apps Script
clasp pull   # Fetch remote changes
clasp open   # Open Apps Script editor in browser
```

No build step, no transpilation. Files are plain GAS-compatible JavaScript (V8 runtime).

## Testing & Debugging

There is no automated test suite. Testing is done by running functions in the Apps Script editor and checking logs (`View → Logs`).

Debug utilities are in `Debug.js`:
- `debugTestParsers()` — smoke-tests all PDF parsers with hardcoded sample text; run after any parser changes
- `debugGmailReceiptsScan()` — logs attachment selection stats for unprocessed threads
- `debugMoneyExtraction(vendor, limit)` — inspects amount/currency scoring for a specific vendor (e.g. `"fly.io"`)

## Architecture

### Data Flow

```
Gmail (label: "Receipts/Auto")
  → importGmailReceipts() in Code.js
    → extract date, amount, currency, period from email body (GmailExtractors.js)
    → pick best PDF attachment (chooseBestReceiptAttachment)
    → match vendor/category via Rules sheet (Rules.js)
    → save PDF to Drive, append row to Expenses sheet
    → mark thread with "Receipts/Processed" label

Drive (Expenses/<YYYY>/<MM>/ folders)
  → importManualPdfs() in ManualImports.js
    → for each PDF not yet in the sheet (deduped by Drive file ID)
      → try matching a parser by filename, then by OCR content
      → parse with matched parser → append row to Expenses sheet
```

### Key Files

| File | Role |
|---|---|
| `Code.js` | Main Gmail import loop |
| `GmailExtractors.js` | Date/amount/currency/period extraction from email text using scoring |
| `Parsers.js` | Registry of vendor-specific PDF parsers (`MANUAL_PDF_PARSERS`) |
| `Rules.js` | Loads `Match | Vendor | Category` rows from the Rules sheet tab |
| `ManualImports.js` | Manual PDF import from Drive folders |
| `Backfill.js` | Fills missing Year/Month/Vendor/Category cells retroactively |
| `DriveFolders.js` | Auto-creates `Expenses/<YYYY>/<MM>` folder structure |
| `Config.js` | All configuration constants (gitignored — copy from `Config.example.js`) |
| `Debug.js` | Debug/inspection utilities |

### Private Config Files (gitignored)

`Config.js` and `.clasp.json` are gitignored because they contain private IDs. Template versions are in `Config.example.js` and `.clasp.example.json`. `Config.example.js` and `.clasp.example.json` are excluded from clasp pushes via `.claspignore`.

### Google Sheet Structure

**Expenses tab columns:** Date | Year | Month | Vendor | Description | Amount | Currency | Category | Period Start | Period End | Source | Drive URL | Processed At | Notes

**Rules tab columns:** Match | Vendor | Category (substring matched against `sender + subject`)

### Adding a New PDF Parser

Add an entry to `MANUAL_PDF_PARSERS` in `Parsers.js`. Each parser object has:
- `id` — identifier string (shown in Notes column)
- `matchesFilename(filename)` — returns true if this parser handles the file
- `matchesContent(text)` — returns true if OCR text matches
- `parse(text)` — returns `{ vendor, description, amount, currency, category, datePaid, periodStart, periodEnd }`

For Stripe-style receipts (Date paid / Amount paid layout), use the shared `parseStripeStyleReceiptPdf_(text, opts)` helper instead of implementing from scratch — see `parseOpenAiReceiptPdf_` and `parseAnthropicReceiptPdf_` as examples.

### Extraction Design

- **Scoring-based:** Date and amount extraction scores all candidates and picks the best match (not first-match), reducing brittleness.
- **Multilingual:** Handles English and German date formats, plus German currency symbols.
- **Currency inference chain:** symbol (`$€£`) → explicit currency code → caller-provided default hint.
- **Duplicate prevention:** Drive file IDs are stored in the sheet; ManualImports skips already-imported files.
- **State via Gmail labels:** Threads move from `Receipts/Auto` → `Receipts/Processed` after import.

### Configuration

All tunable values live in `Config.js`. The most important:
- `EXPENSES_ROOT_FOLDER_ID` — Drive folder ID for the `Expenses/` root
- `RECEIPTS_LABEL` / `PROCESSED_LABEL` — Gmail label names
- `SHEET_NAME` / `RULES_SHEET_NAME` — Sheet tab names
