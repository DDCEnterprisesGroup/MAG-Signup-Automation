# Security and privacy

## Data boundaries

Operational workbooks, browser profiles, logs, screenshots, backups, environment files, and local configuration remain outside the shareable repository. The default OS data directory enforces this separation. Git ignore rules and npm run safety:scan reduce accidental commits.

Never commit:

- any live XLSX, XLSM, or XLSB workbook;
- .env or local configuration containing private paths or values;
- runtime browser profiles, cookies, session storage, or downloads;
- logs, screenshots, backups, temporary workbook files, or locks;
- passwords, API keys, tokens, certificates, credential exports, OTPs, or recovery codes.

## Field safety

Restricted semantics are checked across label, placeholder, name, ID, ARIA label, autocomplete, and nearby text before normal matching. SSN, TIN/tax ID, government ID, driver license, passport, bank/routing, payment-card, PIN, security-answer, verification, and biometric fields are manual-only.

Password is a credential exception governed by a registration-only rule. It is permitted only when page context confidently identifies account creation. Login, reset, administrator, and ambiguous prompts hand off.

DOB, annual income, and password values are never intentionally logged. The logger redacts every known profile value from error messages. Safe URLs exclude query strings, fragments, and embedded credentials.

## Screenshots

Screenshots are disabled by default. When enabled, they are permitted only before an approved profile value has been entered on that page. Avoid collecting screenshots during credential or verification steps.

## Browser state

Persistent profiles can contain authentication material. They are excluded from backup and Git. Re-establish sessions manually after migration.

## Authorized use

MAG does not solve CAPTCHA, bypass security, manufacture consent, or determine legal eligibility. Operators are responsible for authorization, site terms, consent, and lawful use.
