/* -----------------------------
   Attachment selection
------------------------------ */

function chooseBestReceiptAttachment(atts) {
  if (!atts || atts.length === 0) return null;

  const usable = atts.filter(att => {
    try {
      const size = att.getBytes().length;
      return size >= CONFIG.MIN_ATTACHMENT_BYTES;
    } catch (e) {
      return true;
    }
  });

  const candidates = usable.length ? usable : atts;

  const pdfs = candidates.filter(isPdf_);
  const pool = pdfs.length ? pdfs : candidates;

  const receiptByName = pool.find(att =>
    (att.getName() || "").toLowerCase().includes("receipt")
  );
  if (receiptByName) return receiptByName;

  const notInvoice = pool.find(att =>
    !(att.getName() || "").toLowerCase().includes("invoice")
  );
  if (notInvoice) return notInvoice;

  return pool
    .slice()
    .sort((a, b) => safeSize_(b) - safeSize_(a))[0];
}

function isPdf_(att) {
  const name = (att.getName() || "").toLowerCase();
  const ct = (att.getContentType() || "").toLowerCase();
  return name.endsWith(".pdf") || ct.includes("pdf");
}

function safeSize_(att) {
  try {
    return att.getBytes().length || 0;
  } catch (e) {
    return 0;
  }
}

/* -----------------------------
   Email extraction (generic, scored)
   Goal: robust across vendors, no special-casing.
------------------------------ */

function extractChargeDate_(msg) {
  const body = (msg.getPlainBody() || "");
  return extractBestDateFromText_(body);
}

function extractAmountCurrency_(msg) {
  const body = (msg.getPlainBody() || "");
  return extractBestMoneyFromText_(body);
}

