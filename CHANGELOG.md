# Changelog

## Unreleased

- Validate Windows private-file owners and ACLs on reads and writes, reject unsafe custom paths, and create replacement files with private permissions before writing data.
- Add real Windows ACL regression checks alongside the existing cross-platform tests.
- Normalize `Path` aliases only on Windows, preserving case-sensitive macOS/Linux environments and keeping Radar credentials out of the quota reader.
- Avoid rewriting native Windows display files for heartbeat-only timestamp changes; countdowns continue locally and meaningful updates still propagate.

## 0.1.2 - 2026-09-08

- Add a native Windows floating Reset Radar card with drag, collapse, close, manual refresh, and live weekly-quota calculations.
- Start the Windows card without restarting Codex or enabling a debugging port; the card receives only safe display fields from the local Node bridge.
- Make the first Windows card load an immediate, rate-limit-aware refresh and accept the UTF-8 BOM emitted by Windows PowerShell refresh commands.

## 0.1.1 - 2026-09-08

- Add Windows support for regular Reset Radar queries and monitoring.
- Store the Windows local Key and state under `LOCALAPPDATA`, and use Windows-compatible private-file checks.
- Preserve the Windows `Path` environment when starting the read-only Codex app-server reader.
- Keep the nonofficial in-Codex floating card macOS-only.
