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
      return (
        t.includes("cursor pro") ||
        t.includes("anysphere") ||
        t.includes("date paid")
      );
    },
    parse: (text) => parseCursorPdf_(text),
  },
  {
    id: "OpenAIParser",
    matchesFilename: (name) => {
      const n = (name || "").toLowerCase();
      return (
        n.includes("openai") ||
        n.includes("chatgpt") ||
        /^receipt-\d{4}-\d{4}/.test(n)
      );
    },
    matchesContent: (text) => {
      const t = (text || "").toLowerCase();
      return (
        (t.includes("openai ireland limited") || t.includes("ar@openai.com")) &&
        (t.includes("chatgpt plus") ||
          t.includes("amount paid") ||
          t.includes("date paid"))
      );
    },
    parse: (text) => parseOpenAiReceiptPdf_(text),
  },
  {
    id: "AnthropicParser",
    matchesFilename: (name) => {
      const n = (name || "").toLowerCase();
      return n.includes("anthropic") || n.includes("claude");
    },
    matchesContent: (text) => {
      const t = (text || "").toLowerCase();
      return (
        (t.includes("anthropic") || t.includes("support@anthropic.com")) &&
        (t.includes("claude") ||
          t.includes("amount paid") ||
          t.includes("date paid"))
      );
    },
    parse: (text) => parseAnthropicReceiptPdf_(text),
  },
  {
    id: "TorGuardParser",
    matchesFilename: (name) => {
      const n = (name || "").toLowerCase();
      return n.includes("torguard") || n.includes("vpnetworks");
    },
    matchesContent: (text) => {
      const t = (text || "").toLowerCase();
      return (
        t.includes("vpnetworks") ||
        t.includes("torguard") ||
        t.includes("anonymous vpn")
      );
    },
    parse: (text) => parseTorGuardPdf_(text),
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

  const periodMatch = t.match(
    /([A-Za-z]{3}\s+\d{1,2})\s+–\s+([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/,
  );
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
    /Zahlbetrag\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4}).*?([0-9]+,[0-9]{2})€\s+([0-9]+,[0-9]{2})€\s+([0-9]+,[0-9]{2})€/i,
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

  if (!datePaid || !periodStart || !periodEnd || Number.isNaN(amount))
    return null;

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

/**
 * Generic parser for Stripe-style receipts (used by OpenAI, Anthropic, and similar).
 * Looks for "Date paid", "Amount paid" / symbol+amount, and an optional billing period.
 *
 * @param {string} text - OCR'd PDF text
 * @param {{ vendor: string, category: string, descPattern: RegExp, defaultDescription: string }} opts
 */
function parseStripeStyleReceiptPdf_(
  text,
  { vendor, category, descPattern, defaultDescription },
) {
  const t = String(text || "")
    .replace(/\u0000/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  const dateMatch = t.match(/Date paid\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
  if (!dateMatch) return null;
  const datePaid = parseEnglishDateLocal_(dateMatch[1]);
  if (isNaN(datePaid)) return null;

  // Prefer explicit "Amount paid" field; fallback to "<money> paid on <date>".
  const amountMatch =
    t.match(/Amount paid\s*([€$£])\s*([0-9]+(?:[.,][0-9]{2})?)/i) ||
    t.match(
      /([€$£])\s*([0-9]+(?:[.,][0-9]{2})?)\s+paid on\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}/i,
    );
  if (!amountMatch) return null;

  const currency = symbolToCurrency_(amountMatch[1]) || "";
  const amount = parseNumber_(amountMatch[2]);
  if (!currency || amount == null || Number.isNaN(amount)) return null;

  const descMatch = t.match(descPattern);
  const description = descMatch
    ? descMatch[1].replace(/\s+/g, " ").trim()
    : defaultDescription;

  let periodStart = datePaid;
  let periodEnd = "";
  const periodMatch = t.match(
    /\b([A-Za-z]{3,9}\s+\d{1,2})(?:,\s*(\d{4}))?\s*[-–]\s*([A-Za-z]{3,9}\s+\d{1,2})(?:,\s*(\d{4}))?/i,
  );
  if (periodMatch) {
    const y1 =
      periodMatch[2] || periodMatch[4] || String(datePaid.getFullYear());
    const y2 =
      periodMatch[4] || periodMatch[2] || String(datePaid.getFullYear());
    const d1 = parseEnglishDateLocal_(`${periodMatch[1]}, ${y1}`);
    const d2 = parseEnglishDateLocal_(`${periodMatch[3]}, ${y2}`);
    if (!isNaN(d1)) periodStart = d1;
    if (!isNaN(d2)) periodEnd = d2;
  }

  return {
    vendor,
    description,
    amount,
    currency,
    category,
    datePaid,
    periodStart,
    periodEnd,
  };
}

function parseOpenAiReceiptPdf_(text) {
  return parseStripeStyleReceiptPdf_(text, {
    vendor: "OpenAI",
    category: "AI Tools",
    descPattern: /(ChatGPT\s+Plus\s+Subscription(?:\s*\(per seat\))?)/i,
    defaultDescription: "ChatGPT subscription",
  });
}

function parseAnthropicReceiptPdf_(text) {
  return parseStripeStyleReceiptPdf_(text, {
    vendor: "Anthropic",
    category: "AI Tools",
    descPattern: /(Claude\s+(?:Pro|Team|Max|Code))/i,
    defaultDescription: "Claude subscription",
  });
}

function parseTorGuardPdf_(text) {
  const t = String(text || "")
    .replace(/\s+/g, " ")
    .trim();

  // Date paid: first date in the Transactions table row (MM/DD/YYYY before "Credit Card")
  const txnDateMatch = t.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s+Credit Card/i);
  if (!txnDateMatch) return null;
  const datePaid = parseMdyDate_(txnDateMatch[1]);
  if (!datePaid || isNaN(datePaid)) return null;

  // Total after discounts: "Total $15.00USD"
  const amountMatch = t.match(/\bTotal\s+\$([0-9]+\.[0-9]{2})USD/i);
  if (!amountMatch) return null;
  const amount = Number(amountMatch[1]);
  if (isNaN(amount) || amount <= 0) return null;

  // Billing period from description line: "Anonymous VPN (11/10/2025 - 05/09/2026)"
  let periodStart = datePaid;
  let periodEnd = "";
  const periodMatch = t.match(
    /Anonymous VPN\s*\((\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})\)/i,
  );
  if (periodMatch) {
    periodStart = parseMdyDate_(periodMatch[1]) || datePaid;
    periodEnd = parseMdyDate_(periodMatch[2]) || "";
  }

  return {
    vendor: "TorGuard",
    description: "TorGuard VPN subscription",
    amount,
    currency: "USD",
    category: "Dev Tools",
    datePaid,
    periodStart,
    periodEnd,
  };
}

/** Parse MM/DD/YYYY date strings (US format used by TorGuard invoices). */
function parseMdyDate_(s) {
  const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), 12, 0, 0),
  );
  return isNaN(d) ? null : d;
}

function parseEnglishDateLocal_(s) {
  const m = String(s || "").match(/([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return new Date(NaN);

  const monthNames = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const monthAbbr = monthNames.map((n) => n.slice(0, 3));
  const monthRaw = m[1].toLowerCase();
  let month = monthNames.indexOf(monthRaw);
  if (month === -1) month = monthAbbr.indexOf(monthRaw.slice(0, 3));
  if (month === -1) return new Date(NaN);

  const day = Number(m[2]);
  const year = Number(m[3]);
  // Use UTC noon to avoid date shifting when rendered in different timezones.
  const d = new Date(Date.UTC(year, month, day, 12, 0, 0));
  return isNaN(d) ? new Date(NaN) : d;
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
