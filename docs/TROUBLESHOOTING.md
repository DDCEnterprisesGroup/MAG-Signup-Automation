# Troubleshooting

## Workbook open or locked

Close Excel and other MAG terminals. Run npm run doctor. If a lock marker remains after a crash, doctor reports it; a new WorkbookStore session removes only a stale lock whose process no longer exists.

## Chrome or Playwright browser missing

Run npm run setup:chromium. Set BROWSER_CHANNEL to blank to use bundled Chromium. Re-run setup and doctor.

## Node version

Install Node 22 or 24 LTS from the official Node site, restart the terminal, run npm install, and rerun doctor.

## Permission denied

Ensure the local data path belongs to the current user and is not read-only. On macOS, grant Terminal access only to the selected workbook directory. On Windows, avoid protected system folders and network shares that do not support atomic replacement.

## Site timeout

MAG uses an initial timeout, longer retry timeout, retry delay, and usable-DOM inspection. TEMP FAILURE remains retryable. Repeated DNS, HTTP, or access errors are categorized in Site Issues.

## Workbook schema

All four sheet names must be exact. Required system headers must not be renamed. Compare with the clean template. Older workbooks without the four optional v1.1 profile columns remain readable; add the exact new headers when those values are needed.

## Unknown field

Record the exact printed header and target-site labels. Do not add a guessed alias. Update the registry only with a reviewed permission, sensitivity class, transformation, context restriction, and regression tests.

## Stale browser profile

Back up first. Stop MAG. Move only the affected person's local browser profile aside so it is recoverable, then restart. Expect to repeat site login or verification.

## Failed npm install

Check Node, npm, internet access to npm, and disk space. Remove only this repository's node_modules directory, then rerun npm install. Do not delete local MAG data.

## Ambiguous completion

An unfamiliar redirect can remain WAITING FOR HUMAN even after manual Submit. Verify the site result in the browser. Press Enter to request a fallback re-scan only after you have confirmed the page state.
