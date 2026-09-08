# Reset Radar · Codex Plugin

English | [简体中文](README.zh-CN.md)

Developer: 唐卡/Tangka

See your Codex weekly quota usage, reset countdown, and personal reset probability for the next 24 hours. A floating card inside the Codex main window lets you configure your API key and refresh the data without leaving the card.

This is a standalone plugin repository. You do not need the Reset Radar Mini Program source, collector, or backend. Data is provided by the Reset Radar member API.

## Requirements

- **Node.js 22 or later**, with `node`, `npm`, and `codex` available in your terminal.
- Your own signed-in Codex account and a Codex CLI that supports `codex plugin`.
- A valid **long-term member API key** from the Reset Radar WeChat Mini Program. Monthly membership does not include API access. Each person must use their own key.
- The floating card has only been verified with **Codex desktop on macOS**. It uses an unofficial CDP debugging connection, not an official overlay component. App updates may break it; Windows, Linux, and compatibility with every Codex version are not guaranteed.

## Installation

### From GitHub

Run these commands in your terminal:

```bash
codex plugin marketplace add https://github.com/tangka/reset-rader.git
codex plugin add reset-radar@reset-radar
```

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

Check `node --version` and `codex --version` in the terminal you will use to launch the plugin. Both commands must be on that terminal's PATH; installing the desktop app alone does not guarantee that the `codex` command is available.

1. The plugin checks whether the current Codex app exposes a compatible local debugging endpoint. If not, it explains the risks. **Only with your consent**, you can quit Codex normally and relaunch it in debugging mode from an external terminal. The plugin does not automatically kill processes, modify the app bundle, or disable security features.
2. Once the card is connected, paste your member API key into its password field and click **Save and connect** (`保存并连接`). Do not paste the key into chat.
3. The card displays your personal probability, extra reset probability, weekly reset countdown, and used/remaining percentages. Click `↻` to refresh, `−` to collapse, or `×` to close. To reopen it, ask Codex to open the floating radar again.

The data bridge process must stay running. Closing its terminal, quitting Codex, or reloading the page may stop the card; the plugin will not silently restart it. If the floating card is unavailable, you can still make a regular query:

> Use the Reset Radar plugin to check my Codex weekly quota and personal reset probability.

If you use regular queries without the floating card, configure your key in the terminal. Copy your key, then run this command yourself from the repository root. The key is passed through standard input, not command-line arguments:

```bash
pbpaste | node plugins/reset-radar/skills/reset-radar/scripts/reset-radar.mjs configure --key-stdin
```

See the [detailed plugin guide (Chinese)](plugins/reset-radar/README.md) for more commands, debugging setup, error handling, and reminders.

### Manual launch from an external terminal (local repository)

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

- Your key is saved locally at `~/.config/reset-radar/api-key` with file permissions `600`. It is sent only to the configured member API for authentication. Do not share, commit, or bundle your key.
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
