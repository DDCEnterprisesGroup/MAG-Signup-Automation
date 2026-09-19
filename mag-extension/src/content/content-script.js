(function initializeContentScript(root) {
  "use strict";
  const MAG = root.MAG;
  let lastDetectedCount = -1;
  let detectionTimer;

  function detectionStatus() {
    const count = MAG.FieldDetector.detect().length;
    return { supported: count > 0, detected: count, hostname: location.hostname, title: document.title };
  }

  function notifyDetection() {
    clearTimeout(detectionTimer);
    detectionTimer = setTimeout(() => {
      const status = detectionStatus();
      if (status.detected === lastDetectedCount) return;
      lastDetectedCount = status.detected;
      chrome.runtime.sendMessage({ type: MAG.MESSAGE.FORM_DETECTED, ...status }).catch(() => undefined);
    }, 250);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (message.registry) MAG.DynamicRegistry.setDefinitions(message.registry);
      if (message.type === MAG.MESSAGE.PING) sendResponse({ ok: true, ...detectionStatus(), summary: MAG.AutofillEngine.summary() });
      else if (message.type === MAG.MESSAGE.ANALYZE) sendResponse({ ok: true, summary: MAG.AutofillEngine.analyze(message.profile, message.settings) });
      else if (message.type === MAG.MESSAGE.AUTOFILL) sendResponse({ ok: true, summary: MAG.AutofillEngine.autofill(message.profile, message.settings) });
      else if (message.type === MAG.MESSAGE.RESET) sendResponse({ ok: true, summary: MAG.AutofillEngine.reset() });
      else if (message.type === MAG.MESSAGE.FIELD_ACTION) sendResponse({ ok: true, summary: MAG.AutofillEngine.fieldAction(message.fieldId, message.action) });
      else if (message.type === MAG.MESSAGE.GET_STATUS) sendResponse({ ok: true, summary: MAG.AutofillEngine.summary() });
      else if (message.type === MAG.MESSAGE.FILL_RESTRICTED) sendResponse({ ok: true, summary: MAG.AutofillEngine.fillRestricted(message.fieldId, message.plaintext) });
      else return false;
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return false;
  });

  new MutationObserver(notifyDetection).observe(document.documentElement, { childList: true, subtree: true });
  notifyDetection();
})(globalThis);
