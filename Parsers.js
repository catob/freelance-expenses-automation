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
      return (
        n.includes("getsafe") ||
        n.includes("haftpflicht") ||
        n.includes("hausrat") ||
        n.includes("insurance")
      );
    },
    matchesContent: (text) => {
      const t = (text || "").toLowerCase();
      return (
        t.includes("getsafe") &&
        (t.includes("leistungszeitraum") ||
          t.includes("einzugsdatum") ||
          t.includes("zahlbetrag") ||
          t.includes("rechnung"))
      );
    },
    parse: (text) => parseGetsafePdf_(text),
  },
];

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

  const productMatch = t.match(/Rechnung\s+Getsafe\s+([A-Za-zÄÖÜäöüß]+)/i);
  const product = productMatch ? productMatch[1] : "Versicherung";

  const rowMatch = t.match(
    /Zahlbetrag\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4}).*?([0-9]+,[0-9]{2})€\s+([0-9]+,[0-9]{2})€\s+([0-9]+,[0-9]{2})€/i
  );
  if (!rowMatch) return null;

  const debitDateStr = rowMatch[1];
  const periodStartStr = rowMatch[2];
  const periodEndStr = rowMatch[3];
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