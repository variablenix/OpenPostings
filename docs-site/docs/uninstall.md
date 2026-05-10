---
sidebar_position: 10
title: Uninstall OpenPostings
description: Remove OpenPostings from Windows and optionally clean local runtime data.
---

## Uninstall MSI-installed app (Windows)

Use either:

- `Settings > Apps > Installed apps > OpenPostings > Uninstall`, or
- `Control Panel > Programs and Features > OpenPostings > Uninstall`

![Windows uninstall process](/windows_uninstall_1.png)

Accept the UAC prompt if needed and follow the MSI uninstall wizard. 

![Windows uninstall process](/windows_uninstall_2.png)

## What uninstall removes

MSI uninstall removes installed program files, including:

- desktop app binary
- backend service worker payload
- optional MCP service payload
- Start Menu entry and desktop shortcut

## What may remain (optional cleanup)

Runtime data is stored per user in local app data. This can remain after uninstall.

Path:

- `%LOCALAPPDATA%\\OpenPostings\\backend`

Contains DB, PID files, and logs.

If you want a full cleanup, remove this folder manually after uninstall.

## Remove source-based setup

If you ran OpenPostings from source, stop running processes and remove project files:

1. Close OpenPostings and terminal processes (`npm run server`, `npm run web`, etc.).
2. Delete the local clone directory when you no longer need it.

## Post-uninstall verification

1. Confirm `OpenPostings` no longer appears in Installed Apps.
2. Confirm Start Menu shortcut is removed.
3. Confirm `%LOCALAPPDATA%\\OpenPostings\\backend` is removed if you performed full cleanup.
