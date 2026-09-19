# MAG extension: release readiness

## Development / testing (do this today, no Web Store account needed)

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer Mode** (top-right toggle).
3. Click **Load unpacked** and select this exact permanent directory (not a
   copy, not a temp/build path -- there is no build step, Chrome loads the
   source directly):

   ```
   /Volumes/Mac Storage/Dre-Organized-2026-09-09/MAG/MAG-Signup-Automation/mag-extension
   ```

4. Confirm:
   - [ ] Extension loads with no errors on the `chrome://extensions` card.
   - [ ] Service worker shows "active" (click "service worker" link on the
     card to open its console and confirm no startup errors).
   - [ ] Clicking the toolbar icon opens the popup (`src/popup/popup.html`)
     without a blank/broken UI.
   - [ ] Opening the extension's options page (right-click icon -> Options,
     or the gear/link in the popup) loads without errors.
   - [ ] Sign-in from Settings and "Sync approved profiles" works once a
     Supabase project is confirmed and linked (see docs/MAG_V1_1.md). The
     local extension URL alone does not establish which project Dre authorizes.
   - [ ] Load one of the fixtures under `mag-extension/fixtures/*.html` and
     confirm field detection, safe fill, and review highlights work, and
     that no field is ever auto-submitted.
   - [ ] Restricted-class fields remain blank. Retrieval and Fill are disabled
     in source until Dre completes live AAL2/MFA acceptance.

Automated coverage already in place and passing (`npm run test:extension`,
17/17): Manifest V3 structure, no prohibited submission mechanism anywhere
in the execution path (`.submit()`, `.requestSubmit()`, synthetic
click/keyboard/submit events, `chrome.alarms`), storage/session-only auth
tokens, restricted-value handling, and no privileged key or secret material
in source. This was verified statically (manifest parses, every referenced
JS file is syntactically valid, every manifest-referenced file exists) in
addition to the test suite -- `chrome://extensions` itself is not
automatable by browser-automation tooling (a deliberate Chrome security
boundary), so the checklist items above need a human click-through.

## Chrome Web Store submission (do this later -- not today)

**Do not publish.** Initial distribution is **Unlisted** unless Dre changes
that later.

Build the submission ZIP (manifest.json + src/ only -- no tests, fixtures,
docs, or package.json) with:

```
mag-extension/scripts/package-for-store.sh
```

This writes `mag-extension/dist/mag-extension-v<version>.zip` (gitignored,
regenerate anytime; do not hand-edit or commit the zip itself).

Missing before an actual Web Store submission can happen (not required for
`Load unpacked` above, which works today):

- [ ] **Icon assets.** No `icons` entry exists in `manifest.json` and no
  icon files exist anywhere in this extension. Chrome Web Store requires at
  least a 128x128 icon for the listing; `Load unpacked` shows a generic
  puzzle-piece placeholder without one. This is a design asset decision
  (the actual MAG/MAGHaus mark), not something to fabricate here -- Dre (or
  whoever owns brand assets) needs to provide or commission one.
- [ ] **Store listing screenshots** (1280x800 or 640x400, at least one).
- [ ] **Store listing copy**: short description (currently only the
  manifest's one-line `description` exists), and confirm the detailed
  description doesn't overstate capabilities not yet live (Supabase not
  linked yet -- see above).
- [ ] **Privacy practices disclosure** in the Chrome Web Store developer
  dashboard: this extension requests `host_permissions: ["<all_urls>"]` and
  `storage`; the dashboard will require a justification for the broad host
  permission and a privacy policy URL. `docs/ARCHITECTURE.md` /
  `docs/HOSTING.md` in this repo cover the technical design and can inform
  that disclosure, but the disclosure itself is a Web Store account action.
- [ ] **A Chrome Web Store developer account** ($5 one-time registration
  fee, requires payment) -- confirm Dre wants to proceed with this before
  spending money, per the standing "do not introduce a new paid platform
  without approval" guidance; a $5 one-time Web Store registration is a
  much smaller decision than a hosting platform but is still a real charge
  worth a explicit go-ahead.
- [ ] **Narrow `host_permissions`** from `<all_urls>` to the actual target
  domain list once `src/adapters/site-adapters.js` and
  `src/shared/dynamic-registry.js` have a stable set of sites (tracked
  separately in the main session report as P2 work, not blocking Unlisted
  distribution but worth doing before any wider audience).

## Rollback

Per `mag-extension/docs/MIGRATION.md`: removing the unpacked extension (or
disabling it in `chrome://extensions`) fully reverts to no autofill
assistance with zero effect on the legacy Playwright automation or any
Supabase data -- the extension is additive and read-only against
`mag_profiles` until a human clicks Fill/Submit themselves.
