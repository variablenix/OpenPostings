---
sidebar_position: 2
title: Install (MSI and Source)
description: Install OpenPostings using the Windows MSI installer or from source.
---

## Android Option: Android APK Installer and Google Store Beta 
You can download the latest app from the github releases page and run it. 

- https://github.com/Masterjx9/OpenPostings/releases/download/v1.0.7/app-release.apk

If you would like to one of the beta testers to help get this on the google play store, fill out this form: https://docs.google.com/forms/d/e/1FAIpQLSdVGhp667EiEB3Cxxc4KA8GTZzZ1CHtiAql4AOIA076W4RYsg/viewform?usp=dialog Within 24 hours you will receive an email confirming that your google account has been added to the closed beta and it will give you the access url to access the beta directly on your Android device. 

## Windows Option: Windows MSI installer (Easiest Setup But Still WIP and may have some bugs)

### 1. Download installer

Get the latest `.msi` from the GitHub Releases page:

- `https://github.com/Masterjx9/OpenPostings/releases`

### 2. Run the installer

Launch the MSI and follow the setup wizard.

During setup, choose one of these install types:

- `Typical`: Desktop app + backend service worker (recommended for most users).
- `Complete`: Desktop app + backend service worker + MCP Apply Agent Server (AI Service Engine).
- `Custom`: Pick exactly which features to install.

![Windows setup type selection](/windows_setup_type.png)

### 3. Finish and launch

After install, launch `OpenPostings` from Start Menu or desktop shortcut.

### 4. What gets installed

Default install location:

- `C:\Program Files\OpenPostings`

Feature payloads:

- Desktop app executable: `openpostings.exe`
- Backend service worker files: `backend\...`
- Optional MCP AI engine files: `mcp\...` (if Complete/Custom includes MCP)

### 5. Startup behavior

If backend service worker is installed, the installer writes a startup entry that launches the backend tray process on sign-in.

## Source Option: Run from source (Best Stability & Compatibility)

### Requirements

- Node.js `18+` and npm
- Windows target support: React Native Windows prerequisites
- Optional Android support: Android Studio/emulator/device

### Install dependencies

From the repository root (`OpenPostings`):

```powershell
npm install
```

### Run backend API

```powershell
npm run server
```

### Run web app

In a second terminal:

```powershell
npm run web
```

Open:

- `http://localhost:8081`

![MSI download page](/webui2.png)

API defaults:

- Web/Windows: `http://localhost:8787`
- Android (on-device backend): `http://127.0.0.1:8787`

### Run Windows or Android client

```powershell
npm run windows
npm run android
```

### Run MCP apply-agent server (optional)

```powershell
npm run mcp:apply-agent
```

## Verify the install

After launch, confirm backend health:

- `http://localhost:8787/health`

You should receive a JSON response with `ok: true`.

