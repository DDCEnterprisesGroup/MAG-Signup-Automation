# Hosting decision

## Conclusion: fully local extension is sufficient for V1

All required V1 capabilities run in the browser:

- deterministic form detection and semantic classification;
- local profile selection and persistence;
- data mapping, confidence, maxlength handling, and reversible autofill;
- review highlighting and per-field actions;
- data-driven site adapters;
- import/export and local debug logs.

The original V1 autofill flow needed no server-side computation, shared database, OAuth exchange, scheduled work, or cross-device collaboration. V1.1 adds authenticated shared profiles through Supabase; the extension still performs detection and filling locally.

The repository mentions a historical hosted/Railway component but contains no Railway configuration or production URL that proves its current purpose or deployment state. The extension itself runs in the browser; V1.1 also depends on Supabase Auth, Postgres, and Edge Functions for shared profiles. Keep any historical hosted component in place until its owner identifies it and checks live dependencies.

Future hosted components must preserve authenticated, minimal, versioned data and must not introduce server-side form submission.
