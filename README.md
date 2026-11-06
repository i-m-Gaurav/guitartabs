# TabVault – My Guitar Library

A personal guitar tabs manager: click a string, type the fret, chain techniques (`3h5p4`, `7b9r7`, `2/4\2`), organise songs into sections, and practise in a distraction-free full-screen mode.

Plain HTML, CSS and JavaScript on the front end. Songs are saved in the browser (so it works offline) and synced to MongoDB through a small API (`/api/songs`) so the library is the same on every device.

## How saving works

- **Always:** every change is saved instantly in the browser's LocalStorage.
- **When opened from your website:** changes are also pushed to MongoDB in the background, and the library is pulled + merged when the app opens, regains focus or comes back online. Offline edits sync automatically later.
- **When `index.html` is opened as a local file:** browser-only (no sync).

The MongoDB connection string lives **only** in environment variables on the server. It is never in the front-end code (anything in `script.js` is public).

## Deploy on Netlify

`netlify.toml` already configures everything: the app is published from `dist/`, and `netlify/functions/songs.js` is served at `/api/songs`.

1. Netlify → your site → **Site configuration → Environment variables**, add:
   - `MONGODB_URI` – your MongoDB connection string
   - `APP_PASSWORD` – a password of your choice (the app asks for it once per device)
2. Push to GitHub (or **Deploys → Trigger deploy → Deploy site**). Environment variables only apply to new deploys.
3. In MongoDB Atlas → **Network Access**, allow access from anywhere (`0.0.0.0/0`) — Netlify's servers don't have fixed IP addresses.
4. Check `https://<your-site>/api/songs` in a browser: `{"error":"Password required"}` means it's working.

## Deploy on Vercel

1. Import the GitHub repo in Vercel (Framework preset: **Other**, no build command).
2. Project → **Settings → Environment Variables**, add:
   - `MONGODB_URI` – your MongoDB connection string
   - `APP_PASSWORD` – a password of your choice (the app asks for it once per device)
3. Redeploy. The app is served from the repo root and `api/songs.js` becomes `/api/songs`.
4. In MongoDB Atlas → **Network Access**, allow access from anywhere (`0.0.0.0/0`), because Vercel's servers don't have fixed IP addresses.

## Deploy anywhere that runs Node (Render, Railway, a VPS…)

```bash
npm install
MONGODB_URI="..." APP_PASSWORD="..." npm start   # serves the app + API on $PORT (default 3000)
```

## Run locally

```bash
cp .env.example .env   # then fill in MONGODB_URI and APP_PASSWORD
npm install
npm start              # http://localhost:3000
```

`.env` is git-ignored — never commit it.

## Files

| Path | Purpose |
| --- | --- |
| `index.html`, `style.css`, `script.js` | The app |
| `api/songs.js` | Vercel serverless function |
| `lib/songs-api.js` | API logic shared by Vercel and `server.js` (MongoDB access, password check, validation) |
| `server.js` | Standalone Node server (static files + API) |
| `.env.example` | Environment variable template |
