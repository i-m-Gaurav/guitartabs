# TabVault – My Guitar Library

A personal guitar tabs manager: click a string, type the fret, chain techniques (`3h5p4`, `7b9r7`, `2/4\2`), organise songs into sections, and practise in a distraction-free full-screen mode.

Built with **Next.js**. The app itself is plain HTML/CSS/JavaScript in `public/`; the Next.js API route `app/api/songs/route.js` stores the library in MongoDB so it's the same on every device.

## How saving works

- **Always:** every change is saved instantly in the browser's LocalStorage, so the app works offline.
- **Online:** changes are pushed to MongoDB in the background, and the library is pulled + merged when the app opens, regains focus or comes back online. Offline edits sync automatically later.

MongoDB creates the `guitartabs` database (with a `songs` collection) the first time a song is saved.
The connection string lives **only** in environment variables on the server — never in `public/` (which is public).

## Deploy on Vercel

1. Import the GitHub repo in Vercel. **Framework Preset: Next.js** (if the project already exists, check Settings → Build and Deployment → Framework Preset is Next.js, with no custom Output Directory).
2. Project → **Settings → Environment Variables** (Production), add:
   - `MONGODB_URI` – your MongoDB connection string
   - `APP_PASSWORD` – a password of your choice (the app asks for it once per device)
3. Redeploy (environment variables only apply to new deploys).
4. In MongoDB Atlas → **Network Access**, allow `0.0.0.0/0` — Vercel's servers don't have fixed IP addresses.
5. Open `https://<your-site>/api/songs`: `{"error":"Password required"}` means it's working. Any other error message says what to fix.

Netlify also works: it detects Next.js automatically; set the same two environment variables.

## Run locally

```bash
cp .env.example .env   # then fill in MONGODB_URI and APP_PASSWORD
npm install
npm run dev            # http://localhost:3000
```

`.env` is git-ignored — never commit it.

## Files

| Path | Purpose |
| --- | --- |
| `public/index.html`, `public/style.css`, `public/script.js` | The app (served at `/`) |
| `app/api/songs/route.js` | API route: `GET` / `PUT` / `DELETE /api/songs` |
| `lib/songs.js` | MongoDB access, password check, validation, error messages |
| `next.config.mjs` | Serves `public/index.html` at `/` |
| `.env.example` | Environment variable template |
