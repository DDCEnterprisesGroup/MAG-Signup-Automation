# MAG Human-Reviewed Autofill Extension

MAG V1.1 is a local-first Chromium extension for repetitive PR, media, community calendar, event, sponsorship, award, interview, and business-directory forms. It preserves V1 form behavior and adds authenticated synchronization of approved profiles and a data-driven field registry from Supabase.

**MAG never submits a form.** There is no automatic submit mode, final-action code path, scheduled submission, submit-event dispatch, Enter-key simulation, CAPTCHA bypass, or automatic legal/consent action. The person using the webpage reviews the result and performs the final submission directly on the site.

## Install in Chromium developer mode

1. Open `chrome://extensions` in Chrome, Edge, Brave, or another Chromium browser.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `mag-extension` directory (the directory containing `manifest.json`).
5. Pin **MAG — Human-Reviewed Autofill** to the toolbar.
6. Optional: open the extension details and enable file URL access only if you want to open fixture HTML files directly. Serving fixtures over localhost avoids that permission.

No build step or dedicated extension server is required. Local/internal profiles work without a connection. Supabase is the canonical shared profile/Auth layer; after source edits, choose **Reload** on the extension card.

## Use

1. Open a public-facing form.
2. Open MAG and choose the organization, event/campaign, person, or product context.
3. Choose **Analyze** to preview mappings without changing field values, or **Autofill safe fields** to fill at the configured threshold.
4. Review orange and red highlights. The popup shows Filled, Review, and Missing counts.
5. Accept a suggestion, focus/edit it on the page, clear it, or skip it.
6. Review all required fields, checkboxes, certifications, uploads, and final language yourself.
7. Submit manually on the webpage.

Green outlines are high-confidence filled values. Orange outlines need review. Red dashed outlines are unresolved required fields. Dotted gray outlines are fields explicitly skipped in the current review.

## Authentication, sync, profiles, and settings

Open **Settings** from the popup or extension details. Sign in with an authorized MAG Supabase account, then choose **Sync approved profiles**. Auth tokens stay in `chrome.storage.session`. Synced profiles are read-only and include only cache-approved STANDARD values; SENSITIVE, RESTRICTED, CREDENTIAL, and unclassified values cannot enter the ordinary cache. A sync compares profile versions, downloads only changed values, removes inactive/revoked profiles, and reports local ID conflicts.

Local/internal JSON profiles remain editable/importable/exportable in `chrome.storage.local` and work offline. Approved synced STANDARD profiles also work offline after the first sync. Unknown facts must remain absent or blank.

Initial contexts are:

- Magical Dream Builders
- Christmas At The Magical Midway / Operation Winter Wonderland (2026)
- Altaire Financial Group
- D’Andre D. Combs Jr. / Dre
- Ice House Jewelers
- K.N. Roberts House / Dollar District

The default threshold fills only high-confidence mappings. A medium threshold is available; medium fills remain highlighted for review. Existing page values are preserved by default.

Never store passwords, payment cards, SSNs, banking information, client tax records, unrelated client data, or API keys in a local MAG profile. Restricted remote fields require a recent MFA session, an explicit Unlock action, and a second explicit Fill click; they are never cached or logged.

## Local fixtures

From the repository root:

```bash
python3 -m http.server 8765 --directory mag-extension/fixtures
```

Open `http://127.0.0.1:8765/`. The fixtures cover contact, calendar, nonprofit, press/media, ambiguous, maxlength, consent/certification/CAPTCHA, restricted explicit-fill, and unknown-field forms.

## Tests

From the repository root:

```bash
npm run test:extension
```

Or from this directory:

```bash
npm test
```

Tests validate the Manifest V3 package, local and session persistence boundaries, dynamic classification, incremental sync, cache exclusion, secret scanning, profile mapping, autofill, maxlength handling, manual edits, reset, protected consent controls, all eight fixture categories, and the static no-submit guarantee. Browser tests count form submit events and require zero.

See [Architecture](docs/ARCHITECTURE.md), [Legacy migration and reuse](docs/MIGRATION.md), and [Hosting decision](docs/HOSTING.md).
