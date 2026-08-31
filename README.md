# MAG Signup Automation

MAG Automation v1.1.1 is a local, workbook-driven, browser-assisted signup framework for Windows and macOS. It reads approved profile values and target sites from an Excel workbook, fills fields only when the match and page context are confident, checkpoints every Person ID + Site ID attempt, and resumes without repeating completed registrations.

The browser is visible by default. MAG pauses for CAPTCHA, verification, restricted data, required consent, unknown required fields, or ambiguous outcomes. During human handoff it watches the page continuously: a manual Next can resume automation, and a confidently confirmed manual Submit can checkpoint completion and move to the next eligible site without requiring Enter. Enter remains a fallback.

MAG can automatically submit only a confidently identified registration form whose allowed required fields are complete and which has no sensitive/manual field, CAPTCHA, verification, validation error, unknown required field, or unresolved consent choice. It does not bypass anti-bot controls, authentication, identity checks, site security, terms, or operator decisions.

## Supported systems and requirements

- Windows 10 or 11, or a currently supported macOS release.
- Node.js 22 or 24 LTS. npm is included with Node.js.
- Git for cloning and safe updates.
- Google Chrome, or the Playwright Chromium installed by the setup command.
- About 2 GB of free space for dependencies and a browser installation, plus room for local backups and browser profiles.
- A terminal that remains open while MAG runs.

Required official downloads:

