/**
 * TabVault songs storage — MongoDB access used by app/api/songs/route.js.
 *
 * Configuration (environment variables only, never sent to the browser):
 *   MONGODB_URI   (required) MongoDB connection string
 *   APP_PASSWORD  (optional) if set, every request must send this password
 *   MONGODB_DB    (optional) database name; defaults to the one in the connection string
 */

import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SONGS_PER_REQUEST = 2000;
const MAX_SONG_BYTES = 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function connectionString() {
  // Tolerate values pasted into a dashboard with stray spaces or surrounding quotes.
  return String(process.env.MONGODB_URI || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

/* Reuse one connection across requests, warm serverless invocations and dev hot reloads. */
const cache = globalThis.__tabvaultMongo || (globalThis.__tabvaultMongo = { promise: null });

async function songsCollection() {
  const uri = connectionString();
  if (!uri) throw new HttpError(500, 'Server is missing the MONGODB_URI environment variable.');
  if (!cache.promise) {
    const client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 7000, connectTimeoutMS: 7000 });
    cache.promise = client.connect().catch((err) => {
      cache.promise = null; // allow a retry on the next request
      throw err;
    });
  }
  const client = await cache.promise;
  return client.db(process.env.MONGODB_DB || undefined).collection('songs');
}

/** Constant-time password check. With no APP_PASSWORD configured, the API is open. */
export function isAuthorized(rawKey) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return true;
  let given = String(rawKey || '');
  try { given = decodeURIComponent(given); } catch { /* use as-is */ }
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function parseJson(text) {
  if (text == null || text === '') return null;
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large');
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON'); }
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

export async function listSongs() {
  const songs = await songsCollection();
  return (await songs.find({}).toArray()).map(fromDocument);
}

export async function saveSongs(body) {
  const list = body && Array.isArray(body.songs) ? body.songs : null;
  if (!list) throw new HttpError(400, 'Expected { songs: [...] }');
  if (list.length > MAX_SONGS_PER_REQUEST) throw new HttpError(413, 'Too many songs in one request');
  const docs = list.map(toDocument);
  if (docs.some((d) => !d)) throw new HttpError(400, 'Invalid song data');
  if (docs.length) {
    const songs = await songsCollection();
    await songs.bulkWrite(
      docs.map((doc) => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } })),
      { ordered: false },
    );
  }
  return docs.length;
}

export async function deleteSongs(body) {
  const ids = body && Array.isArray(body.ids) ? body.ids : null;
  if (!ids || ids.some((id) => typeof id !== 'string' || id.length > 100)) throw new HttpError(400, 'Expected { ids: [...] }');
  if (!ids.length) return 0;
  const songs = await songsCollection();
  return (await songs.deleteMany({ _id: { $in: ids } })).deletedCount;
}

/** Short technical detail for error messages, with any credentials removed. */
function errorDetail(err) {
  const name = (err && (err.codeName || err.name)) || 'Error';
  const msg = String((err && err.message) || '').replace(/\/\/[^\s/@]*@/g, '//***@').slice(0, 180);
  return ` [${name}: ${msg}]`;
}

/** Turn any error into an HTTP status and a message that says what to fix. */
export function describeError(err) {
  if (err instanceof HttpError) return { status: err.status, message: err.message };
  const name = (err && err.name) || '';
  const msg = String((err && err.message) || '');
  let hint = 'Database error — check MONGODB_URI and Atlas Network Access.';
  if (/querySrv ENOTFOUND|querySrv ENODATA/i.test(msg)) {
    hint = 'The cluster address in MONGODB_URI was not found — copy the connection string again from Atlas (Connect → Drivers).';
  } else if (/querySrv/i.test(msg)) {
    hint = 'The server could not look up the MongoDB cluster address (DNS).';
  } else if (name === 'MongoParseError' || /Invalid scheme|URI must include|Invalid connection string|must be URL encoded/i.test(msg)) {
    hint = 'MONGODB_URI is not a valid connection string — copy it again from Atlas (Connect → Drivers) and replace <password>.';
  } else if ((err && err.code === 18) || /bad auth|Authentication failed/i.test(msg)) {
    hint = 'MongoDB rejected the username/password in MONGODB_URI — check the database user in Atlas → Database Access.';
  } else if (name === 'MongoServerSelectionError' || /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|timed out|whitelist/i.test(msg)) {
    hint = 'Can\'t reach MongoDB — check Atlas → Network Access allows 0.0.0.0/0 and the cluster is not paused.';
  }
  return { status: 500, message: hint + errorDetail(err) };
}
