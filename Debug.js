function debugGmailReceiptsScan() {
  const query = `label:"${CONFIG.RECEIPTS_LABEL}" -label:"${CONFIG.PROCESSED_LABEL}" has:attachment`;
  Logger.log("Query: " + query);

  const threads = GmailApp.search(query);
  Logger.log("Threads found: " + threads.length);

  let msgCount = 0;
  let attCount = 0;
  let chosenCount = 0;

  for (const thread of threads) {
    const messages = thread.getMessages();
    msgCount += messages.length;

    for (const msg of messages) {
      const atts = msg.getAttachments({ includeInlineImages: false });
      attCount += atts.length;

      const chosen = chooseBestReceiptAttachment(atts);
      if (chosen) {
        chosenCount++;
        Logger.log("Chosen attachment: " + chosen.getName() + " (" + safeSize_(chosen) + " bytes)");
      } else {
        Logger.log("No chosen attachment for msg subject: " + msg.getSubject());
      }
    }
  }

  Logger.log("Messages scanned: " + msgCount);
  Logger.log("Total attachments: " + attCount);
  Logger.log("Chosen attachments: " + chosenCount);
}

/**
 * Inspect money extraction scoring for a specific vendor.
 * @param {string} vendor - e.g. "fly.io", "github.com"
 * @param {number} [limit] - max threads to inspect (default 5)
 */
function debugMoneyExtraction(vendor, limit) {
  const max = Number(limit) > 0 ? Number(limit) : 5;
  const query = `label:"${CONFIG.RECEIPTS_LABEL}" (from:${vendor} OR subject:${vendor})`;
  Logger.log("Query: " + query);

  const threads = GmailApp.search(query, 0, max);
  Logger.log("Threads found: " + threads.length);

  let inspected = 0;

  for (const thread of threads) {
    const messages = thread.getMessages();
    for (const msg of messages) {
      const body = msg.getPlainBody() || "";
      const lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const defaultCurrency =
        (body.match(/\bAll amounts are in\s+(USD|EUR|GBP|NOK|SEK|DKK|CHF)\b/i)?.[1] || "").toUpperCase();

      const candidates = [];
      for (const line of lines) {
        const cands = extractMoneyCandidatesFromLine_(line, defaultCurrency);
        for (const c of cands) candidates.push({ ...c, line });
      }

      candidates.sort((a, b) => (b.score - a.score) || (b.amount - a.amount));
      const best = candidates[0] || null;

      Logger.log("-----");
      Logger.log("Subject: " + msg.getSubject());
      Logger.log("Date: " + msg.getDate());
      Logger.log("Best: " + (best ? `${best.amount} ${best.currency} (score ${best.score})` : "none"));

      for (let i = 0; i < Math.min(8, candidates.length); i++) {
        const c = candidates[i];
        Logger.log(`#${i + 1}: ${c.amount} ${c.currency} (score ${c.score}) | ${c.line}`);
      }

      inspected++;
      if (inspected >= max) {
        Logger.log("Inspected messages: " + inspected);
        return;
      }
    }
  }

  Logger.log("Inspected messages: " + inspected);
}
