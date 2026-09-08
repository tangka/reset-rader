# Reset Radar · Codex Plugin

English | [简体中文](README.zh-CN.md)

Developer: 唐卡/Tangka

See your Codex weekly quota usage, reset countdown, and personal reset probability for the next 24 hours. On Windows, Reset Radar opens a native floating card; on macOS it can optionally appear inside the Codex main window.

This is a standalone plugin repository. You do not need the Reset Radar Mini Program source, collector, or backend. Data is provided by the Reset Radar member API.

## Requirements

- **Node.js 22 or later**, with `node` available in your terminal. `npm` is only needed for development checks.
- Your own signed-in Codex account. On macOS, weekly quota queries can use the executable bundled with Codex desktop; on Windows, make sure `codex` is on `PATH` or set `RESET_RADAR_CODEX_PATH` to an absolute `codex.exe` path. Installation commands need a Codex executable that supports `plugin`.
- A valid **long-term member API key** from the Reset Radar WeChat Mini Program. Monthly membership does not include API access. Each person must use their own key.
- Regular queries and monitoring are supported on Windows, macOS, and Linux. On **Windows**, the card is a native local window and does not require a Codex restart or debugging port. The optional macOS in-Codex card uses an unofficial CDP debugging connection; app updates may break that macOS mode.

## Installation

### From GitHub

Run these commands in your terminal:

```bash
codex plugin marketplace add https://github.com/tangka/reset-rader.git
codex plugin add reset-radar@reset-radar
```

If `codex` is not on your PATH, you can run the same commands with the desktop app's bundled executable. For `/Applications/Codex.app`:

```bash
"/Applications/Codex.app/Contents/Resources/codex" plugin marketplace add https://github.com/tangka/reset-rader.git
"/Applications/Codex.app/Contents/Resources/codex" plugin add reset-radar@reset-radar
```

If your Codex desktop bundle is named `ChatGPT.app` instead, use its actual path:

```bash
"/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace add https://github.com/tangka/reset-rader.git
"/Applications/ChatGPT.app/Contents/Resources/codex" plugin add reset-radar@reset-radar
```

Use the bundle that is actually installed; a matching filename alone does not establish that it is Codex. You can substitute the same quoted executable path for `codex` in the local installation and update commands below.

