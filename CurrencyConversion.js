/**
 * EUR conversion via the Frankfurter API (https://www.frankfurter.app).
 * Free, open-source, no API key required. Returns historical daily rates.
 */

/**
 * Fetches the EUR exchange rate for a given currency on a given date.
 * If the date falls on a weekend or holiday, Frankfurter returns the closest
 * prior business day's rate automatically.
 *
 * @param {string} currency - ISO 4217 code (e.g. "USD", "GBP", "CHF")
 * @param {Date} date
 * @returns {number|null} Units of EUR per 1 unit of currency, or null on failure.
 */
function fetchEurRate_(currency, date) {
  if (!currency || !date) return null;
  const code = String(currency).toUpperCase().trim();
  if (code === "EUR") return 1;

  const dateStr = Utilities.formatDate(date, "UTC", "yyyy-MM-dd");
  const url = `https://api.frankfurter.app/${dateStr}?from=${code}&to=EUR`;

  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      Logger.log(`[currency] Rate fetch failed for ${code} on ${dateStr}: HTTP ${resp.getResponseCode()}`);
      return null;
    }
    const data = JSON.parse(resp.getContentText());
    return data?.rates?.EUR ?? null;
  } catch (e) {
    Logger.log(`[currency] Rate fetch error for ${code} on ${dateStr}: ${e}`);
    return null;
  }
}

/**
 * Converts an amount to EUR at the historical rate on the given date.
 * Returns null if conversion fails (unknown currency, API unavailable, etc.).
 *
 * @param {number|null} amount
 * @param {string} currency
 * @param {Date} date
 * @returns {number|null}
 */
function convertToEur_(amount, currency, date) {
  if (amount == null || !currency || !date) return null;
  const rate = fetchEurRate_(currency, date);
  if (rate == null) return null;
  return Math.round(amount * rate * 100) / 100;
}
