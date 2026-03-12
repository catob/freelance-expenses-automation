// Copy this file to Config.js and fill in your values.
// Config.js is gitignored so your private IDs stay local.

const CONFIG = {
  // Gmail labels used to track processing state
  RECEIPTS_LABEL: "Receipts/Auto",
  PROCESSED_LABEL: "Receipts/Processed",

  // Google Sheet tab names
  SHEET_NAME: "Expenses",
  RULES_SHEET_NAME: "Rules",

  // Google Drive folder ID for the root "Expenses/" folder.
  // Find it in the URL when you open the folder: drive.google.com/drive/folders/<ID>
  EXPENSES_ROOT_FOLDER_ID: "PASTE_YOUR_DRIVE_FOLDER_ID_HERE",

  // Attachments smaller than this are ignored (avoids tiny inline images)
  MIN_ATTACHMENT_BYTES: 10 * 1024,
};
