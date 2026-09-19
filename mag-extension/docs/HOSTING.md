# Hosting decision

## Conclusion: fully local extension is sufficient for V1

All required V1 capabilities run in the browser:

- deterministic form detection and semantic classification;
- local profile selection and persistence;
- data mapping, confidence, maxlength handling, and reversible autofill;
- review highlighting and per-field actions;
- data-driven site adapters;
- import/export and local debug logs.

There is no server-side computation, shared database, OAuth exchange, scheduled work, remote AI call, or cross-device collaboration requirement. A backend would add privacy, credential, availability, and maintenance cost without enabling a V1 requirement.

The existing hosted/Railway component is **not required by this extension**. This implementation does not delete or modify production infrastructure. It can be shut down only after the owner separately confirms that no legacy process still depends on it.

A lightweight backend may become beneficial later for opt-in team profile synchronization, centrally managed approved content, adapter distribution, or audit history. Those features should use authenticated, minimal, versioned data and must not introduce server-side submission.
