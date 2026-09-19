(function initializePopup() {
  "use strict";
  const elements = {
    profile: document.getElementById("profile"), detected: document.getElementById("detected"),
    analyze: document.getElementById("analyze"), autofill: document.getElementById("autofill"),
    filled: document.getElementById("filled"), review: document.getElementById("review"),
    missing: document.getElementById("missing"), issuesSection: document.getElementById("issues-section"),
    issues: document.getElementById("issues"), message: document.getElementById("message"),
    reset: document.getElementById("reset"), settings: document.getElementById("settings"),
    connection: document.getElementById("connection"), syncMeta: document.getElementById("sync-meta"),
    sync: document.getElementById("sync"), logout: document.getElementById("logout")
  };
  let tab;
  let profiles = [];
  let hostname = "";
  let registry = [];
  let latestSummary = {};
  const transientRestricted = new Map();

  function setMessage(message, isError = false) {
    elements.message.textContent = message || "";
    elements.message.style.color = isError ? "#b42318" : "#176330";
  }

  async function send(message) {
    if (!tab?.id) throw new Error("No active browser tab is available.");
    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (!response?.ok) throw new Error(response?.error || "MAG could not access this page.");
    return response;
  }

  async function background(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "MAG service request failed.");
    return response.data;
  }

  function activeProfile() {
    return profiles.find((profile) => profile.id === elements.profile.value);
  }

  function updateSummary(summary = {}) {
    latestSummary = summary;
    elements.filled.textContent = String(summary.filled || 0);
    elements.review.textContent = String(summary.needsReview || 0);
    elements.missing.textContent = String(summary.missing || 0);
    const issues = (summary.items || []).filter((item) => item.status === "REVIEW" || item.status === "MISSING");
    elements.issues.replaceChildren(...issues.map(renderIssue));
    elements.issuesSection.hidden = issues.length === 0;
  }

  function button(label, action, fieldId) {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = label;
    item.dataset.action = action;
    item.dataset.fieldId = fieldId;
    return item;
  }

  function renderIssue(item) {
    const card = document.createElement("div");
    card.className = "issue";
    const head = document.createElement("div");
    head.className = "issue-head";
    const label = document.createElement("span");
    label.className = "issue-label";
    label.textContent = item.label;
    const confidence = document.createElement("span");
    confidence.className = "confidence";
    confidence.textContent = `${item.semantic} · ${item.confidence}`;
    head.append(label, confidence);
    const reason = document.createElement("p");
    reason.textContent = item.reason;
    card.append(head, reason);
    if (item.value) {
      const value = document.createElement("div");
      value.className = "value";
      value.textContent = item.value;
      card.append(value);
    }
    const actions = document.createElement("div");
    actions.className = "mini-actions";
    if (item.restricted) {
      actions.append(button(transientRestricted.has(item.fieldId) ? "Fill field" : "Unlock / Authenticate", transientRestricted.has(item.fieldId) ? "fill-restricted" : "unlock-restricted", item.fieldId));
    } else if (item.value && !item.reason.startsWith("Human-controlled")) actions.append(button("Accept", "accept", item.fieldId));
    actions.append(button("Edit on page", "focus", item.fieldId));
    if (!item.reason.startsWith("Human-controlled")) actions.append(button("Clear", "clear", item.fieldId));
    actions.append(button("Skip", "skip", item.fieldId));
    card.append(actions);
    return card;
  }

  async function run(action) {
    const profile = activeProfile();
    if (!profile) throw new Error("Choose a profile first.");
    const settings = await MAG.Storage.getSettings();
    const response = await send({ type: action, profile, settings, registry });
    await MAG.Storage.rememberDomainProfile(hostname, profile.id);
    updateSummary(response.summary);
    setMessage(action === MAG.MESSAGE.AUTOFILL ? "Safe matches filled. Review every highlighted field before you submit." : "Analysis complete. No form action was taken.");
  }

  async function initialize() {
    try {
      await MAG.Storage.ensureInitialized();
      profiles = await MAG.Storage.getProfiles();
      registry = await MAG.Storage.getFieldRegistry();
      const auth = await background({ type: MAG.MESSAGE.AUTH_STATUS });
      const syncState = await MAG.Storage.getSyncState();
      elements.connection.textContent = auth.connected ? `Connected as ${auth.user?.displayName || "MAG user"}` : "Local only";
      elements.connection.className = `pill ${auth.connected ? "ok" : "neutral"}`;
      elements.logout.hidden = !auth.connected;
      elements.syncMeta.textContent = syncState.lastSuccessfulSync ? `${syncState.activeProfiles || 0} active synced profiles · ${new Date(syncState.lastSuccessfulSync).toLocaleString()}` : "Local profiles are available offline. Sign in under Settings to sync.";
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      hostname = tab?.url ? new URL(tab.url).hostname : "";
      const remembered = hostname ? await MAG.Storage.getDomainProfile(hostname) : "";
      for (const profile of profiles) {
        const option = document.createElement("option");
        option.value = profile.id;
        option.textContent = profile.label;
        elements.profile.append(option);
      }
      if (profiles.some((profile) => profile.id === remembered)) elements.profile.value = remembered;
      const response = await send({ type: MAG.MESSAGE.PING });
      elements.detected.textContent = response.supported ? `${response.detected} fields` : "No form";
      elements.detected.className = `pill ${response.supported ? "ok" : "neutral"}`;
      updateSummary(response.summary);
      if (!response.supported) setMessage("No visible editable form fields were detected on this page.", true);
    } catch (error) {
      elements.detected.textContent = "Unavailable";
      setMessage(error instanceof Error ? error.message : String(error), true);
      elements.analyze.disabled = true;
      elements.autofill.disabled = true;
    }
  }

  elements.analyze.addEventListener("click", () => run(MAG.MESSAGE.ANALYZE).catch((error) => setMessage(error.message, true)));
  elements.autofill.addEventListener("click", () => run(MAG.MESSAGE.AUTOFILL).catch((error) => setMessage(error.message, true)));
  elements.reset.addEventListener("click", async () => {
    try { updateSummary((await send({ type: MAG.MESSAGE.RESET })).summary); setMessage("MAG changes and highlights were reset."); }
    catch (error) { setMessage(error.message, true); }
  });
  elements.issues.addEventListener("click", async (event) => {
    const control = event.target.closest("button[data-action]");
    if (!control) return;
    try {
      if (control.dataset.action === "unlock-restricted") {
        const profile = activeProfile();
        if (!profile?.sync?.remoteId) throw new Error("Restricted values are available only for authorized synced profiles.");
        const issue = (latestSummary.items || []).find((item) => item.fieldId === control.dataset.fieldId);
        let result;
        try {
          result = await background({ type: MAG.MESSAGE.RESTRICTED_UNLOCK, profileId: profile.sync.remoteId, canonicalKey: issue?.canonicalKey });
        } catch (error) {
          if (error.message !== "RECENT_MFA_REQUIRED") throw error;
          const code = window.prompt("Enter the current code from your authenticator app. MAG will not store it.");
          if (!code) { setMessage("Restricted unlock cancelled.", true); return; }
          await background({ type: MAG.MESSAGE.MFA_VERIFY, code });
          result = await background({ type: MAG.MESSAGE.RESTRICTED_UNLOCK, profileId: profile.sync.remoteId, canonicalKey: issue?.canonicalKey });
        }
        transientRestricted.set(control.dataset.fieldId, result.value);
        issue.maskedHint = result.maskedHint;
        updateSummary(latestSummary);
        setMessage(`Authorized ${issue.maskedHint || "restricted value"}. Click Fill field to approve this one fill.`);
        return;
      }
      if (control.dataset.action === "fill-restricted") {
        const plaintext = transientRestricted.get(control.dataset.fieldId);
        if (!plaintext) throw new Error("Unlock this restricted field again.");
        const issue = (latestSummary.items || []).find((item) => item.fieldId === control.dataset.fieldId);
        const profile = activeProfile();
        const response = await send({ type: MAG.MESSAGE.FILL_RESTRICTED, fieldId: control.dataset.fieldId, plaintext });
        transientRestricted.delete(control.dataset.fieldId);
        await background({ type: MAG.MESSAGE.AUDIT_EVENT, action: "RESTRICTED_FILL_APPROVED", entityId: profile?.sync?.remoteId, fieldCanonicalKey: issue?.canonicalKey });
        updateSummary(response.summary);
        setMessage("Restricted field filled after explicit approval. MAG retained no local copy.");
        return;
      }
      const response = await send({ type: MAG.MESSAGE.FIELD_ACTION, fieldId: control.dataset.fieldId, action: control.dataset.action });
      updateSummary(response.summary);
      setMessage(control.dataset.action === "focus" ? "Field focused on the page for manual editing." : "Review state updated.");
    } catch (error) { setMessage(error.message, true); }
  });
  elements.profile.addEventListener("change", () => {
    if (hostname) MAG.Storage.rememberDomainProfile(hostname, elements.profile.value).catch(() => undefined);
    setMessage("Profile selected. Choose Analyze or Autofill; the page has not been changed.");
  });
  elements.settings.addEventListener("click", () => chrome.runtime.openOptionsPage());
  elements.sync.addEventListener("click", async () => {
    try {
      elements.sync.disabled = true;
      const result = await background({ type: MAG.MESSAGE.SYNC_PROFILES });
      setMessage(`Sync complete: ${result.activeProfiles} active profiles.`);
      setTimeout(() => location.reload(), 400);
    } catch (error) { setMessage(error.message, true); }
    finally { elements.sync.disabled = false; }
  });
  elements.logout.addEventListener("click", async () => {
    try { await background({ type: MAG.MESSAGE.AUTH_LOGOUT }); transientRestricted.clear(); location.reload(); }
    catch (error) { setMessage(error.message, true); }
  });
  initialize();
})();
