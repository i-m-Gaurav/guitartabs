'use strict';

/**
 * Standalone server for TabVault: serves the app and the /api/songs endpoint.
 * Use it locally (`npm start`) or on hosts that run a Node process (Render, Railway, a VPS…).
 * On Vercel you don't need this file — api/songs.js is used instead.
 *
 * Reads settings from environment variables, or from a local .env file:
 *   MONGODB_URI=...   APP_PASSWORD=...   PORT=3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

loadEnvFile(path.join(__dirname, '.env'));
const { handler } = require('./lib/songs-api');

const PORT = Number(process.env.PORT) || 3000;

// Only these files are ever served — never .env, server code or node_modules.
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/script.js': ['script.js', 'application/javascript; charset=utf-8'],
};

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/songs') { handler(req, res); return; }

  const entry = STATIC_FILES[pathname];
  if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  fs.readFile(path.join(__dirname, entry[0]), (err, data) => {
    if (err) { res.statusCode = 500; res.end('Server error'); return; }
    res.setHeader('Content-Type', entry[1]);
    res.setHeader('Cache-Control', 'no-cache');
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

server.listen(PORT, () => {
  console.log(`TabVault running at http://localhost:${PORT}`);
  if (!process.env.MONGODB_URI) console.warn('Warning: MONGODB_URI is not set — the app will work offline only.');
  if (!process.env.APP_PASSWORD) console.warn('Note: APP_PASSWORD is not set — anyone who can reach this server can edit your songs.');
});

/** Minimal .env loader (KEY=VALUE per line). Existing environment variables win. */
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
