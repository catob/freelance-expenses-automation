# Freelance Expenses Automation

Google Apps Script that automatically imports receipts from Gmail into Google Drive and a Google Sheet expense tracker.

## What it does

- Watches a Gmail label (`Receipts/Auto`) for emails with attachments
- Picks the best attachment (prefers PDFs named "receipt" over "invoice")
- Extracts date, amount, currency, and billing period from the email body
- Saves the PDF to Google Drive under `Expenses/<YYYY>/<MM>/`
- Appends a row to a Google Sheet with all the extracted data
- Marks the thread as processed to avoid duplicates

Also supports importing PDFs that you manually save to Drive (via `importManualPdfReceipts()`), with vendor-specific parsers for Cursor, OpenAI, Anthropic, and Getsafe.

## Setup

### 1. Prerequisites

- [Node.js](https://nodejs.org/) and [clasp](https://github.com/google/clasp): `npm install -g @google/clasp`
- A Google account with Gmail, Drive, and Sheets access

### 2. Create the Google Sheet

Create a new Google Sheet with two tabs:

**Expenses** tab — add this header row:
```
Date | Year | Month | Vendor | Description | Amount | Currency | Category | Period Start | Period End | Source | Drive URL | Processed At | Notes
```

**Rules** tab — add this header row (optional, for custom vendor matching):
```
Match | Vendor | Category
```
Each row maps a substring (matched against sender + subject) to a vendor name and category.

### 3. Create the Drive folder

Create a folder in Google Drive called `Expenses`. Copy its ID from the URL:
`https://drive.google.com/drive/folders/<YOUR_FOLDER_ID>`

### 4. Create the Apps Script project

In your Google Sheet, go to **Extensions → Apps Script**. This creates a bound script. Note the Script ID from the URL.

Enable the **Drive API** under Services (click `+` next to Services, find Drive API v3).

### 5. Configure and deploy

```bash
# Clone this repo and log in to clasp
git clone <this-repo>
clasp login

# Copy the example files and fill in your values
cp Config.example.js Config.js
cp .clasp.example.json .clasp.json
```

Edit `Config.js` and set your Drive folder ID:
```js
EXPENSES_ROOT_FOLDER_ID: "YOUR_FOLDER_ID_HERE",
```

Edit `.clasp.json` and set your Apps Script project's script ID (from the editor URL).

Both files are gitignored so your private IDs stay local.

```bash
clasp push
```

### 6. Create the Gmail label

In Gmail, create a label named `Receipts/Auto`. Apply it to incoming receipt/invoice emails (manually, or via a Gmail filter).

### 7. Run it

In the Apps Script editor, run `importGmailReceipts()`. Authorize the permissions when prompted. Check the Logs (`View → Logs`) to confirm it worked.

To run on a schedule, add a time-based trigger: **Triggers → Add Trigger → `importGmailReceipts` → Time-driven → e.g. every hour**.

## Adding a custom PDF parser

Add an entry to `MANUAL_PDF_PARSERS` in `Parsers.js`. For Stripe-style receipts (Date paid / Amount paid layout), use the built-in helper:

```js
{
  id: "MyVendorParser",
  matchesFilename: (name) => name.toLowerCase().includes("myvendor"),
  matchesContent: (text) => text.toLowerCase().includes("my vendor inc"),
  parse: (text) => parseStripeStyleReceiptPdf_(text, {
    vendor: "My Vendor",
    category: "Software",
    descPattern: /(My Product Pro)/i,
    defaultDescription: "My Vendor subscription",
  }),
},
```

For non-Stripe layouts, implement `parse(text)` directly — it should return:
```js
{ vendor, description, amount, currency, category, datePaid, periodStart, periodEnd }
```

## Deploying

```bash
clasp push    # Deploy local changes to Apps Script
clasp pull    # Pull remote changes to local
clasp open    # Open the Apps Script editor in browser
```