function extractPeriod_(msg) {
  const body = (msg.getPlainBody() || "");
  // Covers:
  // - "Aug 5, 2025 - Sep 4, 2025"
  // - "February 25, 2025 to February 25, 2026"
  const m =
    body.match(/([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})\s*[–-]\s*([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/) ||
    body.match(/([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})\s+to\s+([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i);

  if (!m) return null;

  const start = new Date(m[1]);
  const end = new Date(m[2]);
  if (isNaN(start) || isNaN(end)) return null;

  return { start, end };
}

/**
 * Money: extract many candidates, score them, return the best.
 * Works for:
 * - Stripe-ish emails
 * - GitHub receipts
 * - 1Password invoice emails (Subtotal vs Total vs Paid)
 * - German emails if they contain "Zahlbetrag"/"Gesamt"/"Summe" etc.
 */
function extractBestMoneyFromText_(body) {
  if (!body) return null;

  const lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // Default currency hint, if present (e.g. "All amounts are in USD.")
  const defaultCurrency =
    (body.match(/\bAll amounts are in\s+(USD|EUR|GBP|NOK|SEK|DKK|CHF)\b/i)?.[1] || "").toUpperCase();

  const candidates = [];

  for (const line of lines) {
    const cands = extractMoneyCandidatesFromLine_(line, defaultCurrency);
    for (const c of cands) candidates.push(c);
  }

  if (candidates.length === 0) {
    // Last-resort scan anywhere (symbol + number, currency code + number)
    const fallback = extractMoneyLoose_(body, defaultCurrency);
    return fallback;
  }

  candidates.sort((a, b) => b.score - a.score);
  return { amount: candidates[0].amount, currency: candidates[0].currency };
}

function extractMoneyCandidatesFromLine_(line, defaultCurrency) {
  const l = (line || "");
  const lower = l.toLowerCase();

  // Score weights (bigger = preferred)
  // We strongly prefer Paid / Amount paid / Total, and penalize Subtotal/Tax/Price.
  let score = 0;

  // Preferred labels
  if (/\bamount paid\b/i.test(l)) score += 95;
  if (/\byou paid\b/i.test(l)) score += 90;
  if (/^\s*paid\b/i.test(l) || /\bpaid\b/i.test(l)) score += 100;
  if (/^\s*total\b/i.test(l) || /\btotal\b/i.test(l)) score += 85;
  if (/\bcharged\b/i.test(l) || /\bhas been charged\b/i.test(l)) score += 75;
  if (/\bzahlbetrag\b/i.test(l)) score += 100; // German "paid amount"
  if (/\bgesamt\b/i.test(l) || /\bsumme\b/i.test(l)) score += 80;

  // Penalties (avoid picking these)
  if (/\bsubtotal\b/i.test(l)) score -= 120;
  if (/\btax\b/i.test(l) || /\bvat\b/i.test(l) || /\bust\b/i.test(l) || /\bsteuer\b/i.test(l)) score -= 60;
  if (/\bprice\b/i.test(l)) score -= 80;

  // Extract 0..n money matches from this line
  const found = [];

  // Symbol-first or symbol-separated
  // $42.70, € 9,99, £10.00
  const symRe = /([$€£])\s*([0-9][0-9.,]*)/g;
  let m;
  while ((m = symRe.exec(l)) !== null) {
    const currency = symbolToCurrency_(m[1]) || defaultCurrency;
    const amount = parseNumber_(m[2]);
    if (currency && amount != null) {
      found.push({ amount, currency, score });
    }
  }

  // Currency code + number (USD 42.70 or 42.70 USD)
  const codeRe1 = /\b(USD|EUR|GBP|NOK|SEK|DKK|CHF)\b\s*([0-9][0-9.,]*)/gi;
  while ((m = codeRe1.exec(l)) !== null) {
    const currency = (m[1] || "").toUpperCase();
    const amount = parseNumber_(m[2]);
    if (currency && amount != null) {
      found.push({ amount, currency, score: score + 5 }); // tiny bump for explicit currency
    }
  }

  const codeRe2 = /([0-9][0-9.,]*)\s*\b(USD|EUR|GBP|NOK|SEK|DKK|CHF)\b/gi;
  while ((m = codeRe2.exec(l)) !== null) {
    const amount = parseNumber_(m[1]);
    const currency = (m[2] || "").toUpperCase();
    if (currency && amount != null) {
      found.push({ amount, currency, score: score + 5 });
    }
  }

  // German style: "20,77€" (no space)
  const deRe = /([0-9]+,[0-9]{2})\s*€?/g;
  while ((m = deRe.exec(l)) !== null) {
    // Only accept if € present or defaultCurrency is EUR or the line is clearly about payment
    const hasEuro = /€/.test(l);
    const currency = hasEuro ? "EUR" : (defaultCurrency === "EUR" ? "EUR" : "");
    const amount = parseNumber_(m[1]);
    if (currency && amount != null) {
      found.push({ amount, currency, score: score + (hasEuro ? 5 : 0) });
    }
  }

  // If we found amounts but currency missing, apply default currency if safe.
  for (const c of found) {
    if (!c.currency && defaultCurrency) c.currency = defaultCurrency;
  }

  // Filter any without currency after defaulting
  return found.filter(x => x.currency && x.amount != null);
}

function extractMoneyLoose_(body, defaultCurrency) {
  // Prefer Paid/Total regions if present, otherwise just last occurrence.
  const lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // Try to restrict to lines containing these keywords
  const preferredLines = lines.filter(l =>
    /paid|total|amount paid|you paid|charged|zahlbetrag|gesamt|summe/i.test(l)
  );

  const pool = preferredLines.length ? preferredLines : lines;

  let best = null;
  for (const line of pool) {
    const cands = extractMoneyCandidatesFromLine_(line, defaultCurrency);
    for (const c of cands) {
      if (!best || c.score > best.score) best = c;
    }
  }
  return best ? { amount: best.amount, currency: best.currency } : null;
}

function symbolToCurrency_(sym) {
  if (sym === "$") return "USD";
  if (sym === "€") return "EUR";
  if (sym === "£") return "GBP";
  return "";
}

function parseNumber_(raw) {
  if (!raw) return null;
  let s = String(raw).trim();

  // Normalize: if both , and . exist => commas are thousand separators
  if (s.includes(",") && s.includes(".")) s = s.replace(/,/g, "");
  // If only comma exists => comma is decimal separator
  else if (s.includes(",") && !s.includes(".")) s = s.replace(/,/g, ".");

  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

/**
 * Date: extract many candidates, score them, return the best.
 * Avoids weird matches and prefers labeled "Date:" / "Paid on" / "Date paid"
 */
function extractBestDateFromText_(body) {
  if (!body) return null;

  const lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const candidates = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    let score = 0;

    if (/\bdate paid\b/i.test(line)) score += 100;
    if (/^\s*date:\b/i.test(line) || /\bdate:\b/i.test(line)) score += 85;
    if (/\bpaid on\b/i.test(line)) score += 90;
    if (/\beinzug(s)?datum\b/i.test(line)) score += 90; // German debit date
    if (/\brechnungsdatum\b/i.test(line)) score += 80;

    // English month date
    const m1 = line.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i);
    if (m1) {
      const d = new Date(m1[0]);
      if (!isNaN(d)) candidates.push({ date: d, score });
    }

    // ISO date in text (common in receipts)
    const m2 = line.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (m2) {
      const d = new Date(`${m2[1]}T00:00:00`);
      if (!isNaN(d)) candidates.push({ date: d, score: score + 5 });
    }

    // German dd.mm.yyyy
    const m3 = line.match(/\b(\d{2}\.\d{2}\.\d{4})\b/);
    if (m3) {
      const d = parseGermanDate_(m3[1]);
      if (d && !isNaN(d)) candidates.push({ date: d, score });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].date;
}