(function initializePasswordPanel() {
  "use strict";
  const elements = {
    output: document.getElementById("password-output"), length: document.getElementById("password-length"),
    symbols: document.getElementById("password-symbols"), generate: document.getElementById("password-generate"),
    copy: document.getElementById("password-copy"), status: document.getElementById("password-status")
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
  elements.length.addEventListener("change", () => generate());
  elements.symbols.addEventListener("change", () => generate());
  restore();
})();
