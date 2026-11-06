'use strict';

/**
 * TabVault songs API — stores the song library in MongoDB.
 *
 * One implementation, three ways to run it:
 *   - Netlify:  netlify/functions/songs.js    (served at /api/songs via netlify.toml)
 *   - Vercel:   api/songs.js
 *   - Node:     server.js (local development, Render, Railway, a VPS…)
 *
 * Configuration comes from environment variables only, so the connection
 * string never appears in code that is sent to browsers:
 *
 *   MONGODB_URI   (required) MongoDB connection string
 *   APP_PASSWORD  (optional) if set, every request must send this password
 *   MONGODB_DB    (optional) database name; defaults to the one in the connection string
 *
 * Endpoints (all JSON):
 *   GET    /api/songs                     -> { songs: [...], serverTime }
 *   PUT    /api/songs  { songs: [...] }   -> upsert songs by id
 *   DELETE /api/songs  { ids: [...] }     -> delete songs by id
 */

const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SONGS_PER_REQUEST = 2000;
const MAX_SONG_BYTES = 1024 * 1024;

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

/* Reuse one connection across requests (and across warm serverless invocations). */
let clientPromise = null;

function connectionString() {
  return process.env.MONGODB_URI || '';
}

function getCollection() {
  const uri = connectionString();
  if (!uri) throw httpError(500, 'Server is missing the MONGODB_URI environment variable.');
  if (!clientPromise) {
    const client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 10000 });
    clientPromise = client.connect().catch((err) => {
      clientPromise = null; // allow a retry on the next request
      throw err;
    });
  }
  return clientPromise.then((client) => client.db(process.env.MONGODB_DB || undefined).collection('songs'));
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** Constant-time password check. With no APP_PASSWORD configured, the API is open. */
function isAuthorized(rawKey) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return true;
  let given = String(rawKey || '');
  try { given = decodeURIComponent(given); } catch (_) { /* use as-is */ }
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function parseJson(text) {
  if (text == null || text === '') return null;
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw httpError(413, 'Request too large');
  try { return JSON.parse(text); } catch (_) { throw httpError(400, 'Invalid JSON'); }
}

/** MongoDB field names must not start with "$" or contain "." */
function hasUnsafeKeys(value) {
  if (Array.isArray(value)) return value.some(hasUnsafeKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value).some((k) => k.startsWith('$') || k.includes('.') || hasUnsafeKeys(value[k]));
  }
  return false;
}

/** Light server-side validation; the app fully normalises songs when it loads them. */
function toDocument(song) {
  if (!song || typeof song !== 'object' || Array.isArray(song)) return null;
  if (typeof song.id !== 'string' || !song.id || song.id.length > 100) return null;
  if (typeof song.title !== 'string' || !song.title.trim()) return null;
  if (!Array.isArray(song.tabs)) return null;
  const { _id, id, ...rest } = song; // eslint-disable-line no-unused-vars
  if (hasUnsafeKeys(rest)) return null;
  if (Buffer.byteLength(JSON.stringify(rest)) > MAX_SONG_BYTES) return null;
  return { _id: id, ...rest };
}

const fromDocument = ({ _id, ...rest }) => ({ id: _id, ...rest });

/**
 * Platform-independent request handling.
 * @param {{ method: string, key: string|null, readBody: () => Promise<any> }} req
 * @returns {Promise<{ status: number, body: object, headers?: object }>}
 */
async function processRequest({ method, key, readBody }) {
  try {
    if (!isAuthorized(key)) return { status: 401, body: { error: 'Password required' } };

    if (method === 'GET') {
      const songs = await getCollection();
      const docs = await songs.find({}).toArray();
      return { status: 200, body: { songs: docs.map(fromDocument), serverTime: new Date().toISOString() } };
    }

    if (method === 'PUT') {
      const body = await readBody();
      const list = body && Array.isArray(body.songs) ? body.songs : null;
      if (!list) throw httpError(400, 'Expected { songs: [...] }');
      if (list.length > MAX_SONGS_PER_REQUEST) throw httpError(413, 'Too many songs in one request');
      const docs = list.map(toDocument);
      if (docs.some((d) => !d)) throw httpError(400, 'Invalid song data');
      if (docs.length) {
        const songs = await getCollection();
        await songs.bulkWrite(
          docs.map((doc) => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } })),
          { ordered: false },
        );
      }
      return { status: 200, body: { saved: docs.length } };
    }

    if (method === 'DELETE') {
      const body = await readBody();
      const ids = body && Array.isArray(body.ids) ? body.ids : null;
      if (!ids || ids.some((id) => typeof id !== 'string' || id.length > 100)) throw httpError(400, 'Expected { ids: [...] }');
      let deleted = 0;
      if (ids.length) {
        const songs = await getCollection();
        deleted = (await songs.deleteMany({ _id: { $in: ids } })).deletedCount;
      }
      return { status: 200, body: { deleted } };
    }

    return { status: 405, body: { error: 'Method not allowed' }, headers: { Allow: 'GET, PUT, DELETE' } };
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    if (status >= 500) console.error('[tabvault api]', err && err.message);
    // Known errors (missing config, bad input) are explained; unexpected ones stay generic.
    return { status, body: { error: err && err.status ? err.message : 'Database error — check the connection string and Atlas Network Access.' } };
  }
}

/* ---------- Adapter: Node req/res (server.js and Vercel) ---------- */
function readNodeBody(req) {
  // Vercel pre-parses JSON into req.body; plain Node does not.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
    return Promise.resolve().then(() => parseJson(String(req.body)));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(httpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(parseJson(Buffer.concat(chunks).toString('utf8'))); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

async function handler(req, res) {
  const result = await processRequest({
    method: req.method,
    key: req.headers['x-tabvault-key'],
    readBody: () => readNodeBody(req),
  });
  res.statusCode = result.status;
  Object.entries({ ...JSON_HEADERS, ...(result.headers || {}) }).forEach(([k, v]) => res.setHeader(k, v));
  res.end(JSON.stringify(result.body));
}

/* ---------- Adapter: Netlify Functions (AWS Lambda-style event) ---------- */
async function netlifyHandler(event) {
  const result = await processRequest({
    method: event.httpMethod,
    key: (event.headers || {})['x-tabvault-key'],
    readBody: async () => parseJson(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body),
  });
  return { statusCode: result.status, headers: { ...JSON_HEADERS, ...(result.headers || {}) }, body: JSON.stringify(result.body) };
}

module.exports = { handler, netlifyHandler, processRequest };
