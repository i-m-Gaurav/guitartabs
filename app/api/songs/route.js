// TabVault songs API — https://<your-site>/api/songs
//   GET                      -> { songs: [...], serverTime }
//   PUT    { songs: [...] }  -> upsert songs by id
//   DELETE { ids: [...] }    -> delete songs by id

import { NextResponse } from 'next/server';
import { isAuthorized, parseJson, listSongs, saveSongs, deleteSongs, describeError } from '../../../lib/songs';

export const runtime = 'nodejs';        // the MongoDB driver needs Node, not the Edge runtime
export const dynamic = 'force-dynamic'; // never cache or pre-render this route
export const maxDuration = 30;

const NO_STORE = { 'Cache-Control': 'no-store' };

function json(body, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

async function handle(request, action) {
  try {
    if (!isAuthorized(request.headers.get('x-tabvault-key'))) return json({ error: 'Password required' }, 401);
    return json(await action());
  } catch (err) {
    const { status, message } = describeError(err);
    if (status >= 500) console.error('[tabvault api]', err);
    return json({ error: message }, status);
  }
}

export function GET(request) {
  return handle(request, async () => ({ songs: await listSongs(), serverTime: new Date().toISOString() }));
}

export function PUT(request) {
  return handle(request, async () => ({ saved: await saveSongs(parseJson(await request.text())) }));
}

export function DELETE(request) {
  return handle(request, async () => ({ deleted: await deleteSongs(parseJson(await request.text())) }));
}
