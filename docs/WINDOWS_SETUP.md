# Windows setup

## Clean installation

1. Download and install a current LTS release from [Node.js](https://nodejs.org/en/download).
2. Install [Git for Windows](https://git-scm.com/downloads/).
3. Optionally install [Google Chrome](https://www.google.com/chrome/). MAG can instead use Playwright Chromium.
4. Restart PowerShell and verify:

~~~powershell
node --version
npm --version
git --version
~~~

Node must be version 22 or newer.

5. Clone the repository:

~~~powershell
git clone https://github.com/DDCEnterprisesGroup/MAG-Signup-Automation.git
cd MAG-Signup-Automation
~~~

6. Install and initialize:

~~~powershell
npm install
npm run setup
npm run init
npm run doctor
~~~

Every required doctor item should report PASS before production use. A WARNING should be read and resolved when it applies to workbook safety or disk space.

7. Open the workbook path shown by init, enter people and sites, save, close Excel, and start:

~~~powershell
npm start
~~~

## Browser choice

The default channel is installed Google Chrome. If Chrome is not available:

~~~powershell
npm run setup:chromium
$env:BROWSER_CHANNEL=""
npm start
~~~

To make that override persistent for the project, copy .env.example to .env and leave BROWSER_CHANNEL blank. Never place credentials in .env.

## Local data

Unless MAG_DATA_DIR or MAG_WORKBOOK_PATH is set, operational data resides below LocalAppData\MAG-Automation. It is separate from the Git checkout. Excel should be closed while MAG writes.

## Updating

~~~powershell
npm run backup
git pull --ff-only
npm install
npm run setup
npm run doctor
~~~

If PowerShell blocks the optional setup script, run its documented ExecutionPolicy Bypass command for that invocation only rather than changing machine-wide policy.