- [Node.js](https://nodejs.org/en/download) — install a current LTS release.
- [Git](https://git-scm.com/downloads/) — command-line source control.
- [Google Chrome](https://www.google.com/chrome/) — optional if Playwright Chromium is used.
- [GitHub](https://github.com/) — repository hosting/account access where applicable.
- [Visual Studio Code](https://code.visualstudio.com/download) — OPTIONAL editor.
- [GitHub Desktop](https://desktop.github.com/download/) — OPTIONAL graphical Git client.

VS Code and GitHub Desktop are not required to operate MAG.

## Windows installation from a clean computer

1. Install Node.js LTS and Git from the official links above. Install Chrome if desired.
2. Restart PowerShell so the new commands are available.
3. Clone the repository and open its folder:

~~~powershell
git clone https://github.com/DDCEnterprisesGroup/MAG-Signup-Automation.git
cd MAG-Signup-Automation
~~~

4. Install and initialize:

~~~powershell
npm install
npm run setup
npm run init
npm run doctor
npm start
~~~

npm install installs the application packages. npm run setup validates Node/browser components and creates local directories. npm run init copies the clean workbook only when no live workbook exists. npm run doctor reports PASS, WARNING, and FAIL checks. npm start reconciles the workbook and opens the person selector.

For a guided platform bootstrap, run:

~~~powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
~~~

## macOS installation from a clean computer

Direct route:

1. Install Node.js LTS and Git from the official links above. macOS may offer Apple command-line tools when Git first runs.
2. Clone the repository, then run:

~~~bash
git clone https://github.com/DDCEnterprisesGroup/MAG-Signup-Automation.git
cd MAG-Signup-Automation
npm install
npm run setup
npm run init
npm run doctor
npm start
~~~

Optional Homebrew route, only if Homebrew is already installed:

~~~bash
brew install node@24 git
npm install
npm run setup
npm run init
npm run doctor
npm start
~~~

The platform script is also available:

~~~bash
chmod +x scripts/setup-macos.sh
./scripts/setup-macos.sh
~~~

macOS may ask Terminal for permission to access a folder if the repository or workbook was placed under Desktop, Documents, Downloads, or an external volume. Approve only the folder access required for this installation. MAG does not require Accessibility permission for normal Playwright operation.

See [Windows setup](docs/WINDOWS_SETUP.md) and [macOS setup](docs/MACOS_SETUP.md) for expanded instructions.

## First workbook setup

The clean template contains exactly four sheets:

1. Sheet 1 Sites — Site ID, site name, signup URL, active flag, site status, final URL, and notes.
2. Sheet 2 People — approved profile fields plus durable Person ID, status, current site, and last-updated fields.
3. Sheet 3 Results — summary columns A:G and the authoritative detailed ledger in columns J:S.
4. Sheet 4 Site Issues — global URL, redirect, availability, and temporary-error observations.

Open the live workbook path printed by npm run init. Add people and sites, save, and close Excel before running MAG. A populated person without an ID receives the next P0001-style ID. A URL without a Site ID receives the next S0001-style ID. Blank person status becomes PENDING; blank site active becomes YES. IDs are never reused from history.

The People columns are:

ID, FIRST NAME/GIVEN NAME, LAST NAME, PHONE, EMAIL, ADDRESS, CITY, STATE, ZIP, DOB, OCCUPATION, ANNUAL INCOME, PASSWORD, STATUS, CURRENT SITE ID, LAST UPDATED.

DOB may be entered as MM/DD/YYYY or YYYY-MM-DD and is normalized for site controls. Annual income may include commas or a currency symbol. Password is used only on confidently identified account-creation pages and is never used for login or reset flows. See [Workbook guide](docs/WORKBOOK_GUIDE.md).

## Selecting a person

Normal startup displays each populated person with Person ID, name, current status, completed-site count, remaining eligible count, and human-review count. Progress comes from the detailed ledger, not a name or row position.

Process one person directly:

~~~bash
npm start -- --person P0003
npm run resume -- --person P0003
~~~

An unknown ID causes an error that lists available IDs. MAG never falls back to another person. Choose Process all eligible people in the menu, or pass --all, only when automatic person-to-person movement is intended.

## Starting, resuming, and stopping

~~~bash
npm start
npm run resume
~~~

Both commands reconcile the workbook before selection. Completed Person ID + Site ID pairs are skipped. New sites become unattempted only for people who have not completed those Site IDs. Temporary failures remain eligible within the configured cap.

`mag start` (and `mag restart`) additionally run a startup preflight gate before the worker launches: it checks the worker/workbook lock, verifies the workbook opens and its schema is valid, writes a lightweight pre-reconcile checkpoint copy (`backups/MAG_Workbook-pre-start-*.xlsx`, last 10 kept), runs the same reconciliation, and prints a PASS/FAIL summary. Deterministic gaps and stale summaries are repaired automatically; a stale in-progress attempt from a prior crash is routed to WAITING FOR HUMAN rather than retried (it could double-submit). The worker does not start on a critical conflict — a duplicate ATTEMPT ID, a summary claiming more completions than the ledger supports, or a completed/in-progress Results row pointing at a missing Person or Site ID — and the exact issue plus the required operator action are printed. Run the gate without starting the worker with `mag preflight`.

## Live operator hotkeys

When the worker runs in a terminal, single keys control the current site without typing commands. They never act mid-step: each key raises a request that the engine applies at its next safe checkpoint, so the workbook is never left half-written and no submission is duplicated.

- `SPACE` — defer the current site. It is recorded OPERATOR_DEFERRED (not completed, not permanently skipped) and stays eligible on a later run; the worker moves to the next site.
- `R` — retry the current site from the top (bounded).
- `S` — permanently skip this exact person/site. Requires a `Y` confirmation. `SPACE` never does this.
- `H` — hand the current site to the human-handoff workflow.
- `P` — pause; press again to resume.
- `Q` — stop the worker after the current checkpoint (confirmed with `Y`). `Ctrl+C` still works for a checkpoint-safe stop.

A status line shows the current person, site, phase, attempt, elapsed time, and running counts. The terminal is always restored on exit, on error, and on signals. With no terminal (service/launchd) the hotkeys are simply unavailable and behaviour is unchanged.

Slow or briefly unreachable sites are not treated as broken: repeated load timeouts, DNS errors, connection errors, and HTTP 5xx are deferred to the retry queue and stay retryable across runs, only becoming a permanent failure once a wider ceiling (`retryCount` + `maxAutoDeferrals`) is exhausted.

## Automated intake and operations status

An authorized bot or local integration can place one or more validated signup requests in a private JSON or CSV file and ingest them without manually bridging data into the workbook:

~~~bash
npm run ingest -- --file /absolute/private/path/signup.json
npm run ingest -- --file /absolute/private/path/signups.csv
npm run status
npm run reconcile
~~~

The intake requires `requestId`, `firstName`, `lastName`, and `email`; other existing profile fields and a source label are optional. JSON may be one object or an array. CSV uses headers and supports common snake-case aliases. Malformed rows are reported by index without echoing private values; valid rows in the same batch continue. The request ID and normalized email make retries idempotent. Reusing a request ID with different data or an email belonging to another name fails closed. The private runtime ledger stores only a digest, request ID, person ID, result, source label, and timestamp—not profile values—and is included in operational backups.

`npm run status` prints a machine-readable operations dashboard covering queued/active/completed profiles, attempt states, human handoffs, retry backlog, stale work, reconciliation mismatches, site health, and the browser actually selected on this Mac. It is read-only and exits nonzero when the browser is unavailable or reconciliation needs attention. Host monitoring can atomically cache the same secret-free payload with `npm run status -- --output /path/to/mag-status.json`.

Press Ctrl+C once for a checkpoint-safe stop. During human handoff, type q to stop. A completed pair can be reset only with the exact explicit command documented in the workbook guide.

## Human handoff

MAG pauses for:

- CAPTCHA, browser challenges, OTP, SMS, and email verification.
- Social Security, TIN/tax ID, government ID, driver license, passport, banking, routing, card, CVV, PIN, security-answer, biometric, and other restricted data.
- Required file uploads, unknown required fields, and required consent choices.
- Password fields outside a confident registration flow.
- Ambiguous final controls or ambiguous post-submit pages.

While status is WAITING FOR HUMAN, MAG observes navigation, form and field signatures, headings, validation messages, confirmation text, and account/dashboard evidence. URL change alone never proves success. Validation errors never become COMPLETED.

## Automatic final submission and consent

MAG may click Submit, Register, Create Account, Complete Registration, Finish, Sign Up, Join, or Create Profile only when the page is confidently a registration flow and every safety gate passes. Next and Continue are treated as progression controls.

Optional marketing email, SMS, newsletter, partner promotion, promotional contact, and data-sharing boxes remain unchecked. Required or ambiguous legal consent is an operator decision.

A form is not considered safe just because its fields already hold values. Before a final submit, MAG checks any pre-populated recognized field against the active person: a clear mismatch on email, name, phone, ZIP, or state stops automatic submission and hands off for review. A final control is also never clicked unless the flow has filled or confirmed a matching email, or a matching first and last name.

Use a supervised dry run when evaluating a new site set:

~~~powershell
$env:DRY_RUN="true"
npm start
~~~

On macOS:

~~~bash
DRY_RUN=true npm start
~~~

## Adding people, sites, and fields

Adding populated People rows or Site URLs requires no source change. Reconciliation assigns missing durable IDs and registers new combinations while preserving old history.

The local field registry describes canonical fields, aliases, autofill permission, sensitivity, transformations, and context restrictions. A newly added People column that matches an approved registry entry is recognized. An unknown header prints NEW FIELD REQUIRES MAPPING with the exact column name and is not guessed. Restricted semantics always override registry discovery.

To request a new mapping, provide the workbook header, example website labels, desired source column, formatting rules, and any exclusions. Review and test the registry entry before enabling autofill.

## Backups, restore, and moving computers

Create a portable timestamped backup:

~~~bash
npm run backup
~~~

Restore the newest local backup interactively, or name one:

~~~bash
npm run restore
npm run restore -- --file "/path/to/MAG-Backup-date.zip"
~~~

Restore requires explicit confirmation before replacing existing local data. Backups contain the workbook, field registry, local installation metadata, reconciliation hashes, and application version. Browser profiles are excluded because they can contain cookies and authentication material.

The same backup format is usable Windows to Windows, Mac to Mac, Windows to Mac, and Mac to Windows. Clone and set up the target computer, transfer the backup securely, restore, run npm run doctor, verify the workbook and ledger, then start. Browser sessions normally must be re-established. See [Migration](docs/MIGRATION.md) and [Backup and restore](docs/BACKUP_RESTORE.md).

## Updating safely

The live workbook resides in the OS local data directory or MAG_WORKBOOK_PATH, not in the repository. Before updating:

~~~bash
npm run backup
git pull --ff-only
npm install
npm run setup
npm run doctor
~~~

Do not copy a repository workbook over local data. npm run init preserves an existing workbook.

## Configuration

Copy .env.example to .env only for local, non-secret overrides. Important settings include MAG_WORKBOOK_PATH, MAG_DATA_DIR, MAG_FIELD_REGISTRY_PATH, browser channel, headed mode, WORKER_COUNT, tiered navigation timeouts, retry delays, site delays, retry cap, dry run, and safe screenshots. WORKER_COUNT is a runtime setting independent of the serialized browser-test runner; the default is 1, and higher values process multiple selected people concurrently in Process All mode. Default local data roots are:

- Windows: LocalAppData\MAG-Automation
- macOS: ~/Library/Application Support/MAG-Automation
- Other Unix-like systems: XDG_DATA_HOME/MAG-Automation or ~/.local/share/MAG-Automation

The default navigation policy uses 30 seconds initially, 60 seconds on retry, two retries, and a 4-second retry delay. A timeout is followed by DOM inspection; usable content continues instead of becoming falsely invalid.

## Troubleshooting

- Workbook open or locked: close Excel and any other MAG process; then rerun doctor.
- Chrome not found: run npm run setup:chromium and leave BROWSER_CHANNEL blank to use Playwright Chromium.
- Unsupported Node: install Node 22 or 24 LTS, reopen the terminal, and rerun npm install.
- Playwright browser missing: run npm run setup:chromium.
- Permission denied: move the data directory to a writable user location or grant the terminal access to that folder.
- Site timeout: let tiered retries finish; temporary failures remain retryable.
- Workbook schema problem: compare all four sheet names and required headers with the clean template.
- Unknown field: review the printed header and add an approved registry mapping with tests.
- Stale browser profile: back up first, stop MAG, and move only the affected local profile aside; do not commit it.
- Failed npm install: confirm Node and disk space, then remove only the local node_modules folder and rerun npm install.

See [Troubleshooting](docs/TROUBLESHOOTING.md) for detailed recovery.

## Privacy and security

- Never commit a live workbook, .env file, browser profile, log, screenshot, backup, lock file, credential file, or secret.
- Password, DOB, and income values are registered for redaction and are never intentionally logged.
- Sensitive-field classification runs before ordinary field matching.
- Local operational data remains outside Git history.
- Screenshots are off by default and are never taken after approved profile values are filled.
- Users are responsible for authorized, lawful use of target sites and for site terms and consent.

Run npm run safety:scan before sharing or committing. See [Security](docs/SECURITY.md).

## Validation

~~~bash
npm run typecheck
npm test
npm run build
npm audit
npm run safety:scan
npm run doctor
~~~

Automated browser tests use in-memory pages or a loopback server and do not contact live signup sites.

## More guides

- [Windows setup](docs/WINDOWS_SETUP.md)
- [macOS setup](docs/MACOS_SETUP.md)
- [Workbook guide](docs/WORKBOOK_GUIDE.md)
- [Migration](docs/MIGRATION.md)
- [Backup and restore](docs/BACKUP_RESTORE.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Security](docs/SECURITY.md)

The current licensing decision is documented in [LICENSE.md](LICENSE.md).