The repository is [tangka/reset-rader](https://github.com/tangka/reset-rader). Both the plugin and marketplace identifiers are `reset-radar`. The repository is public, but the member API still requires your own key.

Installation uses the [official Codex marketplace commands](https://learn.chatgpt.com/docs/developer-commands#codex-plugin-marketplace). There is no need to copy Skill files manually or run a remote installation script.

### From a local copy

After extracting or cloning the repository, run these commands from its **root directory**:

```bash
codex plugin marketplace add .
codex plugin add reset-radar@reset-radar
```

After installation, start a new Codex task and select the Reset Radar (`重置雷达`) plugin, or ask:

> Use the Reset Radar plugin to open the floating radar.

Installing the plugin does not automatically start the card or scheduled reminders. If you previously installed a personal version with the same name, disable that older copy in Codex plugin management to avoid enabling both.

## First launch and API key setup

Check `node --version` in the terminal you will use to launch the plugin. On macOS, weekly quota queries automatically look for a running Codex desktop app and then common locations under `/Applications` and `~/Applications`, validate the bundle identifier `com.openai.codex`, and use its `Contents/Resources/codex`. On Windows and Linux, the plugin uses `codex` on `PATH`.

For a custom installation, set `RESET_RADAR_CODEX_APP` to the absolute `.app` path, or `RESET_RADAR_CODEX_PATH` to an absolute executable path. An invalid explicit override produces an error instead of silently falling back. These settings select the weekly quota reader; they do not change the floating card's CDP discovery or launch path support.

From a local repository, inspect which executable would be selected without reading your account or calling an API:

```bash
node plugins/reset-radar/skills/reset-radar/scripts/codex-runtime.mjs
```

The diagnostic prints the selected source and command. Finding an executable does not establish account login or compatibility with the required app-server protocol; a personal quota query must still succeed.

1. On Windows, start the native card directly with `overlay start`; it does not restart Codex or enable a debugging endpoint. On macOS, the plugin checks whether the current Codex app exposes a compatible local debugging endpoint. If not, it explains the risks. **Only with your consent**, you can quit Codex normally and relaunch it in debugging mode from an external terminal.
2. Once the card is connected, paste your member API key into its password field and click **Save and connect** (`保存并连接`). Do not paste the key into chat.
3. The card displays your personal probability, extra reset probability, weekly reset countdown, and used/remaining percentages. Click `↻` to refresh, `−` to collapse, or `×` to close. To reopen it, ask Codex to open the floating radar again.

The data bridge process must stay running. Closing its terminal, quitting Codex, or reloading the page may stop the card; the plugin will not silently restart it. If the floating card is unavailable, you can still make a regular query:

> Use the Reset Radar plugin to check my Codex weekly quota and personal reset probability.

If you use regular queries without the floating card, configure your key in the terminal. Copy your key, then run this command yourself from the repository root. The key is passed through standard input, not command-line arguments:

```bash
pbpaste | node plugins/reset-radar/skills/reset-radar/scripts/reset-radar.mjs configure --key-stdin
```

On Windows PowerShell, use:

```powershell
Get-Clipboard | node plugins/reset-radar/skills/reset-radar/scripts/reset-radar.mjs configure --key-stdin
```

See the [detailed plugin guide (Chinese)](plugins/reset-radar/README.md) for more commands, debugging setup, error handling, and reminders.

### Windows native floating card (local repository)

```powershell
node plugins/reset-radar/skills/reset-radar/scripts/reset-radar.mjs overlay doctor
node plugins/reset-radar/skills/reset-radar/scripts/reset-radar.mjs overlay start
```

Keep the terminal process running while the card is open. The first load refreshes immediately while respecting a server `429` retry deadline. The card receives only display values from the local Node bridge; it never receives the saved API key.

### Manual macOS floating-card launch from an external terminal (local repository)

From the repository root, check the current connection:

```bash
node plugins/reset-radar/skills/reset-radar/scripts/reset-radar.mjs overlay doctor
```

If no debugging endpoint is available, read the risks above and decide whether to enable it. Save your work and quit Codex normally before running this command in an **external terminal**:

```bash
node plugins/reset-radar/skills/reset-radar/scripts/reset-radar.mjs overlay launch
```

Only after the launch check succeeds, use the actual `port` and `targetId` from its output in the following commands. Replace the placeholders below with those values; do not reuse someone else's port or window ID:

```bash
node plugins/reset-radar/skills/reset-radar/scripts/reset-radar.mjs overlay doctor --port PORT_FROM_OUTPUT --target TARGET_ID_FROM_OUTPUT
node plugins/reset-radar/skills/reset-radar/scripts/reset-radar.mjs overlay start --port PORT_FROM_OUTPUT --target TARGET_ID_FROM_OUTPUT
```

Keep the final terminal process running. If the initial check already succeeded, start the card using the detected port and target without quitting or relaunching Codex. Stop if a check fails; do not bypass debugging restrictions imposed by the app.

## Data and permissions

- Your key is saved locally at `~/.config/reset-radar/api-key` with file permissions `600` on macOS/Linux, or under `%LOCALAPPDATA%\\reset-radar\\api-key` on Windows. It is sent only to the configured member API for authentication. Do not share, commit, or bundle your key.
- Personal usage and reset times come from a local, read-only Codex interface and are not uploaded to the radar API. Only the general Codex weekly quota is used; model-specific quotas are not monitored.
- The radar supplies extra reset probability **excluding the natural reset cycle**. If your weekly quota is scheduled to reset naturally within the next 24 hours, your personal probability is 100%; otherwise, it uses the extra reset probability. This is a schedule-based estimate, not confirmation that an extra reset has happened. Missing or expired data is shown as unavailable.
- Automatic refresh runs every 10 minutes by default. Requests share an account-level limit of 30 requests per 10 minutes and 2 concurrent requests. Manual refresh also respects HTTP 429 waiting periods. Rotating your key does not reset your account's allowance.
- Refreshing the floating card does not run model inference. If you explicitly ask Codex to schedule reminders, those Codex tasks may consume model usage.
- Debugging mode increases the ability of other local processes to access Codex. Use it only on a trusted computer. Quit and reopen Codex normally to end the debugging session.

## Updating

After an update is published, users who installed from Git can run:

```bash
codex plugin marketplace upgrade reset-radar
codex plugin add reset-radar@reset-radar
```

If you installed from a local directory, obtain the updated copy first and run the installation commands again. Start a new task after updating. Close and reopen any existing floating card; the plugin does not automatically interrupt your current session.

## Development and verification

There are no third-party runtime dependencies, so `npm install` is not required:

```bash
npm test
npm run check
```

Tests are discovered automatically and use local test services and explicit test keys. Passing tests does not establish compatibility with another computer or every Codex version. Distribute only this repository, never personal `.config` files, `.env` files, or user data.

Git distribution is separate from inclusion in the official Codex plugin directory. This project does not claim to have passed an official directory review.
