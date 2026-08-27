# macOS setup

## Direct installation

1. Install a current LTS release from [Node.js](https://nodejs.org/en/download).
2. Install [Git](https://git-scm.com/downloads/). macOS may offer Apple command-line tools when Git first runs.
3. Optionally install [Google Chrome](https://www.google.com/chrome/).
4. Open Terminal and verify Node 22 or newer:

~~~bash
node --version
npm --version
git --version
~~~

5. Clone, install, and initialize:

~~~bash
git clone https://github.com/DDCEnterprisesGroup/MAG-Signup-Automation.git
cd MAG-Signup-Automation
npm install
npm run setup
npm run init
npm run doctor
~~~

6. Edit the local workbook, save it, close Excel, and run npm start.

## Optional Homebrew route

Use this only if Homebrew is already installed:

~~~bash
brew install node@24 git
chmod +x scripts/setup-macos.sh
./scripts/setup-macos.sh
npm run init
npm run doctor
~~~

Homebrew is not required.

## Permissions

The default workbook is under ~/Library/Application Support/MAG-Automation. If a custom data path is under Desktop, Documents, Downloads, iCloud Drive, or an external volume, macOS may ask Terminal to access that folder. Approve only the required location. Normal Playwright browser control does not require macOS Accessibility permission.

If Chrome channel launch fails, run npm run setup:chromium and set BROWSER_CHANNEL to an empty value.

## Updates

Create a backup, pull with fast-forward only, reinstall dependencies, rerun setup, and finish with doctor. The local workbook is not replaced by repository updates.
