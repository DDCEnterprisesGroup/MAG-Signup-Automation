# Architecture

## Runtime flow

`Supabase Auth/RLS → approved STANDARD sync → safe local cache → webpage detector → local + dynamic registry classifier → mapping/confidence → autofill/review → human submission`

The content script runs in Chromium’s isolated world. It never inserts a submit control and never operates a page’s final action. The popup sends only analyze, autofill, review-field, reset, and status messages.

## Modules

- `manifest.json` — Manifest V3 entry point, least-purpose permissions, ordered content modules.
- `src/core/field-detector.js` — visible standard controls, contenteditable text controls, labels, ARIA descriptions, fieldsets, headings, options, required state, autocomplete, and maxlength.
- `src/core/field-classifier.js` — deterministic semantic aliases, weighted evidence, explicit ambiguity, and protected-field detection.
- `src/core/profile-mapper.js` — nested data lookup and approved short/medium/long content selection.
- `src/core/autofill-engine.js` — safe value assignment, confidence threshold, reversible changes, highlights, per-field review actions, and summary counts.
- `src/adapters/site-adapters.js` — optional hostname/path/selector mappings layered above the generic classifier. Adapters cannot submit.
- `src/shared/storage.js` — local/internal profiles, STANDARD-only remote cache validation, registry metadata, sync state, settings, per-domain profile, and capped debug logs.
- `src/shared/dynamic-registry.js` — runtime aliases and security/autofill policy supplied by the approved registry.
- `src/background/supabase-client.js` — Auth REST client with session-only tokens and refresh/logout.
- `src/background/sync-engine.js` — version comparison, changed-profile value retrieval, deactivation/revocation cleanup, and read-only cache construction.
- `src/background/service-worker.js` — initialization, detection badge, Auth/sync coordination, and restricted on-demand retrieval. It has no scheduling or form access.
- `src/popup/*` — profile choice, analyze/autofill, summary, review actions, and reset.
- `src/options/*` — local profile CRUD/import/export and threshold settings.

The shared modules use a small `globalThis.MAG` namespace so Chromium can load them as ordered content scripts without a bundler or remote code. Extension pages reuse the same storage/data modules.

## Confidence and safety

- **HIGH (85–100):** eligible for default autofill.
- **MEDIUM (65–84):** suggestion; fills only when the user changes the setting and remains highlighted.
- **LOW (40–64):** suggestion only.
- **UNKNOWN (0–39):** unresolved; required controls are marked missing.

Legal agreements, certifications, consent, attestations, signatures, credentials, OTPs, restricted identity/financial data, file inputs, checkboxes, and radio controls are protected regardless of other signals. Unknown data stays unknown. Existing page values are preserved by default.

For maxlength fields, MAG chooses the longest stored approved variant that fits. If none fits, it does not fill or truncate; it flags the shortest approved candidate for editing.

## Profile schema

Profiles are deliberately data-driven and extensible. Local profiles keep the V1 nested shape. Synced profiles use stable `id`, `label`, `kind`, `dynamicFields`, and read-only `sync` metadata. `dynamicFields` keys come from Supabase definitions, so a normal field/alias addition does not require an extension release. Content values may still use approved `short`, `medium`, and `long` variants. Missing properties mean unknown values.

RESTRICTED values are not part of this schema or cache. Retrieval and filling are gated off pending Dre's live AAL2 acceptance. The prepared future flow requires a separate Edge Function with recent AAL2, authorization, and a separate popup approval before a one-time fill. Plaintext must exist only in short-lived extension memory and the page field selected by the human.

## Site adapters and future AI

The generic classifier is the default. A site adapter may contribute a semantic type for a known selector, scoped by hostname and path. It does not fork the detector, mapper, review UI, or safety policy.

No external AI is needed for V1. If AI-assisted interpretation is added later, it should implement a provider interface that returns suggestions and confidence only, remain opt-in, send no data without explicit authorization, and never gain DOM submission capability.
