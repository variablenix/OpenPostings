---
sidebar_position: 3
title: Chrome Extension (For Capturing/Adding more companies to your app)
description: Capture the current tab URL and add it to OpenPostings as a seeded ATS company source.
---

The OpenPostings Chrome extension lets you quickly add the current tab URL into OpenPostings as a **seeded ATS company source**.

This extension is for seeded ATS sources only.

## What it does

- Reads the active tab URL
- Validates the URL against supported seeded ATS patterns
- Parses ATS + company identifier
- Lets you edit company name before save
- Inserts or updates the `companies` record through the local backend API

## Requirements

- OpenPostings backend running locally
- Google Chrome (or Chromium-based browser supporting MV3)

Start backend:

```powershell
cd OpenPostings
npm run server
```

NOTE: Or if you are using the Windows MSI installer version, just have your backend service set to `running`.

## Load the extension

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select:
   - `OpenPostings/chrome-extension/openpostings-seeded-url-capture`

## How to use it

1. Open a seeded ATS company board URL in a browser tab.
2. Click the extension icon.
3. Verify:
   - `Backend API URL` (default `http://localhost:8787`)
   - `Current / Source URL`
4. Click `Check URL`.
5. Confirm parsed values:
   - Match
   - ATS
   - Identifier
6. Edit `Company Name` if needed.
7. Click `Add to OpenPostings`.

If the URL already exists in `companies`, the extension updates the existing row (idempotent behavior).

![chrome extension](/chrome-extension_1.png)

## Seeded ATS examples

- Workday: `https://<subdomain>.wd*.myworkdayjobs.com/<companyPath>`
- Ashby: `https://jobs.ashbyhq.com/<orgSlug>`
- Greenhouse: `https://job-boards.greenhouse.io/<boardToken>`
- Greenhouse: `https://boards.greenhouse.io/<boardToken>`
- Lever: `https://jobs.lever.co/<organization>`
- iCIMS: `https://<tenant>.icims.com/jobs/search?...`
- BambooHR: `https://<tenant>.bamboohr.com/careers`
- It works for all 80+ ATSs!

## Troubleshooting

### `Failed to fetch`

- Confirm backend is running
- Confirm backend URL is correct in popup
- Confirm backend port is reachable (`http://localhost:8787/health`)

### URL rejected as unsupported

- URL may not be a seeded ATS company board URL
- URL may be a dynamic ATS source (blocked by design)

### `Check URL` works but no save

- Ensure `Company Name` is not empty
- Re-run `Check URL` if you changed `Current / Source URL`

## API endpoints used by extension

- `POST /extension/seeded-source/classify`
- `POST /extension/seeded-source/upsert`
