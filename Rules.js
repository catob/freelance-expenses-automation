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