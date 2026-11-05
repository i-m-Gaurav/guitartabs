'use strict';

/**
 * TabVault songs API — stores the song library in MongoDB.
 *
 * Shared by the Vercel serverless function (api/songs.js) and the standalone
 * Node server (server.js). Configuration comes from environment variables only,
 * so the connection string never appears in code that is sent to browsers:
 *
 *   MONGODB_URII   (required) MongoDB connection string
 *   APP_PASSWORD  (optional) if set, every request must send this password
 *   MONGODB_DB    (optional) database name; defaults to the one in MONGODB_URII
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

/* Reuse one connection across requests (and across warm serverless invocations). */
let clientPromise = null;

function getCollection() {
  const uri = process.env.MONGODB_URII;
  if (!uri) throw httpError(500, 'Server is missing the MONGODB_URII environment variable.');
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

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Constant-time password check. With no APP_PASSWORD configured, the API is open. */
function isAuthorized(req) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return true;
  let given = String(req.headers['x-tabvault-key'] || '');
  try { given = decodeURIComponent(given); } catch (_) { /* use as-is */ }
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Read a JSON body — Vercel pre-parses it into req.body; plain Node does not. */
function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
    try { return Promise.resolve(JSON.parse(String(req.body) || 'null')); } catch (_) { return Promise.reject(httpError(400, 'Invalid JSON')); }
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
      if (!chunks.length) { resolve(null); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(httpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
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

async function handler(req, res) {
  try {
    if (!isAuthorized(req)) { send(res, 401, { error: 'Password required' }); return; }

    if (req.method === 'GET') {
      const songs = await getCollection();
      const docs = await songs.find({}).toArray();
      send(res, 200, { songs: docs.map(fromDocument), serverTime: new Date().toISOString() });
      return;
    }

    if (req.method === 'PUT') {
      const body = await readJson(req);
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
      send(res, 200, { saved: docs.length });
      return;
    }

    if (req.method === 'DELETE') {
      const body = await readJson(req);
      const ids = body && Array.isArray(body.ids) ? body.ids : null;
      if (!ids || ids.some((id) => typeof id !== 'string' || id.length > 100)) throw httpError(400, 'Expected { ids: [...] }');
      let deleted = 0;
      if (ids.length) {
        const songs = await getCollection();
        deleted = (await songs.deleteMany({ _id: { $in: ids } })).deletedCount;
      }
      send(res, 200, { deleted });
      return;
    }

    res.setHeader('Allow', 'GET, PUT, DELETE');
    send(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    if (status >= 500) console.error('[tabvault api]', err && err.message);
    send(res, status, { error: status >= 500 && !err.status ? 'Database error' : err.message });
  }
}

module.exports = { handler };
