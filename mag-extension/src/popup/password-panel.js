(function initializePasswordPanel() {
  "use strict";
  const elements = {
    output: document.getElementById("password-output"), length: document.getElementById("password-length"),
    symbols: document.getElementById("password-symbols"), generate: document.getElementById("password-generate"),
    copy: document.getElementById("password-copy"), fill: document.getElementById("password-fill"),
    status: document.getElementById("password-status")
  };
  if (!elements.output) return;
  // The last password is kept only for this browser session so it can be
  // reused while the panel is reopened; it is never written to disk or synced.
  const STORAGE_KEY = "magGeneratedPassword";

  function setStatus(text) { elements.status.textContent = text; }

  async function remember(value) {
    try { await chrome.storage.session?.set({ [STORAGE_KEY]: { value, length: Number(elements.length.value), symbols: elements.symbols.checked } }); }
    catch { /* Reuse is a convenience; generation still works without it. */ }
  }

  async function generate() {
    const value = MAG.Password.generate({ length: elements.length.value, symbols: elements.symbols.checked });
    elements.output.value = value;
    await remember(value);
    setStatus(`New ${value.length}-character password.`);
  }

  async function copy() {
    if (!elements.output.value) await generate();
    try {
      await navigator.clipboard.writeText(elements.output.value);
    } catch {
      elements.output.select();
      if (!document.execCommand("copy")) { setStatus("Copy failed. Select the password and copy it manually."); return; }
    }
    setStatus("Copied to clipboard.");
  }

  // Explicit click only: MAG's profile Autofill never fills password fields.
  async function fill() {
    if (!elements.output.value) await generate();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let result;
    try {
      result = tab?.id ? await chrome.tabs.sendMessage(tab.id, { type: MAG.MESSAGE.FILL_PASSWORD, password: elements.output.value }) : null;
    } catch { result = null; }
    if (!result?.ok) { setStatus("MAG can't reach this page. Refresh the page and try again."); return; }
    if (result.filled) {
      // MAG does not save the password, so keep it on the clipboard as well.
      const copied = await navigator.clipboard.writeText(elements.output.value).then(() => true, () => false);
      setStatus(`Filled ${result.filled} password field${result.filled === 1 ? "" : "s"}${copied ? " and copied the password" : ". Copy the password before you submit"}.`);
    }
    else setStatus(result.skippedLogin ? "Only a login password field is here; MAG leaves those alone." : "No password field found on this page.");
  }

  async function restore() {
    let saved = null;
    try { saved = (await chrome.storage.session?.get(STORAGE_KEY))?.[STORAGE_KEY] || null; } catch { saved = null; }
    if (saved?.value) {
      elements.length.value = String(saved.length || MAG.Password.DEFAULT_LENGTH);
      elements.symbols.checked = saved.symbols !== false;
      elements.output.value = saved.value;
      setStatus("Last password from this browser session.");
    } else {
      await generate();
    }
  }

  elements.generate.addEventListener("click", () => generate().catch(() => setStatus("Could not generate a password.")));
  elements.copy.addEventListener("click", () => copy());
  elements.fill.addEventListener("click", () => fill());
  elements.length.addEventListener("change", () => generate());
  elements.symbols.addEventListener("change", () => generate());
  restore();
})();
