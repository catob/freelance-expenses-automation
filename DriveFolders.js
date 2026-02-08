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