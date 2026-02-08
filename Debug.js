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