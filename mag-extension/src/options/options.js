(function initializeOptions() {
  "use strict";
  const elements = Object.fromEntries(["threshold", "preserve", "debug", "save-settings", "profile", "editor", "save-profile", "new-profile", "delete-profile", "reset-seed", "export", "import", "message", "auth-status", "login-form", "email", "password", "login", "sync", "logout"].map((id) => [id, document.getElementById(id)]));
  let profiles = [];

  function notify(text, error = false) {
    elements.message.textContent = text;
    elements.message.style.visibility = "visible";
    elements.message.style.background = error ? "#feeceb" : "#e8f5ec";
    elements.message.style.color = error ? "#a12119" : "#176330";
  }

  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  async function background(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "MAG service request failed.");
    return response.data;
  }

  async function renderAuth() {
    const auth = await background({ type: MAG.MESSAGE.AUTH_STATUS });
    elements["auth-status"].textContent = auth.connected ? `Connected as ${auth.user?.displayName || auth.user?.email || "MAG user"}.` : "Not connected. Local/internal profiles remain available offline.";
    elements["login-form"].hidden = auth.connected;
    elements.logout.hidden = !auth.connected;
    elements.sync.disabled = !auth.connected;
  }

  function renderProfileList(selectedId) {
    elements.profile.replaceChildren(...profiles.map((profile) => {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.label;
      return option;
    }));
    if (selectedId && profiles.some((profile) => profile.id === selectedId)) elements.profile.value = selectedId;
    renderEditor();
  }

  function renderEditor() {
    const profile = profiles.find((item) => item.id === elements.profile.value);
    elements.editor.value = profile ? JSON.stringify(profile, null, 2) : "";
    const readOnly = profile?.sync?.source === "SUPABASE";
    elements.editor.readOnly = readOnly;
    elements["save-profile"].disabled = readOnly;
    elements["delete-profile"].disabled = readOnly;
  }

  async function persistProfiles(selectedId) {
    await MAG.Storage.saveProfiles(profiles.filter((profile) => profile?.sync?.source !== "SUPABASE"));
    renderProfileList(selectedId);
  }

  async function initialize() {
    await MAG.Storage.ensureInitialized();
    profiles = await MAG.Storage.getProfiles();
    const settings = await MAG.Storage.getSettings();
    elements.threshold.value = settings.autofillThreshold;
    elements.preserve.checked = settings.preserveExistingValues;
    elements.debug.checked = settings.debug;
    renderProfileList(profiles[0]?.id);
    await renderAuth();
  }

  elements.profile.addEventListener("change", renderEditor);
  elements["save-settings"].addEventListener("click", async () => {
    try {
      await MAG.Storage.saveSettings({ autofillThreshold: elements.threshold.value, preserveExistingValues: elements.preserve.checked, debug: elements.debug.checked });
      notify("Settings saved locally.");
    } catch (error) { notify(error.message, true); }
  });
  elements["save-profile"].addEventListener("click", async () => {
    try {
      const profile = JSON.parse(elements.editor.value);
      MAG.Storage.validateProfiles([profile]);
      const duplicate = profiles.find((item) => item.id === profile.id && item.id !== elements.profile.value);
      if (duplicate) throw new Error(`Another profile already uses id ${profile.id}.`);
      const index = profiles.findIndex((item) => item.id === elements.profile.value);
      if (index >= 0) profiles[index] = profile; else profiles.push(profile);
      await persistProfiles(profile.id);
      notify("Profile saved locally.");
    } catch (error) { notify(error.message, true); }
  });
  elements["new-profile"].addEventListener("click", () => {
    elements.profile.value = "";
    elements.editor.value = JSON.stringify({ id: `profile-${Date.now()}`, label: "New Profile", kind: "ORGANIZATION", organization: {}, content: {} }, null, 2);
    notify("Edit the new profile JSON, then choose Save profile.");
  });
  elements["delete-profile"].addEventListener("click", async () => {
    const selected = elements.profile.value;
    if (!selected) return;
    profiles = profiles.filter((profile) => profile.id !== selected);
    await persistProfiles(profiles[0]?.id);
    notify("Profile deleted from local extension storage.");
  });
  elements["reset-seed"].addEventListener("click", async () => {
    profiles = clone(MAG.INITIAL_PROFILES);
    await persistProfiles(profiles[0]?.id);
    notify("Initial profiles restored. Custom profiles were replaced.");
  });
  elements.export.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(profiles.filter((profile) => profile?.sync?.source !== "SUPABASE"), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `mag-profiles-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  elements.login.addEventListener("click", async () => {
    try {
      await background({ type: MAG.MESSAGE.AUTH_LOGIN, email: elements.email.value.trim(), password: elements.password.value });
      elements.password.value = "";
      await renderAuth();
      notify("Signed in. Choose Sync approved profiles.");
    } catch (error) { elements.password.value = ""; notify(error.message, true); }
  });
  elements.sync.addEventListener("click", async () => {
    try {
      const result = await background({ type: MAG.MESSAGE.SYNC_PROFILES });
      profiles = await MAG.Storage.getProfiles();
      renderProfileList(profiles[0]?.id);
      notify(`Sync complete: ${result.activeProfiles} active profiles; ${result.conflicts.length} conflicts retained locally.`);
    } catch (error) { notify(error.message, true); }
  });
  elements.logout.addEventListener("click", async () => {
    try { await background({ type: MAG.MESSAGE.AUTH_LOGOUT }); await renderAuth(); notify("Logged out. Cached STANDARD profiles remain available offline."); }
    catch (error) { notify(error.message, true); }
  });
  elements.import.addEventListener("change", async () => {
    try {
      const file = elements.import.files?.[0];
      if (!file) return;
      const imported = JSON.parse(await file.text());
      MAG.Storage.validateProfiles(imported);
      profiles = imported;
      await persistProfiles(profiles[0]?.id);
      notify(`${profiles.length} profiles imported.`);
    } catch (error) { notify(error.message, true); }
    finally { elements.import.value = ""; }
  });
  initialize().catch((error) => notify(error.message, true));
})();
