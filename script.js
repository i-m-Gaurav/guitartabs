'use strict';

/**
 * TabVault – My Guitar Library
 * A personal guitar tab manager. Vanilla JS, no dependencies.
 * All data lives in the browser's LocalStorage.
 *
 * Sections:
 *   1. Constants & state
 *   2. Utilities & icons
 *   3. Data model (normalisation / validation)
 *   4. Storage (songs, settings, draft)
 *   5. UI primitives (toasts, modals)
 *   6. Tab rendering (tablature + list)
 *   7. Router
 *   8. Views: dashboard, songs, recent, settings, song detail
 *   9. Song editor (the tab-entry system)
 *  10. Practice mode
 *  11. Song actions (delete, duplicate, copy)
 *  12. Import / export
 *  13. Event wiring & init
 */
(function () {
  /* =========================================================
   * 1. Constants & state
   * ======================================================= */
  const KEYS = {
    songs: 'tabvault.songs.v1',
    draft: 'tabvault.draft.v1',
    settings: 'tabvault.settings.v1',
  };

  /** Order of strings in tablature, top line → bottom line. */
  const DISPLAY_STRINGS = ['e', 'B', 'G', 'D', 'A', 'E'];
  /** Order of strings in the selector, low (6th) → high (1st). */
  const ENTRY_STRINGS = ['E', 'A', 'D', 'G', 'B', 'e'];
  const STRING_NUMBER = { e: 1, B: 2, G: 3, D: 4, A: 5, E: 6 };

  const DIFFICULTIES = ['Beginner', 'Intermediate', 'Advanced'];
  const TUNINGS = ['Standard E', 'Drop D', 'Custom'];
  const TAGS = ['Lead', 'Intro', 'Solo', 'Riff', 'Melody', 'Scale'];
  const TECHNIQUES = [
    { value: '', label: 'None', hint: 'Plain note' },
    { value: 'h', label: 'h', hint: 'Hammer-on' },
    { value: 'p', label: 'p', hint: 'Pull-off' },
    { value: '/', label: '/', hint: 'Slide up' },
    { value: '\\', label: '\\', hint: 'Slide down' },
    { value: 'b', label: 'b', hint: 'Bend' },
    { value: 'r', label: 'r', hint: 'Release' },
    { value: '~', label: '~', hint: 'Vibrato' },
  ];
  /** Techniques that go to a second fret, written like 2/3, 5h7, 7b9. */
  const TARGET_TECHS = new Set(['h', 'p', '/', '\\', 'b', 'r']);
  const MAX_FRET = 24;
  const MAX_MOVES = 8; // techniques chained on one note, e.g. 3h5p4 has 2

  const DEFAULT_SETTINGS = {
    perLine: 'auto',
    spacing: 2,
    showSteps: true,
    defaultView: 'tab',
    sort: 'recent',
    practiceZoom: 1.6,
  };

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    filters: { q: '', difficulty: 'all', tag: 'all' },
    dashQuery: '',
    editor: null,   // active song editor session
    detail: { songId: null, view: 'tab', section: 0, selected: null, qaString: 'e', sectionCount: 0, sectionOf: [] },
    practice: null, // active practice session
  };

  let currentRoute = null;
  let lastHash = '';
  let bypassGuard = false;
  let suppressNextHash = false;

  /* =========================================================
   * 2. Utilities & icons
   * ======================================================= */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function uid(prefix = '') {
    if (window.crypto && typeof crypto.randomUUID === 'function') {
      try { return prefix + crypto.randomUUID(); } catch (_) { /* fall through */ }
    }
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  const clone = (obj) => JSON.parse(JSON.stringify(obj));
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const ordinal = (n) => ['', '1st', '2nd', '3rd', '4th', '5th', '6th'][n] || String(n);
  const isCoarsePointer = () => window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  function debounce(fn, ms) {
    let t;
    const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
    wrapped.cancel = () => clearTimeout(t);
    return wrapped;
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function timeAgo(iso) {
    const t = new Date(iso).getTime();
    if (!t) return '';
    const s = (Date.now() - t) / 1000;
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 86400 * 7) {
      const days = Math.round(s / 86400);
      return days <= 1 ? 'yesterday' : `${days} days ago`;
    }
    return formatDate(iso);
  }

  function validDate(v) {
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    const d = new Date(v);
    return isNaN(d) ? null : d.toISOString();
  }

  function cleanStr(v, max) {
    if (typeof v === 'number' && isFinite(v)) v = String(v);
    if (typeof v !== 'string') return '';
    return v.trim().slice(0, max);
  }

  /** Only allow http(s) links. Adds https:// when the user omits a scheme. */
  function normalizeUrl(raw) {
    const s = cleanStr(raw, 2000);
    if (!s) return '';
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
    try {
      const u = new URL(withScheme);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.')) return u.href;
    } catch (_) { /* invalid */ }
    return null;
  }

  function shortUrl(url) {
    try {
      const u = new URL(url);
      const s = u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname) + u.search;
      return s.length > 52 ? s.slice(0, 50) + '…' : s;
    } catch (_) { return url; }
  }

  /** Validate a fret value. Returns { ok, value } or { ok:false, error }. */
  function parseFret(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (s === '') return { ok: false, error: `Enter a fret number (0–${MAX_FRET}).` };
    if (!/^\d+$/.test(s)) return { ok: false, error: 'Fret must be a whole number, e.g. 0, 5 or 12.' };
    const n = parseInt(s, 10);
    if (n > MAX_FRET) return { ok: false, error: `Fret must be between 0 and ${MAX_FRET}.` };
    return { ok: true, value: n };
  }

  const techniqueName = (v) => (TECHNIQUES.find((t) => t.value === v) || TECHNIQUES[0]).hint;
  /** A note written as tab text: fret plus each technique and the fret it goes to, e.g. "3h5p4". */
  const tabToken = (tab) => String(tab.fret) + (tab.moves || []).map((m) => m.tech + (m.to != null ? m.to : '')).join('');
  /** Human description of a note's techniques, e.g. "Hammer-on → Pull-off". */
  const techLabel = (tab) => (tab.moves || []).map((m) => techniqueName(m.tech)).join(' → ');

  /**
   * Parse tab text like "5", "7b9", "3h5p4" or "5~" into { fret, moves }.
   * Used by Quick add on the song page.
   */
  function parseNoteText(raw) {
    const text = String(raw == null ? '' : raw).replace(/\s+/g, '');
    if (!text) return { ok: false, error: 'Enter a fret, e.g. 5 or 3h5p4.' };
    const m = text.match(/^(\d{1,2})((?:[hpbr~\/\\]\d{0,2})*)$/i);
    if (!m) return { ok: false, error: 'Write a fret, optionally with techniques — e.g. 5, 7b9, 3h5p4, 5~' };
    const fret = parseFret(m[1]);
    if (!fret.ok) return fret;
    const moves = [];
    const re = /([hpbr~\/\\])(\d{0,2})/gi;
    let x;
    while ((x = re.exec(m[2]))) {
      const tech = x[1].toLowerCase();
      let to = null;
      if (x[2]) {
        if (!TARGET_TECHS.has(tech)) return { ok: false, error: `${techniqueName(tech)} doesn’t take a second fret.` };
        const f = parseFret(x[2]);
        if (!f.ok) return f;
        to = f.value;
      }
      moves.push({ tech, to });
    }
    if (moves.length > MAX_MOVES) return { ok: false, error: `A note can chain up to ${MAX_MOVES} techniques.` };
    return { ok: true, fret: fret.value, moves };
  }

  function renumber(tabs) {
    tabs.forEach((t, i) => { t.step = i + 1; });
    return tabs;
  }

  /** Does this step begin a new section (named, or a plain break)? */
  const startsSection = (tab) => !!(tab && (tab.sectionBreak || (tab.section || '').trim()));

  /** Remove a tab, keep its section label alive on the next tab, and renumber. */
  function removeTabAt(tabs, i) {
    const removed = tabs.splice(i, 1)[0];
    // If the deleted step started a section, the next step starts it instead.
    if (removed && startsSection(removed) && tabs[i] && !startsSection(tabs[i])) {
      tabs[i].section = removed.section || '';
      tabs[i].sectionBreak = true;
    }
    renumber(tabs);
    return removed;
  }

  function announce(msg) {
    const el = $('#sr-live');
    if (!el) return;
    el.textContent = '';
    setTimeout(() => { el.textContent = msg; }, 30);
  }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  const ICONS = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    clipboard: '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>',
    play: '<path d="M7 4v16l13-8Z"/>',
    chevL: '<path d="m15 18-6-6 6-6"/>',
    chevR: '<path d="m9 18 6-6-6-6"/>',
    chevD: '<path d="m6 9 6 6 6-6"/>',
    skipBack: '<path d="M19 20 9 12l10-8Z"/><path d="M5 19V5"/>',
    skipFwd: '<path d="m5 4 10 8-10 8Z"/><path d="M19 5v14"/>',
    external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M5 21h14"/>',
    upload: '<path d="M12 16V4m-5 5 5-5 5 5M5 21h14"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4m0-4h.01"/>',
    arrowLeft: '<path d="M19 12H5m7 7-7-7 7-7"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    tab: '<path d="M3 5h18M3 9.5h18M3 14h18M3 18.5h18"/>',
    section: '<path d="M4 6h16M4 10h10M4 18h16M4 14h10"/><path d="m17 11 3 3-3 3"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    insert: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8M8 12h8"/>',
    end: '<path d="m6 17 5-5-5-5M13 17l5-5-5-5"/>',
    sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  };

  function icon(name, cls = '') {
    return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
  }

  const LOGO = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 22.5c-1.7 0-8-7.3-8-13.5C4 4.4 7.4 1.5 12 1.5s8 2.9 8 7.5c0 6.2-6.3 13.5-8 13.5Z"/><path d="M8 7.5h8M8.4 10.5h7.2M9.2 13.5h5.6" stroke="#141417" stroke-width="1.3" stroke-linecap="round"/></svg>';

  /* =========================================================
   * 3. Data model
   * ======================================================= */
  const STRING_ALIASES = {
    '1': 'e', '2': 'B', '3': 'G', '4': 'D', '5': 'A', '6': 'E',
    'high e': 'e', 'low e': 'E', b: 'B', g: 'G', d: 'D', a: 'A',
  };

  /**
   * A note's techniques as [{ tech, to }]. Also converts the older format
   * (single `technique` + `toFret`) so existing libraries and backups still load.
   */
  function normalizeMoves(raw) {
    const valid = (v) => typeof v === 'string' && v !== '' && TECHNIQUES.some((t) => t.value === v);
    const target = (tech, v) => {
      if (!TARGET_TECHS.has(tech) || v == null || v === '') return null;
      const f = parseFret(v);
      return f.ok ? f.value : null;
    };
    if (Array.isArray(raw.moves)) {
      return raw.moves.filter((m) => m && valid(m.tech)).slice(0, MAX_MOVES).map((m) => ({ tech: m.tech, to: target(m.tech, m.to) }));
    }
    return valid(raw.technique) ? [{ tech: raw.technique, to: target(raw.technique, raw.toFret) }] : [];
  }

  function normalizeTab(raw) {
    if (!raw || typeof raw !== 'object') return null;
    let str = raw.string == null ? '' : String(raw.string).trim();
    if (!DISPLAY_STRINGS.includes(str)) str = STRING_ALIASES[str.toLowerCase()] || '';
    if (!str) return null;
    const fret = parseFret(raw.fret);
    if (!fret.ok) return null;
    return {
      id: cleanStr(raw.id, 100) || uid('t_'),
      step: 0,
      string: str,
      fret: fret.value,
      moves: normalizeMoves(raw),
      instruction: cleanStr(raw.instruction, 300),
      section: cleanStr(raw.section, 60),
      sectionBreak: raw.sectionBreak === true,
    };
  }

  /**
   * Turn any song-like object into a clean, valid song, or null if unusable.
   * `stats.droppedTabs` counts tabs that had to be discarded.
   */
  function normalizeSong(raw, stats) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const title = cleanStr(raw.title, 120);
    if (!title) return null;

    const tabs = [];
    const seen = new Set();
    (Array.isArray(raw.tabs) ? raw.tabs : []).forEach((t) => {
      const nt = normalizeTab(t);
      if (!nt) { if (stats) stats.droppedTabs += 1; return; }
      if (seen.has(nt.id)) nt.id = uid('t_');
      seen.add(nt.id);
      tabs.push(nt);
    });
    renumber(tabs);

    let tuning = 'Standard E';
    let customTuning = cleanStr(raw.customTuning, 40);
    if (TUNINGS.includes(raw.tuning)) tuning = raw.tuning;
    else if (cleanStr(raw.tuning, 40)) { tuning = 'Custom'; customTuning = customTuning || cleanStr(raw.tuning, 40); }

    let capo = parseInt(raw.capo, 10);
    if (!Number.isFinite(capo) || capo < 0 || capo > 12) capo = 0;

    const created = validDate(raw.createdAt) || new Date().toISOString();
    return {
      id: cleanStr(raw.id, 100) || uid('s_'),
      title,
      artist: cleanStr(raw.artist, 120),
      difficulty: DIFFICULTIES.includes(raw.difficulty) ? raw.difficulty : 'Beginner',
      tuning,
      customTuning,
      capo,
      referenceUrl: normalizeUrl(raw.referenceUrl) || '',
      notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 5000) : '',
      tags: Array.isArray(raw.tags) ? [...new Set(raw.tags.filter((t) => TAGS.includes(t)))] : [],
      createdAt: created,
      updatedAt: validDate(raw.updatedAt) || created,
      lastOpenedAt: validDate(raw.lastOpenedAt),
      tabs,
    };
  }

  function newSong() {
    const now = new Date().toISOString();
    return {
      id: uid('s_'), title: '', artist: '', difficulty: 'Beginner', tuning: 'Standard E', customTuning: '',
      capo: 0, referenceUrl: '', notes: '', tags: [], createdAt: now, updatedAt: now, lastOpenedAt: null, tabs: [],
    };
  }

  /** Display labels for each string, following the song's tuning. */
  function stringLabels(song) {
    const std = { E: 'E', A: 'A', D: 'D', G: 'G', B: 'B', e: 'e' };
    if (!song) return std;
    if (song.tuning === 'Drop D') return { ...std, E: 'D' };
    if (song.tuning === 'Custom') {
      const notes = (song.customTuning || '').match(/[A-Ga-g][#b]?/g);
      if (notes && notes.length === 6) {
        const m = {};
        ENTRY_STRINGS.forEach((k, i) => { m[k] = notes[i][0].toUpperCase() + notes[i].slice(1); });
        if (m.e[0] === m.E[0]) m.e = m.e[0].toLowerCase() + m.e.slice(1);
        return m;
      }
    }
    return std;
  }

  function tuningText(song) {
    if (song.tuning === 'Custom') return song.customTuning ? `Custom (${song.customTuning})` : 'Custom';
    return song.tuning;
  }

  /* =========================================================
   * 4. Storage
   * ======================================================= */
  let storageAvailable = true;

  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (_) { storageAvailable = false; return null; }
  }
  function lsSet(key, value) {
    localStorage.setItem(key, value); // may throw — callers handle it
  }
  function lsRemove(key) {
    try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
  }

  const Store = {
    songs: [],

    load() {
      const raw = lsGet(KEYS.songs);
      if (!raw) { this.songs = []; return; }
      try {
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) throw new Error('Unexpected data format');
        this.songs = data.map((s) => normalizeSong(s)).filter(Boolean);
      } catch (err) {
        // Never throw away unreadable data — keep a copy so nothing is lost.
        try { lsSet(`${KEYS.songs}.corrupt.${Date.now()}`, raw); } catch (_) { /* ignore */ }
        this.songs = [];
        setTimeout(() => toast('Your saved data could not be read. A backup copy was kept in browser storage.', 'error', { duration: 8000 }), 400);
      }
    },

    persist() {
      try {
        lsSet(KEYS.songs, JSON.stringify(this.songs));
        return true;
      } catch (err) {
        toast('Could not save: browser storage is full or disabled.', 'error', { duration: 7000 });
        return false;
      }
    },

    /** Persist a mutation; roll back the in-memory list if writing fails. */
    commit(mutator) {
      const prev = this.songs.slice();
      mutator(this.songs);
      if (!this.persist()) { this.songs = prev; return false; }
      updateSidebarCount();
      return true;
    },

    all() { return this.songs; },
    get(id) { return this.songs.find((s) => s.id === id) || null; },

    upsert(song) {
      const record = { ...song, updatedAt: new Date().toISOString() };
      return this.commit((list) => {
        const i = list.findIndex((s) => s.id === record.id);
        if (i >= 0) list[i] = record; else list.push(record);
      });
    },

    remove(id) {
      return this.commit((list) => {
        const i = list.findIndex((s) => s.id === id);
        if (i >= 0) list.splice(i, 1);
      });
    },

    replaceAll(songs) {
      return this.commit((list) => { list.length = 0; list.push(...songs); });
    },

    /** Record that a song was opened (doesn't change updatedAt). */
    touch(id) {
      const s = this.get(id);
      if (!s) return;
      const prev = s.lastOpenedAt;
      s.lastOpenedAt = new Date().toISOString();
      try { lsSet(KEYS.songs, JSON.stringify(this.songs)); } catch (_) { s.lastOpenedAt = prev; }
    },
  };

  const Settings = {
    load() {
      try {
        const raw = JSON.parse(lsGet(KEYS.settings) || '{}');
        state.settings = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
      } catch (_) {
        state.settings = { ...DEFAULT_SETTINGS };
      }
      const s = state.settings;
      if (s.perLine !== 'auto') s.perLine = clamp(parseInt(s.perLine, 10) || 12, 4, 48);
      s.spacing = clamp(parseInt(s.spacing, 10) || 2, 1, 4);
      s.showSteps = s.showSteps !== false;
      if (!['tab', 'list'].includes(s.defaultView)) s.defaultView = 'tab';
      s.practiceZoom = clamp(Number(s.practiceZoom) || 1.6, 1, 3);
    },
    save() {
      try { lsSet(KEYS.settings, JSON.stringify(state.settings)); } catch (_) { toast('Could not save settings.', 'error'); }
    },
  };

  const Draft = {
    load() {
      try {
        const d = JSON.parse(lsGet(KEYS.draft) || 'null');
        if (!d || !d.song || typeof d.song !== 'object') return null;
        const song = normalizeSong({ ...d.song, title: d.song.title || 'Untitled' }) || null;
        if (!song) return null;
        song.title = typeof d.song.title === 'string' ? d.song.title : '';
        song.referenceUrl = typeof d.song.referenceUrl === 'string' ? d.song.referenceUrl : '';
        return { ...d, song };
      } catch (_) { return null; }
    },
    save() {
      const ed = state.editor;
      if (!ed) return;
      if (!isEditorDirty()) { lsRemove(KEYS.draft); return; }
      const payload = {
        v: 1, savedAt: new Date().toISOString(), isNew: ed.isNew, baseUpdatedAt: ed.baseUpdatedAt,
        col: ed.col, str: ed.str, pendingBreak: ed.pendingBreak, song: ed.song, detailsOpen: ed.detailsOpen,
      };
      try {
        lsSet(KEYS.draft, JSON.stringify(payload));
        setAutosaveStatus('Draft auto-saved · not yet saved to library');
      } catch (_) {
        setAutosaveStatus('Auto-save failed — storage full?');
      }
    },
    clear() { lsRemove(KEYS.draft); },
  };
  const saveDraftSoon = debounce(() => Draft.save(), 350);

  function updateSidebarCount() {
    const el = $('#sidebar-count');
    if (el) el.textContent = `${plural(Store.all().length, 'song')} saved locally`;
  }

  /* =========================================================
   * 5. UI primitives
   * ======================================================= */
  function toast(message, type = 'success', opts = {}) {
    const root = $('#toasts');
    if (!root) return;
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const ic = type === 'error' ? 'alert' : type === 'info' ? 'info' : 'check';
    el.innerHTML = `
      <span class="toast-icon">${icon(ic)}</span>
      <span class="toast-msg">${esc(message)}</span>
      ${opts.actionLabel ? `<button type="button" class="toast-action">${esc(opts.actionLabel)}</button>` : ''}
      <button type="button" class="toast-close" aria-label="Dismiss">${icon('x')}</button>`;
    root.appendChild(el);
    while (root.children.length > 4) root.firstElementChild.remove();

    let timer;
    const close = () => {
      clearTimeout(timer);
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 200);
    };
    const duration = opts.duration || (opts.actionLabel ? 7000 : type === 'error' ? 5500 : 2800);
    timer = setTimeout(close, duration);
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', () => { timer = setTimeout(close, 1800); });
    el.querySelector('.toast-close').addEventListener('click', close);
    const action = el.querySelector('.toast-action');
    if (action) action.addEventListener('click', () => { close(); opts.onAction && opts.onAction(); });
  }

  /**
   * Show a modal dialog. Resolves with the chosen action's `value`,
   * or null when dismissed (Esc / backdrop click).
   */
  function openModal({ title, body = '', actions = [], dismissible = true }) {
    return new Promise((resolve) => {
      const root = $('#modal-root');
      const wrap = document.createElement('div');
      wrap.className = 'modal-backdrop';
      wrap.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <h2 id="modal-title" class="modal-title">${esc(title)}</h2>
          <div class="modal-body">${body}</div>
          <div class="modal-actions">
            ${actions.map((a, i) => `<button type="button" class="btn ${a.variant || 'ghost'}" data-modal-index="${i}">${esc(a.label)}</button>`).join('')}
          </div>
        </div>`;
      const prevFocus = document.activeElement;
      let closed = false;

      function close(value) {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        wrap.classList.add('closing');
        setTimeout(() => wrap.remove(), 160);
        if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) {
          try { prevFocus.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
        }
        resolve(value);
      }

      function onKey(e) {
        e.stopPropagation();
        if (e.key === 'Escape' && dismissible) { e.preventDefault(); close(null); return; }
        if (e.key === 'Tab') {
          const items = $$('button, [href], input, select, textarea', wrap).filter((x) => !x.disabled);
          if (!items.length) return;
          const first = items[0], last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }

      wrap.addEventListener('click', (e) => {
        const b = e.target.closest('[data-modal-index]');
        if (b) close(actions[Number(b.dataset.modalIndex)].value);
        else if (e.target === wrap && dismissible) close(null);
      });
      document.addEventListener('keydown', onKey, true);
      root.appendChild(wrap);
      const focusTarget = $('[data-autofocus]', wrap) || $$('.modal-actions .btn', wrap).pop();
      if (focusTarget) focusTarget.focus();
    });
  }

  function confirmDialog({ title, message, confirmLabel = 'Delete', danger = true }) {
    return openModal({
      title,
      body: `<p>${message}</p>`,
      actions: [
        { label: 'Cancel', value: false, variant: 'ghost' },
        { label: confirmLabel, value: true, variant: danger ? 'danger' : 'primary' },
      ],
    }).then((v) => v === true);
  }

  const modalOpen = () => !!$('.modal-backdrop');

  /* =========================================================
   * 6. Tab rendering
   * ======================================================= */
  const tabFontPx = () => (window.innerWidth < 720 ? 13 : 15);

  /** How many steps fit on one line of tablature. */
  function getPerLine(widthPx, fontPx) {
    const s = state.settings.perLine;
    if (s !== 'auto') return Number(s) || 12;
    const charW = (fontPx || tabFontPx()) * 0.6;
    const chars = Math.floor((widthPx || window.innerWidth * 0.8) / charW) - 6;
    const colW = state.settings.spacing + 2;
    return clamp(Math.floor(chars / colW), 4, 32);
  }

  /**
   * Group tabs into sections. A new section starts when a tab has a
   * section label, or when the current line is full.
   */
  function buildSections(tabs, perLine) {
    const out = [];
    let cur = null;
    let currentName = '';
    tabs.forEach((tab, index) => {
      const name = (tab.section || '').trim();
      if (startsSection(tab)) {
        currentName = name;
        cur = { label: name, cont: false, items: [] };
        out.push(cur);
      } else if (!cur || cur.items.length >= perLine) {
        cur = { label: currentName, cont: !!cur && !!currentName, items: [] };
        out.push(cur);
      }
      cur.items.push({ tab, index });
    });
    return out;
  }

  function sectionTitle(sec, i) {
    if (!sec.label) return `Section ${i + 1}`;
    return sec.cont ? `${sec.label} (cont.)` : sec.label;
  }

  /** Render one block of six-line tablature as HTML. */
  function renderTabBlock(song, items, o = {}) {
    const spacing = o.spacing != null ? o.spacing : state.settings.spacing;
    const showSteps = o.showSteps != null ? o.showSteps : state.settings.showSteps;
    const labels = stringLabels(song);
    const lw = Math.max(...DISPLAY_STRINGS.map((k) => labels[k].length));
    const gap = '-'.repeat(spacing);
    const sp = ' '.repeat(spacing);

    const cols = items.map(({ tab, index }) => {
      const tok = tabToken(tab);
      const step = String(index + 1);
      return { tab, index, tok, step, w: Math.max(tok.length, showSteps ? step.length : 1) };
    });
    const cls = (c) => {
      let s = 'cell';
      if (c.index === o.activeIndex) s += ' active';
      if (o.played != null && c.index < o.played) s += ' played';
      if (c.tab.ghost) s += ' ghost';
      if (c.tab.instruction) s += ' has-note';
      return s;
    };
    const tip = (c) => {
      const parts = [`Step ${c.index + 1}`, `${labels[c.tab.string]} string`, `fret ${tabToken(c.tab)}`];
      if (c.tab.moves && c.tab.moves.length) parts.push(techLabel(c.tab));
      if (c.tab.instruction) parts.push(c.tab.instruction);
      return esc(parts.join(' · '));
    };

    let html = `<div class="tab-block${o.compact ? ' compact' : ''}"${o.action ? ` data-action="${o.action}"` : ''}>`;
    if (showSteps) {
      html += `<div class="tab-line tab-steps" aria-hidden="true">${' '.repeat(lw + 1)}${cols
        .map((c) => `${sp}<span class="${cls(c)}" data-step-index="${c.index}">${c.step.padEnd(c.w)}</span>`).join('')}</div>`;
    }
    DISPLAY_STRINGS.forEach((k) => {
      html += `<div class="tab-line"><span class="tab-label">${esc(labels[k].padEnd(lw))}|</span>`;
      cols.forEach((c) => {
        const on = c.tab.string === k;
        html += `<span class="dash">${gap}</span><span class="${cls(c)}${on ? ' on' : ''}" data-step-index="${c.index}"${on ? ` title="${tip(c)}"` : ''}>${
          on ? `<b>${esc(c.tok)}</b>${'-'.repeat(c.w - c.tok.length)}` : '-'.repeat(c.w)}</span>`;
      });
      html += `<span class="dash">${gap}</span><span class="tab-label">|</span></div>`;
    });
    return html + '</div>';
  }

  function renderEmptyStaff(song, message) {
    const labels = stringLabels(song);
    const lw = Math.max(...DISPLAY_STRINGS.map((k) => labels[k].length));
    const lines = DISPLAY_STRINGS.map((k) => `<div class="tab-line"><span class="tab-label">${esc(labels[k].padEnd(lw))}|</span>${'-'.repeat(32)}<span class="tab-label">|</span></div>`).join('');
    return `<div class="empty-staff"><div class="tab-block muted-block">${lines}</div><p class="muted">${esc(message)}</p></div>`;
  }

  /** Render a list of sections as tablature blocks. */
  function renderTabSections(song, sections, o = {}) {
    return sections.map((sec, si) => {
      const first = sec.items[0].index + 1;
      const last = sec.items[sec.items.length - 1].index + 1;
      const notes = sec.items.filter((it) => it.tab.instruction && !it.tab.ghost);
      return `
        <div class="tab-section${o.currentSection === si ? ' current' : ''}" data-section="${si}">
          <div class="tab-section-head">
            <span class="tab-section-title">${esc(sectionTitle(sec, si))}</span>
            <span class="tab-section-range">${first === last ? `Step ${first}` : `Steps ${first}–${last}`}</span>
          </div>
          ${renderTabBlock(song, sec.items, { activeIndex: o.active, action: o.action })}
          ${notes.length ? `<ul class="step-notes">${notes.map((n) => `<li><span class="step-pill sm">${n.index + 1}</span><span>${esc(n.tab.instruction)}</span></li>`).join('')}</ul>` : ''}
        </div>`;
    }).join('');
  }

  /** Render the numbered list view (grouped by sections). */
  function renderTabList(song, sections, o = {}) {
    const labels = stringLabels(song);
    return sections.map((sec, si) => `
      <div class="list-section${o.currentSection === si ? ' current' : ''}" data-section="${si}">
        <div class="tab-section-head"><span class="tab-section-title">${esc(sectionTitle(sec, si))}</span></div>
        <div class="tab-rows">
        ${sec.items.map(({ tab, index }) => `
          <div class="tab-row${index === o.active ? ' active' : ''}${tab.ghost ? ' ghost' : ''}"${tab.ghost ? '' : ` data-action="${o.rowAction}" data-index="${index}" role="button" tabindex="0"`}>
            <span class="step-pill">${index + 1}</span>
            <span class="row-string"><b>${esc(labels[tab.string])}</b><small>${ordinal(STRING_NUMBER[tab.string])} string</small></span>
            <span class="row-fret"><small>Fret</small><b>${esc(tabToken(tab))}</b></span>
            <span class="row-note">
              ${tab.moves && tab.moves.length ? `<span class="tech-pill">${esc(techLabel(tab))}</span>` : ''}
              ${tab.instruction ? `<span class="row-instruction">${esc(tab.instruction)}</span>` : ''}
              ${tab.ghost ? '<em class="muted">being entered…</em>' : ''}
            </span>
            ${tab.ghost ? '' : `<button type="button" class="icon-btn subtle" data-action="${o.deleteAction}" data-index="${index}" aria-label="Delete step ${index + 1}" title="Delete step ${index + 1}">${icon('trash')}</button>`}
          </div>`).join('')}
        </div>
      </div>`).join('');
  }

  /** Plain-text tablature (for copying / sharing). */
  function tabAsText(song, perLine = 16) {
    const labels = stringLabels(song);
    const lw = Math.max(...DISPLAY_STRINGS.map((k) => labels[k].length));
    const sections = buildSections(song.tabs, perLine);
    const out = [];
    out.push(song.artist ? `${song.title} — ${song.artist}` : song.title);
    out.push(`Tuning: ${tuningText(song)}${song.capo ? ` | Capo: fret ${song.capo}` : ''}`);
    out.push('');
    sections.forEach((sec, si) => {
      out.push(`[${sectionTitle(sec, si)}]`);
      DISPLAY_STRINGS.forEach((k) => {
        let line = `${labels[k].padEnd(lw)}|`;
        sec.items.forEach(({ tab }) => {
          const tok = tabToken(tab);
          line += '--' + (tab.string === k ? tok : '-'.repeat(tok.length));
        });
        out.push(line + '--|');
      });
      sec.items.filter((it) => it.tab.instruction).forEach((it) => out.push(`  (${it.index + 1}) ${it.tab.instruction}`));
      out.push('');
    });
    if (song.notes) out.push('Notes:', song.notes);
    return out.join('\n');
  }

  /** Scroll horizontally so the active column is visible (never scrolls the page). */
  function keepActiveVisible(root) {
    if (!root) return;
    $$('.tab-block', root).forEach((b) => {
      const c = b.querySelector('.cell.active');
      if (!c) return;
      const bl = b.getBoundingClientRect();
      const cl = c.getBoundingClientRect();
      if (cl.right > bl.right - 8) b.scrollLeft += cl.right - bl.right + 32;
      else if (cl.left < bl.left + 8) b.scrollLeft -= bl.left - cl.left + 32;
    });
  }

  /* =========================================================
   * 7. Router
   * ======================================================= */
  function parseHash(h = location.hash) {
    const s = (h || '').replace(/^#\/?/, '');
    const qi = s.indexOf('?');
    const path = qi >= 0 ? s.slice(0, qi) : s;
    const query = new URLSearchParams(qi >= 0 ? s.slice(qi + 1) : '');
    const parts = path.split('/').filter(Boolean);
    let id = null;
    if (parts[1] != null) { try { id = decodeURIComponent(parts[1]); } catch (_) { id = parts[1]; } }
    return { name: parts[0] || 'dashboard', id, query, path };
  }

  function go(hash) {
    if (location.hash === hash) render({ keepScroll: true });
    else location.hash = hash;
  }

  function replaceHash(hash) {
    try { history.replaceState(null, '', hash); }
    catch (_) { suppressNextHash = true; location.replace(hash); }
    lastHash = hash;
  }

  const isEditorRoute = (r) => r && (r.name === 'new' || r.name === 'edit');

  function editorMatchesRoute(route) {
    const ed = state.editor;
    if (!ed || !isEditorRoute(route)) return false;
    return route.name === 'new' ? ed.isNew : (!ed.isNew && route.id === ed.song.id);
  }

  async function onHashChange() {
    if (suppressNextHash) { suppressNextHash = false; return; }
    const target = location.hash;
    const next = parseHash(target);

    // Guard: leaving the editor with unsaved changes.
    if (!bypassGuard && state.editor && isEditorRoute(parseHash(lastHash)) && !editorMatchesRoute(next)) {
      if (isEditorDirty()) {
        replaceHash(lastHash);
        const ok = await confirmLeaveEditor();
        if (!ok) return;
        bypassGuard = true;
        location.hash = target;
        return;
      }
      discardEditor();
    }
    bypassGuard = false;
    lastHash = location.hash;
    if (state.practice) closePractice();
    render();
  }

  function setActiveNav(name) {
    const map = { song: 'songs', edit: 'songs' };
    const active = map[name] || name;
    $$('[data-nav]').forEach((a) => {
      const on = a.dataset.nav === active;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  function setTitle(t) {
    document.title = t ? `${t} · TabVault` : 'TabVault – My Guitar Library';
  }

  function render(opts = {}) {
    const route = parseHash();
    const changed = !currentRoute || currentRoute.path !== route.path;
    currentRoute = route;
    document.body.classList.toggle('in-editor', isEditorRoute(route));
    setActiveNav(route.name);
    updateSidebarCount();
    const view = $('#view');

    switch (route.name) {
      case 'dashboard':
        view.innerHTML = viewDashboard();
        setTitle('');
        break;
      case 'songs':
        view.innerHTML = viewSongs();
        renderSongResults();
        setTitle('My Songs');
        break;
      case 'recent':
        view.innerHTML = viewRecent();
        setTitle('Recently Added');
        break;
      case 'settings':
        view.innerHTML = viewSettings();
        setTitle('Settings');
        break;
      case 'song':
        renderDetail(route, changed);
        break;
      case 'new':
      case 'edit':
        enterEditor(route, changed);
        break;
      default:
        replaceHash('#/dashboard');
        render();
        return;
    }
    if (changed && !opts.keepScroll) {
      window.scrollTo(0, 0);
      view.classList.remove('view-enter');
      void view.offsetWidth; // restart animation
      view.classList.add('view-enter');
    }
  }

  /* =========================================================
   * 8. Views
   * ======================================================= */
  const diffBadge = (d) => `<span class="badge diff diff-${esc(String(d).toLowerCase())}">${esc(d)}</span>`;
  const tagBadge = (t) => `<span class="badge tag">${esc(t)}</span>`;

  function filterSongs(songs, { q = '', difficulty = 'all', tag = 'all' } = {}) {
    const query = q.trim().toLowerCase();
    return songs.filter((s) => {
      if (difficulty !== 'all' && s.difficulty !== difficulty) return false;
      if (tag !== 'all' && !s.tags.includes(tag)) return false;
      if (!query) return true;
      return s.title.toLowerCase().includes(query) || (s.artist || '').toLowerCase().includes(query);
    });
  }

  function sortSongs(songs, sort) {
    const list = songs.slice();
    const t = (v) => (v ? new Date(v).getTime() : 0);
    switch (sort) {
      case 'oldest': return list.sort((a, b) => t(a.createdAt) - t(b.createdAt));
      case 'az': return list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
      case 'za': return list.sort((a, b) => b.title.localeCompare(a.title, undefined, { sensitivity: 'base' }));
      case 'tabs': return list.sort((a, b) => b.tabs.length - a.tabs.length);
      case 'practiced': return list.sort((a, b) => t(b.lastOpenedAt) - t(a.lastOpenedAt));
      case 'updated': return list.sort((a, b) => t(b.updatedAt) - t(a.updatedAt));
      default: return list.sort((a, b) => t(b.createdAt) - t(a.createdAt));
    }
  }

  function songRow(s) {
    return `
      <div class="song-row" data-action="open-song" data-id="${esc(s.id)}" role="button" tabindex="0">
        <span class="song-row-icon">${esc((s.title.trim()[0] || '♪').toUpperCase())}</span>
        <span class="song-row-main">
          <span class="song-row-title">${esc(s.title)}</span>
          <span class="song-row-sub">${esc(s.artist || 'Unknown artist')} · ${plural(s.tabs.length, 'tab')}</span>
        </span>
        ${diffBadge(s.difficulty)}
        <span class="song-row-date">${esc(timeAgo(s.createdAt))}</span>
        <span class="song-row-chev">${icon('chevR')}</span>
      </div>`;
  }

  function emptyLibrary() {
    return `
      <div class="empty-state">
        <div class="empty-art">${renderTabBlock({ tuning: 'Standard E' }, [
          { tab: { string: 'e', fret: 0 }, index: 0 }, { tab: { string: 'B', fret: 1 }, index: 1 },
          { tab: { string: 'G', fret: 0 }, index: 2 }, { tab: { string: 'D', fret: 2 }, index: 3 },
        ], { showSteps: false, compact: true })}</div>
        <h2>Your vault is empty</h2>
        <p>Every song you learn deserves a permanent home. Add the first one and its tabs will be here whenever you pick up your guitar — no more hunting for the original video.</p>
        <div class="empty-actions">
          <a href="#/new" class="btn primary lg">${icon('plus')} Add your first song</a>
          <button type="button" class="btn lg" data-action="load-example">${icon('sparkle')} Try an example</button>
          <button type="button" class="btn ghost lg" data-action="import">${icon('upload')} Import a backup</button>
        </div>
      </div>`;
  }

  function draftBanner() {
    const d = Draft.load();
    if (!d) return '';
    const target = d.isNew ? '#/new' : `#/edit/${encodeURIComponent(d.song.id)}`;
    return `
      <div class="banner">
        <span class="banner-icon">${icon('info')}</span>
        <span class="banner-text">You have unsaved progress on <strong>${esc(d.song.title || 'an untitled song')}</strong> (${plural(d.song.tabs.length, 'tab')}, ${esc(timeAgo(d.savedAt))}).</span>
        <span class="banner-actions">
          <button type="button" class="btn sm ghost" data-action="discard-draft">Discard</button>
          <a href="${target}" class="btn sm primary">Resume</a>
        </span>
      </div>`;
  }

  /* ---------- Dashboard ---------- */
  function viewDashboard() {
    const songs = Store.all();
    const totalTabs = songs.reduce((n, s) => n + s.tabs.length, 0);
    const weekAgo = Date.now() - 7 * 864e5;
    const thisWeek = songs.filter((s) => new Date(s.createdAt).getTime() >= weekAgo).length;
    const avg = songs.length ? Math.round(totalTabs / songs.length) : 0;
    const recent = sortSongs(songs, 'recent').slice(0, 5);
    const lastOpened = sortSongs(songs.filter((s) => s.lastOpenedAt), 'practiced')[0];

    return `
      ${draftBanner()}
      <header class="hero">
        <div>
          <p class="eyebrow">Welcome back</p>
          <h1 class="hero-title">TabVault</h1>
          <p class="hero-sub">Your personal guitar tabs collection</p>
        </div>
        <a href="#/new" class="btn primary lg hero-cta">${icon('plus')} Add New Song</a>
      </header>

      <div class="search-wrap big">
        ${icon('search')}
        <input id="dash-search" type="search" placeholder="Search your songs by title or artist…" autocomplete="off" value="${esc(state.dashQuery)}" aria-label="Search songs">
        <kbd class="hide-touch">/</kbd>
      </div>
      <div id="dash-results">${state.dashQuery ? dashResults(state.dashQuery) : ''}</div>

      <section class="stats" aria-label="Library statistics">
        <div class="stat"><span class="stat-value">${songs.length}</span><span class="stat-label">Saved songs</span></div>
        <div class="stat"><span class="stat-value">${totalTabs}</span><span class="stat-label">Saved tabs</span></div>
        <div class="stat"><span class="stat-value">${thisWeek}</span><span class="stat-label">Added this week</span></div>
        <div class="stat"><span class="stat-value">${avg}</span><span class="stat-label">Avg. tabs per song</span></div>
      </section>

      ${lastOpened ? `
        <section class="continue card" data-action="open-song" data-id="${esc(lastOpened.id)}" role="button" tabindex="0">
          <div class="continue-text">
            <p class="eyebrow">Continue practicing</p>
            <h2>${esc(lastOpened.title)}</h2>
            <p class="muted">${esc(lastOpened.artist || 'Unknown artist')} · ${plural(lastOpened.tabs.length, 'tab')} · opened ${esc(timeAgo(lastOpened.lastOpenedAt))}</p>
          </div>
          ${lastOpened.tabs.length ? `<button type="button" class="btn primary" data-action="practice" data-id="${esc(lastOpened.id)}">${icon('play')} Practice</button>` : ''}
        </section>` : ''}

      <section class="block">
        <div class="section-head">
          <h2>Recently added</h2>
          ${songs.length ? '<a href="#/recent" class="link">View all</a>' : ''}
        </div>
        ${songs.length ? `<div class="song-rows">${recent.map(songRow).join('')}</div>` : emptyLibrary()}
      </section>`;
  }

  function dashResults(q) {
    const results = sortSongs(filterSongs(Store.all(), { q }), 'az').slice(0, 8);
    if (!results.length) return `<p class="search-empty">No songs match “${esc(q)}”.</p>`;
    return `<div class="song-rows search-results">${results.map(songRow).join('')}</div>`;
  }

  /* ---------- My Songs ---------- */
  function viewSongs() {
    const f = state.filters;
    const sorts = [
      ['recent', 'Recently added'], ['oldest', 'Oldest first'], ['az', 'Title A–Z'], ['za', 'Title Z–A'],
      ['tabs', 'Most tabs'], ['practiced', 'Recently practiced'], ['updated', 'Recently edited'],
    ];
    return `
      <div class="page-head">
        <div>
          <h1>My Songs</h1>
          <p class="muted" id="songs-count"></p>
        </div>
        <a href="#/new" class="btn primary">${icon('plus')} Add New Song</a>
      </div>

      <div class="toolbar">
        <div class="search-wrap">
          ${icon('search')}
          <input id="songs-search" type="search" placeholder="Search by title or artist…" value="${esc(f.q)}" autocomplete="off" aria-label="Search songs">
          <kbd class="hide-touch">/</kbd>
        </div>
        <select id="filter-difficulty" class="select" aria-label="Filter by difficulty">
          <option value="all">All difficulties</option>
          ${DIFFICULTIES.map((d) => `<option value="${d}"${f.difficulty === d ? ' selected' : ''}>${d}</option>`).join('')}
        </select>
        <select id="sort-select" class="select" aria-label="Sort songs">
          ${sorts.map(([v, l]) => `<option value="${v}"${state.settings.sort === v ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="chips tag-filter" role="group" aria-label="Filter by tag">
        <button type="button" class="chip${f.tag === 'all' ? ' active' : ''}" data-action="filter-tag" data-tag="all">All tags</button>
        ${TAGS.map((t) => `<button type="button" class="chip${f.tag === t ? ' active' : ''}" data-action="filter-tag" data-tag="${t}">${t}</button>`).join('')}
      </div>
      <div id="songs-results"></div>`;
  }

  function songCard(s) {
    const id = esc(s.id);
    const preview = s.tabs.length
      ? renderTabBlock(s, s.tabs.slice(0, 8).map((tab, index) => ({ tab, index })), { showSteps: false, spacing: 1, compact: true })
      : '<div class="card-notabs">No tabs yet</div>';
    return `
      <article class="song-card" data-action="open-song" data-id="${id}" role="button" tabindex="0" aria-label="Open ${esc(s.title)}">
        <div class="song-card-top">
          ${diffBadge(s.difficulty)}
          <span class="muted small">${plural(s.tabs.length, 'tab')}</span>
        </div>
        <h3 class="song-card-title">${esc(s.title)}</h3>
        <p class="song-card-artist">${esc(s.artist || 'Unknown artist')}</p>
        <div class="song-card-preview">${preview}</div>
        ${s.tags.length ? `<div class="badges">${s.tags.map(tagBadge).join('')}</div>` : ''}
        <p class="song-card-meta">Added ${esc(formatDate(s.createdAt))}${s.tuning !== 'Standard E' ? ` · ${esc(tuningText(s))}` : ''}${s.capo ? ` · Capo ${s.capo}` : ''}</p>
        <div class="song-card-actions">
          <button type="button" class="btn primary sm" data-action="open-song" data-id="${id}">${icon('play')} Play / View</button>
          <button type="button" class="btn sm" data-action="edit-song" data-id="${id}">${icon('edit')} Edit</button>
          <button type="button" class="icon-btn subtle" data-action="duplicate-song" data-id="${id}" aria-label="Duplicate ${esc(s.title)}" title="Duplicate">${icon('copy')}</button>
          <button type="button" class="icon-btn subtle danger" data-action="delete-song" data-id="${id}" aria-label="Delete ${esc(s.title)}" title="Delete">${icon('trash')}</button>
        </div>
      </article>`;
  }

  function renderSongResults() {
    const el = $('#songs-results');
    if (!el) return;
    const all = Store.all();
    const list = sortSongs(filterSongs(all, state.filters), state.settings.sort);
    const count = $('#songs-count');
    if (count) count.textContent = list.length === all.length ? `${plural(all.length, 'song')} in your library` : `${list.length} of ${plural(all.length, 'song')}`;

    if (!all.length) { el.innerHTML = emptyLibrary(); return; }
    if (!list.length) {
      el.innerHTML = `
        <div class="empty-state small">
          <h2>No songs match</h2>
          <p>Try a different search term or clear the filters.</p>
          <div class="empty-actions"><button type="button" class="btn" data-action="clear-filters">Clear filters</button></div>
        </div>`;
      return;
    }
    el.innerHTML = `<div class="card-grid">${list.map(songCard).join('')}</div>`;
  }

  /* ---------- Recently added ---------- */
  function viewRecent() {
    const songs = sortSongs(Store.all(), 'recent');
    const head = `
      <div class="page-head">
        <div><h1>Recently Added</h1><p class="muted">Your library in the order you added it.</p></div>
        <a href="#/new" class="btn primary">${icon('plus')} Add New Song</a>
      </div>`;
    if (!songs.length) return head + emptyLibrary();

    const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const today = startOfDay(Date.now());
    const groupOf = (s) => {
      const t = new Date(s.createdAt).getTime();
      if (t >= today) return 'Today';
      if (t >= today - 864e5) return 'Yesterday';
      if (t >= today - 6 * 864e5) return 'Earlier this week';
      if (t >= today - 29 * 864e5) return 'Last 30 days';
      return 'Older';
    };
    const groups = [];
    songs.forEach((s) => {
      const g = groupOf(s);
      let grp = groups.find((x) => x.name === g);
      if (!grp) { grp = { name: g, songs: [] }; groups.push(grp); }
      grp.songs.push(s);
    });
    return head + groups.map((g) => `
      <section class="block">
        <div class="section-head"><h2>${g.name}</h2><span class="muted small">${plural(g.songs.length, 'song')}</span></div>
        <div class="song-rows">${g.songs.map(songRow).join('')}</div>
      </section>`).join('');
  }

  /* ---------- Settings ---------- */
  function exampleTabs() {
    const up = [['E', 0], ['E', 3], ['A', 0], ['A', 2], ['D', 0], ['D', 2], ['G', 0], ['G', 2], ['B', 0], ['B', 3], ['e', 0], ['e', 3]];
    return up.map(([string, fret], i) => ({ id: `ex${i}`, string, fret, moves: [], instruction: '', section: '' }));
  }

  function viewSettings() {
    const s = state.settings;
    const perLineOpts = ['auto', 4, 6, 8, 10, 12, 16, 20, 24, 32];
    let bytes = 0;
    try { bytes = (lsGet(KEYS.songs) || '').length * 2; } catch (_) { /* ignore */ }
    const kb = (bytes / 1024).toFixed(1);
    const shortcut = (keys, what) => `<div class="kbd-row"><span>${keys.map((k) => `<kbd>${k}</kbd>`).join(' ')}</span><span>${what}</span></div>`;

    return `
      <div class="page-head"><div><h1>Settings</h1><p class="muted">Display preferences and your data.</p></div></div>

      <section class="card settings-card">
        <h2 class="card-title">Tab display</h2>
        <div class="setting-row">
          <div><strong>Steps per line</strong><p class="muted small">How many notes appear on each line of tablature. Auto fits your screen.</p></div>
          <select id="set-perLine" class="select">${perLineOpts.map((v) => `<option value="${v}"${String(s.perLine) === String(v) ? ' selected' : ''}>${v === 'auto' ? 'Auto' : v}</option>`).join('')}</select>
        </div>
        <div class="setting-row">
          <div><strong>Dash spacing</strong><p class="muted small">Number of dashes between notes.</p></div>
          <select id="set-spacing" class="select">${[1, 2, 3, 4].map((v) => `<option value="${v}"${s.spacing === v ? ' selected' : ''}>${v}</option>`).join('')}</select>
        </div>
        <div class="setting-row">
          <div><strong>Show step numbers</strong><p class="muted small">Display the step number above each note.</p></div>
          <label class="switch"><input type="checkbox" id="set-showSteps"${s.showSteps ? ' checked' : ''}><span class="switch-track"></span><span class="sr-only">Show step numbers</span></label>
        </div>
        <div class="setting-row">
          <div><strong>Default song view</strong><p class="muted small">How tabs are shown when you open a song.</p></div>
          <select id="set-defaultView" class="select">
            <option value="tab"${s.defaultView === 'tab' ? ' selected' : ''}>Tablature</option>
            <option value="list"${s.defaultView === 'list' ? ' selected' : ''}>Numbered list</option>
          </select>
        </div>
        <div class="settings-preview">
          <p class="muted small">Preview — E minor pentatonic</p>
          <div id="settings-preview">${renderTabBlock({ tuning: 'Standard E' }, exampleTabs().map((tab, index) => ({ tab, index })))}</div>
        </div>
      </section>

      <section class="card settings-card">
        <h2 class="card-title">Backup &amp; restore</h2>
        <p class="muted">Your songs are saved in this browser only. Export a backup regularly, and use it to move your library to another device or browser.</p>
        <div class="button-row">
          <button type="button" class="btn primary" data-action="export">${icon('download')} Export collection (JSON)</button>
          <button type="button" class="btn" data-action="import">${icon('upload')} Import from JSON</button>
        </div>
        <p class="muted small">${plural(Store.all().length, 'song')} · ${plural(Store.all().reduce((n, x) => n + x.tabs.length, 0), 'tab')} · about ${kb} KB of storage used${storageAvailable ? '' : ' · <strong class="text-danger">LocalStorage is unavailable in this browser</strong>'}</p>
      </section>

      <section class="card settings-card">
        <h2 class="card-title">Keyboard shortcuts</h2>
        <div class="kbd-grid">
          <div>
            <h3 class="kbd-head">Tab editor</h3>
            ${shortcut(['Click'], 'Put the cursor on a string')}
            ${shortcut(['0–9'], 'Type the fret (1 then 2 = 12)')}
            ${shortcut(['h', 'p', '/', '\\\\', 'b', 'r', '~'], 'Technique, then the fret it goes to (3 h 5 p 4 → 3h5p4)')}
            ${shortcut(['←', '→'], 'Previous / next step (Enter = next)')}
            ${shortcut(['↑', '↓'], 'Move cursor to another string')}
            ${shortcut(['Shift', '↑ ↓'], 'Move the note to another string')}
            ${shortcut(['Shift', 'Enter'], 'New section (or N)')}
            ${shortcut(['Del'], 'Delete step')}
            ${shortcut(['I'], 'Insert empty step before')}
            ${shortcut(['Ctrl', 'Z'], 'Undo')}
            ${shortcut(['Ctrl', 'S'], 'Save song')}
          </div>
          <div>
            <h3 class="kbd-head">Song &amp; practice</h3>
            ${shortcut(['←', '→'], 'Previous / next step')}
            ${shortcut(['↑', '↓'], 'Previous / next section (practice)')}
            ${shortcut(['Space'], 'Next step (practice)')}
            ${shortcut(['P'], 'Open practice mode')}
            ${shortcut(['Esc'], 'Exit practice mode')}
            ${shortcut(['/'], 'Search songs')}
          </div>
        </div>
      </section>

      <section class="card settings-card danger-zone">
        <h2 class="card-title">Danger zone</h2>
        <div class="setting-row">
          <div><strong>Delete all songs</strong><p class="muted small">Permanently removes every song and tab from this browser.</p></div>
          <button type="button" class="btn danger-ghost" data-action="clear-all" ${Store.all().length ? '' : 'disabled'}>${icon('trash')} Delete everything</button>
        </div>
      </section>`;
  }

  function onSettingChange(el) {
    const s = state.settings;
    const key = el.id.replace('set-', '');
    if (key === 'perLine') s.perLine = el.value === 'auto' ? 'auto' : parseInt(el.value, 10);
    else if (key === 'spacing') s.spacing = parseInt(el.value, 10);
    else if (key === 'showSteps') s.showSteps = el.checked;
    else if (key === 'defaultView') { s.defaultView = el.value; state.detail.view = el.value; }
    else return;
    Settings.save();
    const prev = $('#settings-preview');
    if (prev) prev.innerHTML = renderTabBlock({ tuning: 'Standard E' }, exampleTabs().map((tab, index) => ({ tab, index })));
    toast('Settings saved', 'success', { duration: 1500 });
  }

  /* ---------- Song detail ---------- */
  function renderDetail(route, changed) {
    const song = Store.get(route.id);
    const view = $('#view');
    if (!song) {
      view.innerHTML = `
        <div class="empty-state">
          <h2>Song not found</h2>
          <p>It may have been deleted, or the link is out of date.</p>
          <div class="empty-actions"><a href="#/songs" class="btn primary">Back to My Songs</a></div>
        </div>`;
      setTitle('Not found');
      return;
    }
    if (state.detail.songId !== song.id) {
      const last = song.tabs[song.tabs.length - 1];
      state.detail = {
        songId: song.id, view: state.settings.defaultView, section: 0, selected: null,
        qaString: last ? last.string : 'e', sectionCount: 0, sectionOf: [],
      };
    }
    if (changed) Store.touch(song.id);
    view.innerHTML = viewDetail(song);
    renderDetailTabs();
    setTitle(song.title);
  }

  function viewDetail(song) {
    const id = esc(song.id);
    const enc = encodeURIComponent(song.id);
    const ref = song.referenceUrl ? normalizeUrl(song.referenceUrl) : null;
    const isYT = ref && /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(new URL(ref).hostname);
    const v = state.detail.view;

    return `
      <a href="#/songs" class="back-link">${icon('arrowLeft')} Back to collection</a>

      <header class="detail-head">
        <div class="detail-info">
          <div class="badges">${diffBadge(song.difficulty)}${song.tags.map(tagBadge).join('')}</div>
          <h1 class="detail-title">${esc(song.title)}</h1>
          <p class="detail-artist">${esc(song.artist || 'Unknown artist')}</p>
          <dl class="meta-grid">
            <div><dt>Tuning</dt><dd>${esc(tuningText(song))}</dd></div>
            <div><dt>Capo</dt><dd>${song.capo ? `Fret ${song.capo}` : 'None'}</dd></div>
            <div><dt>Tabs</dt><dd>${song.tabs.length}</dd></div>
            <div><dt>Added</dt><dd>${esc(formatDate(song.createdAt))}</dd></div>
          </dl>
        </div>
        <div class="detail-actions">
          <button type="button" class="btn primary lg" data-action="practice" data-id="${id}" ${song.tabs.length ? '' : 'disabled'}>${icon('maximize')} Practice Mode</button>
          <div class="detail-actions-row">
            <a class="btn" href="#/edit/${enc}">${icon('edit')} Edit tabs</a>
            <a class="btn" href="#/edit/${enc}?add=1">${icon('plus')} Add more tabs</a>
          </div>
          <div class="detail-actions-row">
            <button type="button" class="btn ghost sm" data-action="copy-text" data-id="${id}" ${song.tabs.length ? '' : 'disabled'}>${icon('clipboard')} Copy as text</button>
            <button type="button" class="btn ghost sm" data-action="duplicate-song" data-id="${id}">${icon('copy')} Duplicate</button>
            <button type="button" class="btn danger-ghost sm" data-action="delete-song" data-id="${id}">${icon('trash')} Delete</button>
          </div>
        </div>
      </header>

      ${song.notes || ref ? `
        <section class="card notes-card">
          ${song.notes ? `<div class="notes-body"><h2 class="card-title">Notes &amp; instructions</h2><p class="notes-text">${esc(song.notes)}</p></div>` : ''}
          ${ref ? `
            <a class="ref-link" href="${esc(ref)}" target="_blank" rel="noopener noreferrer">
              <span class="ref-icon">${icon(isYT ? 'play' : 'external')}</span>
              <span class="ref-text"><strong>${isYT ? 'Watch on YouTube' : 'Open reference'}</strong><small>${esc(shortUrl(ref))}</small></span>
              ${icon('external', 'ref-arrow')}
            </a>` : ''}
        </section>` : ''}

      <section class="card tabs-card">
        <div class="tabs-toolbar">
          <div class="seg" role="group" aria-label="View">
            <button type="button" class="seg-btn${v === 'tab' ? ' active' : ''}" data-action="detail-view" data-view="tab" aria-pressed="${v === 'tab'}">${icon('tab')} Tablature</button>
            <button type="button" class="seg-btn${v === 'list' ? ' active' : ''}" data-action="detail-view" data-view="list" aria-pressed="${v === 'list'}">${icon('list')} List</button>
          </div>
          <div class="section-nav" id="section-nav"></div>
        </div>
        <div id="detail-tabs" class="detail-tabs"></div>
        <div id="selected-step"></div>
      </section>

      ${quickAddCard(song)}`;
  }

  function renderDetailTabs() {
    const song = Store.get(state.detail.songId);
    const el = $('#detail-tabs');
    if (!el || !song) return;
    const d = state.detail;

    if (!song.tabs.length) {
      el.innerHTML = renderEmptyStaff(song, 'No tabs saved for this song yet. Use “Add more tabs” or Quick add below.');
      d.sectionCount = 0;
      updateSectionNav();
      renderSelectedStep();
      return;
    }
    if (d.selected != null && d.selected >= song.tabs.length) d.selected = null;

    const perLine = getPerLine(el.clientWidth - 36);
    const sections = buildSections(song.tabs, perLine);
    d.sectionCount = sections.length;
    d.sectionOf = [];
    sections.forEach((sec, si) => sec.items.forEach((it) => { d.sectionOf[it.index] = si; }));
    if (d.selected != null) d.section = d.sectionOf[d.selected];
    d.section = clamp(d.section, 0, sections.length - 1);

    el.innerHTML = d.view === 'list'
      ? renderTabList(song, sections, { currentSection: sections.length > 1 ? d.section : null, active: d.selected, rowAction: 'select-step', deleteAction: 'detail-delete-step' })
      : renderTabSections(song, sections, { currentSection: sections.length > 1 ? d.section : null, active: d.selected, action: 'tab-click' });
    updateSectionNav();
    renderSelectedStep();
    keepActiveVisible(el);
  }

  function updateSectionNav() {
    const el = $('#section-nav');
    if (!el) return;
    const { section: i, sectionCount: n } = state.detail;
    if (n <= 1) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <button type="button" class="btn sm" data-action="section-prev" ${i <= 0 ? 'disabled' : ''} aria-label="Previous section">${icon('chevL')}<span class="hide-sm">Previous section</span></button>
      <span class="section-nav-label">${i + 1} / ${n}</span>
      <button type="button" class="btn sm" data-action="section-next" ${i >= n - 1 ? 'disabled' : ''} aria-label="Next section"><span class="hide-sm">Next section</span>${icon('chevR')}</button>`;
  }

  function goSection(delta) {
    const d = state.detail;
    const next = clamp(d.section + delta, 0, Math.max(0, d.sectionCount - 1));
    if (next === d.section) return;
    d.section = next;
    d.selected = null;
    renderDetailTabs();
    const target = $(`#detail-tabs [data-section="${next}"]`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function selectStep(i) {
    const song = Store.get(state.detail.songId);
    if (!song || !song.tabs.length) return;
    state.detail.selected = i == null ? null : clamp(i, 0, song.tabs.length - 1);
    renderDetailTabs();
    const row = $('#detail-tabs .tab-row.active');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function renderSelectedStep() {
    const el = $('#selected-step');
    if (!el) return;
    const song = Store.get(state.detail.songId);
    const i = state.detail.selected;
    if (!song || !song.tabs.length) { el.innerHTML = ''; return; }
    if (i == null || !song.tabs[i]) {
      el.innerHTML = '<p class="hint">Tip: tap any note to select it — then edit, delete or practice from there.</p>';
      return;
    }
    const t = song.tabs[i];
    const labels = stringLabels(song);
    el.innerHTML = `
      <div class="selected-bar">
        <span class="step-pill">${i + 1}</span>
        <span class="selected-text">
          <strong>${esc(labels[t.string])}</strong> string (${ordinal(STRING_NUMBER[t.string])}) · fret <strong>${esc(tabToken(t))}</strong>${t.moves.length ? ` · ${esc(techLabel(t))}` : ''}
          ${t.instruction ? `<span class="muted"> — ${esc(t.instruction)}</span>` : ''}
        </span>
        <span class="selected-actions">
          <button type="button" class="btn sm" data-action="practice" data-id="${esc(song.id)}" data-start="${i}">${icon('play')} Practice from here</button>
          <a class="btn sm" href="#/edit/${encodeURIComponent(song.id)}?step=${i + 1}">${icon('edit')} Edit</a>
          <button type="button" class="btn sm danger-ghost" data-action="detail-delete-step" data-index="${i}">${icon('trash')} Delete</button>
          <button type="button" class="icon-btn subtle" data-action="clear-selection" aria-label="Clear selection">${icon('x')}</button>
        </span>
      </div>`;
  }

  function detailDeleteStep(i) {
    const original = Store.get(state.detail.songId);
    if (!original || !original.tabs[i]) return;
    const backup = clone(original);
    const song = clone(original);
    removeTabAt(song.tabs, i);
    if (!Store.upsert(song)) return;
    state.detail.selected = null;
    render({ keepScroll: true });
    toast(`Step ${i + 1} deleted`, 'success', {
      actionLabel: 'Undo',
      onAction: () => {
        if (Store.upsert(backup)) {
          if (currentRoute && currentRoute.name === 'song') render({ keepScroll: true });
          toast('Step restored', 'success');
        }
      },
    });
  }

  function quickAddCard(song) {
    const labels = stringLabels(song);
    const cur = state.detail.qaString;
    return `
      <section class="card quick-add">
        <div class="card-head">
          <div><h2 class="card-title">Quick add</h2><p class="muted small">Append a tab to the end of this song — saved instantly.</p></div>
        </div>
        <div class="qa-grid">
          <div class="string-picker compact" role="group" aria-label="String">
            ${ENTRY_STRINGS.map((k) => `<button type="button" class="string-btn${cur === k ? ' active' : ''}" data-action="qa-string" data-string="${k}" aria-pressed="${cur === k}" title="${ordinal(STRING_NUMBER[k])} string"><span class="sb-name">${esc(labels[k])}</span><span class="sb-num">${ordinal(STRING_NUMBER[k])}</span></button>`).join('')}
          </div>
          <div class="qa-fields">
            <input id="qa-fret" class="fret-input sm" type="text" maxlength="24" placeholder="5 or 3h5p4" aria-label="Fret, optionally with techniques, e.g. 5, 7b9, 3h5p4" autocomplete="off" autocapitalize="off" spellcheck="false">
            <input id="qa-instruction" class="input" type="text" placeholder="Instruction (optional)" maxlength="300" aria-label="Instruction">
            <button type="button" class="btn primary" data-action="qa-add">${icon('plus')} Add tab</button>
          </div>
        </div>
        <p class="field-error" id="qa-error" aria-live="polite"></p>
      </section>`;
  }

  function qaAdd() {
    const fretEl = $('#qa-fret');
    const v = parseNoteText(fretEl.value);
    if (!v.ok) {
      $('#qa-error').textContent = v.error;
      fretEl.classList.add('invalid');
      fretEl.focus();
      return;
    }
    const song = clone(Store.get(state.detail.songId));
    song.tabs.push({
      id: uid('t_'), step: song.tabs.length + 1, string: state.detail.qaString, fret: v.fret, moves: v.moves,
      instruction: $('#qa-instruction').value.trim().slice(0, 300), section: '',
    });
    renumber(song.tabs);
    if (!Store.upsert(song)) return;
    const n = song.tabs.length;
    state.detail.selected = n - 1;
    render({ keepScroll: true });
    toast(`Added step ${n}`, 'success', { duration: 1500 });
    announce(`Added step ${n}`);
    const f = $('#qa-fret');
    if (f && !isCoarsePointer()) f.focus({ preventScroll: true });
  }

  /* =========================================================
   * 9. Song editor — interactive tab grid
   *
   * The tab is drawn as six strings. A cursor (column + string) sits on it:
   * click any spot on a string and type the fret, press a technique key,
   * and move with the arrow keys. There is always one empty column for the
   * next note — at the end, or in the middle after "Insert".
   * ======================================================= */
  const TECH_KEYS = { h: 'h', p: 'p', '/': '/', '\\': '\\', b: 'b', r: 'r', '~': '~', v: '~' };

  function lastStringOf(song) {
    const last = song.tabs[song.tabs.length - 1];
    return last ? last.string : 'e';
  }

  function createEditor(song, isNew) {
    return {
      song, isNew,
      col: song.tabs.length,        // cursor column
      str: lastStringOf(song),      // cursor string
      pendingAt: song.tabs.length,  // where the empty "new note" column sits
      buffer: '',                   // digits typed into the current cell
      history: [],                  // undo snapshots
      part: -1,                     // typing the start fret (-1) or the target of move k
      chainNext: false,             // after vibrato: next number starts the next step
      pendingBreak: false,          // the next new note starts a new section
      dirty: false,
      detailsOpen: isNew || !song.tabs.length,
      baseUpdatedAt: isNew ? null : song.updatedAt,
    };
  }

  function editorFromDraft(d) {
    const ed = createEditor(d.song, !!d.isNew);
    const n = d.song.tabs.length;
    const col = parseInt(d.col != null ? d.col : d.cursor, 10);
    ed.col = clamp(isNaN(col) ? n : col, 0, n);
    if (DISPLAY_STRINGS.includes(d.str)) ed.str = d.str;
    else if (d.song.tabs[ed.col]) ed.str = d.song.tabs[ed.col].string;
    ed.dirty = true;
    ed.detailsOpen = !!d.detailsOpen;
    ed.baseUpdatedAt = d.baseUpdatedAt || null;
    ed.pendingBreak = d.pendingBreak === true;
    return ed;
  }

  const isEditorDirty = () => !!state.editor && state.editor.dirty;

  function discardEditor() {
    saveDraftSoon.cancel();
    state.editor = null;
    Draft.clear();
  }

  /* ---------- Grid model helpers ---------- */
  const colCount = () => state.editor.song.tabs.length + 1;

  /** Tab index shown in a grid column, or null for the empty column. */
  function tabIndexAt(col) {
    const p = state.editor.pendingAt;
    if (col === p) return null;
    return col < p ? col : col - 1;
  }

  function cursorTab() {
    const i = tabIndexAt(state.editor.col);
    return i == null ? null : state.editor.song.tabs[i];
  }

  function pushHistory() {
    const ed = state.editor;
    ed.history.push(JSON.stringify({ tabs: ed.song.tabs, col: ed.col, str: ed.str }));
    if (ed.history.length > 100) ed.history.shift();
  }

  function markDirty() {
    const ed = state.editor;
    if (!ed) return;
    ed.dirty = true;
    saveDraftSoon();
  }

  function afterEdit() {
    renumber(state.editor.song.tabs);
    markDirty();
    refreshEditor();
  }

  /* ---------- Cursor movement ---------- */
  function resetTyping() {
    const ed = state.editor;
    ed.buffer = '';
    ed.part = -1;
    ed.chainNext = false;
  }

  function moveTo(col, str) {
    const ed = state.editor;
    const n = ed.song.tabs.length;
    if (str && DISPLAY_STRINGS.includes(str)) ed.str = str;
    // Leaving an inserted (mid-song) empty column folds it away again.
    if (ed.pendingAt !== n && col !== ed.pendingAt) {
      if (col > ed.pendingAt) col -= 1;
      ed.pendingAt = n;
    }
    ed.col = clamp(col, 0, n);
    resetTyping();
    refreshEditor();
    saveDraftSoon();
  }

  function moveString(dir) {
    const ed = state.editor;
    const i = clamp(DISPLAY_STRINGS.indexOf(ed.str) + dir, 0, DISPLAY_STRINGS.length - 1);
    ed.str = DISPLAY_STRINGS[i];
    resetTyping();
    refreshEditor();
  }

  /** Shift+↑/↓: move the note itself to the neighbouring string. */
  function moveNoteString(dir) {
    const ed = state.editor;
    const t = cursorTab();
    if (!t) { moveString(dir); return; }
    const i = clamp(DISPLAY_STRINGS.indexOf(ed.str) + dir, 0, DISPLAY_STRINGS.length - 1);
    pushHistory();
    ed.str = DISPLAY_STRINGS[i];
    t.string = ed.str;
    resetTyping();
    afterEdit();
  }

  /* ---------- Editing ---------- */
  /**
   * Which number typing goes into: -1 = the note's start fret, k = the target
   * fret of move k (the 5 in 3h5p4 is move 0's target, the 4 is move 1's).
   */
  function targetIndex() {
    const ed = state.editor;
    const t = cursorTab();
    if (!t || ed.part < 0) return -1;
    const m = t.moves[ed.part];
    return m && TARGET_TECHS.has(m.tech) ? ed.part : -1;
  }

  function setFret(n, record = true) {
    const ed = state.editor;
    if (record) pushHistory();
    const i = tabIndexAt(ed.col);
    if (i == null) {
      const atEnd = ed.pendingAt === ed.song.tabs.length;
      const sectionBreak = atEnd && ed.pendingBreak && ed.song.tabs.length > 0;
      ed.song.tabs.splice(ed.pendingAt, 0, { id: uid('t_'), step: 0, string: ed.str, fret: n, moves: [], instruction: '', section: '', sectionBreak });
      if (atEnd) ed.pendingBreak = false;
      ed.pendingAt = ed.song.tabs.length; // the empty column moves back to the end
      if (ed.song.tabs.length === 1 && ed.detailsOpen && ed.song.title.trim()) setDetailsOpen(false);
    } else {
      const t = ed.song.tabs[i];
      t.fret = n;
      t.string = ed.str; // typing on another string moves the note there
    }
    afterEdit();
    announce(`Step ${ed.col + 1}: ${stringLabels(ed.song)[ed.str]} string, fret ${n}`);
  }

  /** Set the fret that move k goes to (e.g. the 5 in "3h5"). */
  function setTarget(k, n, record = true) {
    const t = cursorTab();
    if (!t || !t.moves[k]) return;
    if (record) pushHistory();
    t.moves[k].to = n;
    afterEdit();
    announce(`${techniqueName(t.moves[k].tech)} to ${n}`);
  }

  /** Apply a typed / tapped number to whichever part of the note is being edited. */
  function enterNumber(n, record = true) {
    const k = targetIndex();
    if (k >= 0) setTarget(k, n, record);
    else setFret(n, record);
  }

  /** Type a digit into the current cell. "1" then "2" gives 12; values above 24 restart. */
  function typeDigit(d) {
    const ed = state.editor;
    advanceAfterTechnique();
    let buf = ed.buffer + d;
    if (buf.length > 2 || parseInt(buf, 10) > MAX_FRET) buf = d;
    ed.buffer = buf;
    enterNumber(parseInt(buf, 10), buf.length === 1);
  }

  /**
   * Add a technique to the end of the current note; the next number typed is the
   * fret it goes to. So 3, h, 5, p, 4 builds one note "3h5p4".
   * - Pressing a technique while the previous one is still waiting for its fret swaps it.
   * - Pressing the same one again removes it. "None" clears every technique.
   */
  function setTechnique(v) {
    const ed = state.editor;
    const t = cursorTab();
    if (!t) { toast('Type a fret first, then add a technique.', 'info', { duration: 1800 }); return; }
    const moves = t.moves;
    const last = moves[moves.length - 1];
    pushHistory();
    if (!v) {
      moves.length = 0;
    } else if (last && last.to == null && last.tech === v) {
      moves.pop();
    } else if (last && last.to == null && TARGET_TECHS.has(last.tech)) {
      last.tech = v;
    } else {
      if (moves.length >= MAX_MOVES) { ed.history.pop(); toast(`A note can chain up to ${MAX_MOVES} techniques.`, 'info'); return; }
      moves.push({ tech: v, to: null });
    }
    const nl = moves[moves.length - 1];
    ed.part = nl && TARGET_TECHS.has(nl.tech) ? moves.length - 1 : -1;
    ed.buffer = '';
    // Vibrato has no second fret, so after it the next number starts the next step.
    ed.chainNext = !!nl && nl.tech === '~';
    afterEdit();
  }

  /** Choose which number the fret buttons / typing change (start fret or a target). */
  function setPart(part) {
    const ed = state.editor;
    ed.part = part;
    if (targetIndex() < 0) ed.part = -1;
    ed.buffer = '';
    ed.chainNext = false;
    refreshEditor(false);
  }

  /** After vibrato, move to the next step before entering a fret (never overwrite an existing note). */
  function advanceAfterTechnique() {
    const ed = state.editor;
    if (!ed.chainNext) return;
    moveTo(ed.col + 1);
    if (tabIndexAt(ed.col) != null) insertBefore();
  }

  function deleteAtCursor() {
    const ed = state.editor;
    const i = tabIndexAt(ed.col);
    if (i == null) {
      if (ed.pendingAt !== ed.song.tabs.length) { ed.pendingAt = ed.song.tabs.length; resetTyping(); refreshEditor(); }
      return;
    }
    pushHistory();
    removeTabAt(ed.song.tabs, i);
    ed.pendingAt = ed.song.tabs.length;
    ed.col = clamp(ed.col, 0, ed.song.tabs.length);
    resetTyping();
    afterEdit();
    announce(`Step ${i + 1} deleted`);
  }

  /** Backspace peels a note from the right: 3h5p4 → 3h5p → 3h5 → 3h → 3 → (step deleted). */
  function backspace() {
    const ed = state.editor;
    const t = cursorTab();
    if (!t) { moveTo(ed.col - 1); return; }
    if (ed.buffer.length === 2) {
      ed.buffer = ed.buffer[0];
      const k = targetIndex();
      if (k >= 0) t.moves[k].to = parseInt(ed.buffer, 10); else t.fret = parseInt(ed.buffer, 10);
      afterEdit();
      return;
    }
    if (t.moves.length) {
      pushHistory();
      const last = t.moves[t.moves.length - 1];
      if (last.to != null) {
        last.to = null;
        ed.part = t.moves.length - 1;
      } else {
        t.moves.pop();
        const nl = t.moves[t.moves.length - 1];
        ed.part = nl && TARGET_TECHS.has(nl.tech) ? t.moves.length - 1 : -1;
      }
      ed.buffer = '';
      ed.chainNext = false;
      afterEdit();
      return;
    }
    deleteAtCursor();
  }

  /**
   * End the current section here: the step after the cursor (or the next new
   * note) starts a new section, even if the current line isn't full.
   * Pressing it again on a step that already starts a section removes the break.
   */
  function startNewSection() {
    const ed = state.editor;
    const n = ed.song.tabs.length;
    if (!n) { toast('Add a note first — the first notes are already Section 1.', 'info', { duration: 2200 }); return; }
    const i = tabIndexAt(ed.col);

    // On the empty column at the end: toggle "next note starts a new section".
    if (i == null && ed.pendingAt === n) {
      ed.pendingBreak = !ed.pendingBreak;
      resetTyping();
      refreshEditor();
      saveDraftSoon();
      announce(ed.pendingBreak ? 'Next note starts a new section' : 'New section cancelled');
      return;
    }
    if (i == null) return; // an inserted gap in the middle — type a note first

    // On a note: break after it. If it's the last note, the next new note starts the section.
    if (i === n - 1) {
      ed.pendingBreak = true;
      moveTo(n);
      announce('Next note starts a new section');
      return;
    }
    const next = ed.song.tabs[i + 1];
    if (startsSection(next)) {
      toast(`Step ${i + 2} already starts a new section.`, 'info', { duration: 1800 });
      moveTo(ed.col + 1);
      return;
    }
    pushHistory();
    next.sectionBreak = true;
    renumber(ed.song.tabs);
    markDirty();
    moveTo(ed.col + 1);
    announce(`New section starts at step ${i + 2}`);
  }

  /** Checkbox: does the current step start a new section? */
  function setSectionBreak(on) {
    const t = cursorTab();
    if (!t) return;
    pushHistory();
    t.sectionBreak = on;
    if (!on) t.section = '';
    afterEdit();
  }

  /** Open an empty column before the current note. */
  function insertBefore() {
    const ed = state.editor;
    const i = tabIndexAt(ed.col);
    if (i == null) return;
    ed.pendingAt = i; // the empty column now sits at the cursor
    resetTyping();
    refreshEditor();
    announce('Empty step inserted — type a fret');
  }

  function undo() {
    const ed = state.editor;
    const snap = ed.history.pop();
    if (!snap) { toast('Nothing to undo', 'info', { duration: 1200 }); return; }
    const s = JSON.parse(snap);
    ed.song.tabs = s.tabs;
    ed.pendingAt = s.tabs.length;
    ed.col = clamp(s.col, 0, s.tabs.length);
    ed.str = s.str;
    resetTyping();
    afterEdit();
  }

  /* ---------- Rendering ---------- */
  function gridPerLine(width) {
    const colW = window.innerWidth < 720 ? 38 : 44;
    return clamp(Math.floor((width - 60) / colW), 4, 40);
  }

  function renderGrid() {
    const ed = state.editor;
    const el = $('#tab-grid');
    if (!ed || !el) return;
    const labels = stringLabels(ed.song);
    const n = colCount();
    const per = gridPerLine(el.clientWidth || 800);

    const cols = [];
    for (let c = 0; c < n; c++) {
      const i = tabIndexAt(c);
      cols.push({ col: c, i, tab: i == null ? null : ed.song.tabs[i] });
    }
    const lines = [];
    let cur = null;
    let name = '';
    cols.forEach((c) => {
      const label = c.tab && c.tab.section ? c.tab.section.trim() : '';
      const brk = c.tab ? startsSection(c.tab) : (ed.pendingBreak && ed.pendingAt === ed.song.tabs.length && ed.song.tabs.length > 0);
      if (brk) { name = label; cur = { label, cont: false, cols: [] }; lines.push(cur); }
      else if (!cur || cur.cols.length >= per) { cur = { label: name, cont: !!cur && !!name, cols: [] }; lines.push(cur); }
      cur.cols.push(c);
    });

    const cell = (col, k, si, on, tab, isCursor, extra = '') =>
      `<div class="tg-cell s${si + 1}${on ? ' has-fret' : ''}${isCursor ? ' is-cursor' : ''}${extra}" data-col="${col}" data-str="${k}">${on ? `<span class="tg-note">${esc(tabToken(tab))}</span>` : ''}</div>`;

    const colHTML = (c) => {
      const isCurCol = c.col === ed.col;
      const note = c.tab && c.tab.instruction;
      return `<div class="tg-col${isCurCol ? ' is-cursor-col' : ''}${c.tab ? '' : ' is-new'}">
        <div class="tg-step${note ? ' has-note' : ''}"${note ? ` title="${esc(c.tab.instruction)}"` : ''}>${c.tab ? c.i + 1 : '+'}</div>
        ${DISPLAY_STRINGS.map((k, si) => cell(c.col, k, si, !!c.tab && c.tab.string === k, c.tab, isCurCol && ed.str === k)).join('')}
      </div>`;
    };
    // Blank staff after the last column, so there's always room to click.
    const fillHTML = (count) => Array.from({ length: count }, () => `<div class="tg-col tg-fill"><div class="tg-step"></div>${
      DISPLAY_STRINGS.map((k, si) => cell(n - 1, k, si, false, null, false)).join('')}</div>`).join('');
    const labelCol = `<div class="tg-labels"><div class="tg-step"></div>${DISPLAY_STRINGS.map((k) => `<div class="tg-label">${esc(labels[k])}</div>`).join('')}</div>`;
    const endCol = `<div class="tg-end"><div class="tg-step"></div>${DISPLAY_STRINGS.map((_, si) => `<div class="tg-cell tg-endcell s${si + 1}"></div>`).join('')}</div>`;

    el.innerHTML = lines.map((ln, li) => {
      const isLast = li === lines.length - 1;
      const title = ln.label ? (ln.cont ? `${ln.label} (cont.)` : ln.label) : `Section ${li + 1}`;
      return `<div class="tg-line">
        <div class="tg-line-head">${esc(title)}</div>
        <div class="tg-staff">${labelCol}${ln.cols.map(colHTML).join('')}${isLast ? fillHTML(Math.max(0, Math.min(per - ln.cols.length, 12))) : ''}${endCol}</div>
      </div>`;
    }).join('');

    const count = $('#grid-count');
    if (count) count.textContent = ed.song.tabs.length ? plural(ed.song.tabs.length, 'step') : 'No notes yet';
  }

  function renderPanel() {
    const ed = state.editor;
    const el = $('#tg-panel');
    if (!ed || !el) return;
    const labels = stringLabels(ed.song);
    const n = ed.song.tabs.length;
    const i = tabIndexAt(ed.col);
    const t = i == null ? null : ed.song.tabs[i];
    const strName = `${labels[ed.str]} string`;
    let title;
    let sub;
    if (!t) {
      title = ed.pendingAt === n ? `New step ${n + 1}` : `New step ${ed.col + 1} (inserted)`;
      sub = `${strName} · type or tap a fret`;
      if (ed.pendingAt === n && ed.pendingBreak && n) { title += ' · new section'; sub = `${strName} · this note starts a new section`; }
    } else {
      title = `Step ${i + 1} of ${n}`;
      sub = t.string === ed.str
        ? `${strName} · ${tabToken(t)}${t.moves.length ? ` · ${techLabel(t)}` : ''}`
        : `Note is on the ${labels[t.string]} string · pick a fret to move it to the ${strName}`;
      const k = targetIndex();
      if (k >= 0 && t.moves[k].to == null) {
        const verb = t.moves[k].tech === 'b' ? 'bends' : t.moves[k].tech === 'r' ? 'releases' : 'goes';
        sub = `${strName} · ${tabToken(t)}… · type the fret it ${verb} to`;
      } else if (ed.chainNext) {
        sub = `${strName} · ${tabToken(t)} · next number goes to step ${i + 2}`;
      }
    }
    const k = targetIndex();
    const activeFret = k >= 0 ? t.moves[k].to : (t && t.string === ed.str ? t.fret : null);
    const lastMove = t && t.moves.length ? t.moves[t.moves.length - 1] : null;
    const hasTargets = t && t.moves.some((m) => TARGET_TECHS.has(m.tech));
    const partSwitch = hasTargets ? `
      <div class="tg-part" role="group" aria-label="Which number the fret buttons change">
        <div class="seg small">
          <button type="button" class="seg-btn${k < 0 ? ' active' : ''}" data-action="tg-part" data-part="-1" aria-pressed="${k < 0}" title="Start fret">Start <b>${t.fret}</b></button>
          ${t.moves.map((m, mi) => (TARGET_TECHS.has(m.tech) ? `<button type="button" class="seg-btn${k === mi ? ' active' : ''}" data-action="tg-part" data-part="${mi}" aria-pressed="${k === mi}" title="${esc(techniqueName(m.tech))} to fret…"><code>${esc(m.tech)}</code> <b>${m.to != null ? m.to : '?'}</b></button>` : '')).join('')}
        </div>
      </div>` : '';

    el.innerHTML = `
      <div class="tg-panel-top">
        <button type="button" class="btn icon-btn" data-action="tg-move" data-delta="-1" ${ed.col === 0 ? 'disabled' : ''} aria-label="Previous step" title="Previous step (←)">${icon('chevL')}</button>
        <div class="tg-where"><strong>${esc(title)}</strong><span>${esc(sub)}</span></div>
        <button type="button" class="btn icon-btn" data-action="tg-move" data-delta="1" ${ed.col >= n ? 'disabled' : ''} aria-label="Next step" title="Next step (→ or Enter)">${icon('chevR')}</button>
        <div class="tg-panel-actions">
          <button type="button" class="icon-btn subtle" data-action="tg-undo" ${ed.history.length ? '' : 'disabled'} aria-label="Undo" title="Undo (Ctrl+Z)">${icon('undo')}</button>
          <button type="button" class="icon-btn subtle" data-action="tg-insert" ${t ? '' : 'disabled'} aria-label="Insert step before" title="Insert an empty step before this one (I)">${icon('insert')}</button>
          <button type="button" class="icon-btn subtle danger" data-action="tg-delete" ${t ? '' : 'disabled'} aria-label="Delete step" title="Delete this step (Del)">${icon('trash')}</button>
        </div>
      </div>
      <div class="tg-row2">
        ${partSwitch}
        <button type="button" class="btn sm tg-section-btn${ed.pendingBreak && ed.pendingAt === n && i == null ? ' active' : ''}" data-action="tg-section" ${n ? '' : 'disabled'} title="End this section here — the next note goes into a new section (Shift+Enter or N)">${icon('section')}<span>New section</span></button>
      </div>
      <div class="tg-frets${k >= 0 ? ' is-target' : ''}" role="group" aria-label="${k >= 0 ? 'Target fret' : 'Fret'}">
        ${Array.from({ length: MAX_FRET + 1 }, (_, f) => `<button type="button" class="chip fret-chip${activeFret === f ? ' active' : ''}" data-action="tg-fret" data-fret="${f}">${f}</button>`).join('')}
      </div>
      <div class="tg-techs" role="group" aria-label="Technique">
        ${TECHNIQUES.map((x) => `<button type="button" class="chip tech-chip${t && (x.value ? lastMove && lastMove.tech === x.value : !t.moves.length) ? ' active' : ''}" data-action="tg-tech" data-value="${esc(x.value)}" ${t ? '' : 'disabled'} title="${x.value ? `Add ${x.hint.toLowerCase()} — key ${x.value === '~' ? '~ or v' : esc(x.value)}` : 'Remove all techniques from this note'}">${x.value ? `<code>${esc(x.label)}</code> ${x.hint}` : 'None'}</button>`).join('')}
      </div>`;

    // Keep the active fret chip in view when the fret row scrolls (phones).
    const row = $('.tg-frets', el);
    const chip = $('.fret-chip.active', el);
    if (row && chip && row.scrollWidth > row.clientWidth) row.scrollLeft = chip.offsetLeft - row.clientWidth / 2 + chip.offsetWidth / 2;
  }

  function renderFields() {
    const ed = state.editor;
    const el = $('#tg-fields');
    if (!ed || !el) return;
    const t = cursorTab();
    const step = t ? tabIndexAt(ed.col) + 1 : null;
    el.innerHTML = `
      <label class="field">
        <span class="field-label">Playing instruction${step ? ` · step ${step}` : ''}</span>
        <input class="input" data-tg="instruction" type="text" maxlength="300" value="${esc(t ? t.instruction : '')}" placeholder="${t ? 'e.g. let ring, palm mute, use pinky' : 'Add a note first'}" autocomplete="off" ${t ? '' : 'disabled'}>
      </label>
      <div class="field">
        <span class="field-label">Section${step ? ` · step ${step}` : ''}</span>
        <div class="section-field">
          <label class="check"><input type="checkbox" data-tg-break ${startsSection(t) ? 'checked' : ''} ${t && step > 1 ? '' : 'disabled'}><span>New section starts here</span></label>
          <input class="input" data-tg="section" type="text" maxlength="60" value="${esc(t ? t.section : '')}" placeholder="${t ? 'Name (optional) — e.g. Intro, Solo' : 'Add a note first'}" autocomplete="off" ${t ? '' : 'disabled'}>
        </div>
      </div>
      <p class="shortcut-hint hide-touch">
        Click a string, type the fret · <kbd>h</kbd> <kbd>p</kbd> <kbd>/</kbd> <kbd>\\</kbd> <kbd>b</kbd> <kbd>r</kbd> <kbd>~</kbd> technique, then the fret it goes to (3 h 5 p 4 → 3h5p4) · <kbd>Backspace</kbd> undo last part ·
        <kbd>←</kbd> <kbd>→</kbd> step · <kbd>↑</kbd> <kbd>↓</kbd> string · <kbd>Shift</kbd>+<kbd>↑</kbd><kbd>↓</kbd> move note ·
        <kbd>Enter</kbd> next · <kbd>Shift</kbd>+<kbd>Enter</kbd> / <kbd>N</kbd> new section · <kbd>Del</kbd> delete · <kbd>I</kbd> insert · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Ctrl</kbd>+<kbd>S</kbd> save
      </p>`;
  }

  function refreshEditor(scroll = true) {
    renderGrid();
    renderPanel();
    renderFields();
    if (!scroll) return;
    const cell = $('#tab-grid .tg-cell.is-cursor');
    if (cell) cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function focusGrid() {
    if (isCoarsePointer()) return; // no on-screen keyboard needed — the fret pad is used instead
    const g = $('#tab-grid');
    if (g) g.focus({ preventScroll: true });
  }

  function setDetailsOpen(open) {
    const ed = state.editor;
    ed.detailsOpen = open;
    const card = $('#details-card');
    if (card) {
      card.classList.toggle('is-open', open);
      $('.details-toggle', card).setAttribute('aria-expanded', String(open));
    }
    saveDraftSoon();
  }

  /* ---------- Entering / mounting ---------- */
  async function enterEditor(route, changed) {
    const view = $('#view');
    if (state.editor && editorMatchesRoute(route)) {
      mountEditor(changed);
      return;
    }
    state.editor = null;

    const id = route.name === 'edit' ? route.id : null;
    const draft = Draft.load();
    if (draft) {
      const matches = id ? (!draft.isNew && draft.song.id === id) : draft.isNew;
      if (matches) {
        const saved = id ? Store.get(id) : null;
        const stale = saved && draft.baseUpdatedAt && new Date(saved.updatedAt) > new Date(draft.baseUpdatedAt);
        let useDraft = true;
        if (stale) {
          view.innerHTML = '';
          const choice = await openModal({
            title: 'Restore unsaved changes?',
            body: `<p>You have unsaved edits for <strong>${esc(draft.song.title || 'this song')}</strong> from ${esc(timeAgo(draft.savedAt))}, but the song has been changed since then.</p>`,
            actions: [
              { label: 'Use saved version', value: 'saved', variant: 'ghost' },
              { label: 'Restore my edits', value: 'draft', variant: 'primary' },
            ],
            dismissible: false,
          });
          useDraft = choice === 'draft';
          if (!useDraft) Draft.clear();
        }
        if (useDraft) {
          state.editor = editorFromDraft(draft);
          toast('Restored your unsaved progress', 'info');
        }
      } else {
        view.innerHTML = '';
        const choice = await openModal({
          title: 'Unsaved draft found',
          body: `<p>You have unsaved progress on <strong>${esc(draft.song.title || 'an untitled song')}</strong> (${plural(draft.song.tabs.length, 'tab')}, ${esc(timeAgo(draft.savedAt))}).</p><p class="muted">Starting something else will discard it.</p>`,
          actions: [
            { label: 'Discard draft', value: 'discard', variant: 'danger-ghost' },
            { label: 'Resume draft', value: 'resume', variant: 'primary' },
          ],
          dismissible: false,
        });
        if (choice === 'resume') {
          location.hash = draft.isNew ? '#/new' : `#/edit/${encodeURIComponent(draft.song.id)}`;
          return;
        }
        Draft.clear();
      }
    }

    if (!state.editor) {
      if (id) {
        const song = Store.get(id);
        if (!song) {
          toast('That song no longer exists.', 'error');
          replaceHash('#/songs');
          render();
          return;
        }
        state.editor = createEditor(clone(song), false);
        const q = route.query;
        const step = parseInt(q.get('step'), 10);
        if (step >= 1 && step <= song.tabs.length) {
          state.editor.col = step - 1;
          state.editor.str = song.tabs[step - 1].string;
        }
        if (q.get('details') === '1') state.editor.detailsOpen = true;
      } else {
        state.editor = createEditor(newSong(), true);
      }
    }
    mountEditor(true);
  }

  function mountEditor(initial) {
    const ed = state.editor;
    $('#view').innerHTML = viewEditor();
    refreshEditor(false);
    setTitle(ed.isNew ? 'New Song' : `Edit · ${ed.song.title}`);
    setAutosaveStatus(isEditorDirty() ? 'Draft auto-saved · not yet saved to library' : 'Changes are auto-saved as a draft');
    if (!initial) return;
    if (ed.isNew && !ed.song.title && ed.detailsOpen) {
      const t = $('[data-field="title"]');
      if (t && !isCoarsePointer()) t.focus();
      return;
    }
    focusGrid();
    if (currentRoute.query.get('step') || currentRoute.query.get('add')) {
      const cell = $('#tab-grid .tg-cell.is-cursor');
      if (cell) cell.scrollIntoView({ block: 'center' });
    }
  }

  function setAutosaveStatus(text) {
    const el = $('#autosave-status');
    if (el) el.textContent = text;
  }

  function detailsSummary(s) {
    return [s.artist, s.difficulty, tuningText(s), s.capo ? `Capo ${s.capo}` : null, s.tags.length ? s.tags.join(', ') : null]
      .filter(Boolean).join(' · ');
  }

  function viewEditor() {
    const ed = state.editor;
    const s = ed.song;
    return `
      <div class="page-head editor-head">
        <div class="editor-head-text">
          <p class="eyebrow">${ed.isNew ? 'New song' : 'Editing song'}</p>
          <h1 id="editor-title">${esc(s.title || 'Untitled song')}</h1>
          <p class="muted small" id="autosave-status"></p>
        </div>
        <div class="head-actions">
          <button type="button" class="btn ghost" data-action="editor-cancel">Cancel</button>
          <button type="button" class="btn primary" data-action="editor-save">${icon('check')} Save Song</button>
        </div>
      </div>

      <section class="card details${ed.detailsOpen ? ' is-open' : ''}" id="details-card">
        <button type="button" class="details-toggle" data-action="toggle-details" aria-expanded="${ed.detailsOpen}" aria-controls="details-body">
          <span class="details-toggle-text">
            <strong>Song details</strong>
            <span class="muted small" id="details-summary">${esc(detailsSummary(s))}</span>
          </span>
          ${icon('chevD', 'chev')}
        </button>
        <div class="details-body" id="details-body">
          <div class="form-grid">
            <label class="field span-2">
              <span class="field-label">Song name <em class="req">*</em></span>
              <input class="input" data-field="title" type="text" maxlength="120" value="${esc(s.title)}" placeholder="e.g. Nothing Else Matters" autocomplete="off">
            </label>
            <label class="field">
              <span class="field-label">Artist / Band</span>
              <input class="input" data-field="artist" type="text" maxlength="120" value="${esc(s.artist)}" placeholder="e.g. Metallica" autocomplete="off">
            </label>
            <label class="field">
              <span class="field-label">YouTube / reference URL</span>
              <input class="input" data-field="referenceUrl" type="url" maxlength="2000" value="${esc(s.referenceUrl)}" placeholder="https://youtube.com/watch?v=…" autocomplete="off">
            </label>
            <div class="field">
              <span class="field-label">Difficulty</span>
              <div class="seg seg-full" role="radiogroup" aria-label="Difficulty">
                ${DIFFICULTIES.map((d) => `<button type="button" role="radio" aria-checked="${s.difficulty === d}" class="seg-btn${s.difficulty === d ? ' active' : ''}" data-action="set-difficulty" data-value="${d}">${d}</button>`).join('')}
              </div>
            </div>
            <div class="field field-pair">
              <label class="field">
                <span class="field-label">Tuning</span>
                <select class="select" data-field="tuning">${TUNINGS.map((t) => `<option${s.tuning === t ? ' selected' : ''}>${t}</option>`).join('')}</select>
              </label>
              <label class="field">
                <span class="field-label">Capo</span>
                <select class="select" data-field="capo">
                  <option value="0">No capo</option>
                  ${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}"${s.capo === i + 1 ? ' selected' : ''}>Fret ${i + 1}</option>`).join('')}
                </select>
              </label>
            </div>
            <label class="field span-2${s.tuning === 'Custom' ? '' : ' hidden'}" id="custom-tuning-field">
              <span class="field-label">Custom tuning (low → high)</span>
              <input class="input" data-field="customTuning" type="text" maxlength="40" value="${esc(s.customTuning)}" placeholder="e.g. D A D G A D" autocomplete="off">
            </label>
            <div class="field span-2">
              <span class="field-label">Tags <span class="muted">(optional)</span></span>
              <div class="chips">${TAGS.map((t) => `<button type="button" class="chip${s.tags.includes(t) ? ' active' : ''}" data-action="toggle-tag" data-tag="${t}" aria-pressed="${s.tags.includes(t)}">${t}</button>`).join('')}</div>
            </div>
            <label class="field span-2">
              <span class="field-label">Notes</span>
              <textarea class="input" data-field="notes" rows="3" maxlength="5000" placeholder="Strumming pattern, tempo, which part of the video to watch…">${esc(s.notes)}</textarea>
            </label>
          </div>
        </div>
      </section>

      <section class="card grid-card" aria-label="Tab editor">
        <div class="card-head">
          <div><h2 class="card-title">Tab</h2><p class="muted small" id="grid-count"></p></div>
          <p class="grid-tip"><span class="hide-touch">Click any spot on a string, then type the fret number</span><span class="show-touch-inline">Tap a spot on a string, then tap a fret below</span></p>
        </div>
        <div id="tab-grid" class="tab-grid" tabindex="0" data-action="tg-grid" aria-label="Tab editor. Click a position on a string and type a fret number. Arrow keys move the cursor."></div>
        <div id="tg-panel" class="tg-panel"></div>
        <div id="tg-fields" class="tg-fields"></div>
      </section>

      <div class="editor-savebar">
        <button type="button" class="btn ghost" data-action="editor-cancel">Cancel</button>
        <button type="button" class="btn primary lg" data-action="editor-save">${icon('check')} Save Song</button>
      </div>`;
  }

  function onDetailField(el) {
    const ed = state.editor;
    const field = el.dataset.field;
    let value = el.value;
    if (field === 'capo') value = clamp(parseInt(value, 10) || 0, 0, 12);
    ed.song[field] = value;

    if (field === 'title') {
      $('#editor-title').textContent = value.trim() || 'Untitled song';
      el.classList.remove('invalid');
    }
    if (field === 'referenceUrl') el.classList.remove('invalid');
    if (field === 'tuning') $('#custom-tuning-field').classList.toggle('hidden', value !== 'Custom');
    if (field === 'tuning' || field === 'customTuning') { renderGrid(); renderPanel(); }
    $('#details-summary').textContent = detailsSummary(ed.song);
    markDirty();
  }

  /* ---------- Saving / leaving ---------- */
  async function editorSave(mode = 'open') {
    const ed = state.editor;
    if (!ed) return false;
    const s = ed.song;

    s.title = s.title.trim();
    if (!s.title) {
      setDetailsOpen(true);
      const t = $('[data-field="title"]');
      if (t) { t.classList.add('invalid'); t.focus(); }
      toast('Please enter a song name before saving.', 'error');
      return false;
    }
    if (s.referenceUrl.trim()) {
      const url = normalizeUrl(s.referenceUrl);
      if (!url) {
        setDetailsOpen(true);
        const u = $('[data-field="referenceUrl"]');
        if (u) { u.classList.add('invalid'); u.focus(); }
        toast('The reference URL doesn’t look valid. Use a full web address like https://youtube.com/…', 'error');
        return false;
      }
      s.referenceUrl = url;
    } else {
      s.referenceUrl = '';
    }

    if (ed.isNew) {
      const dup = Store.all().find((x) => x.id !== s.id && x.title.toLowerCase() === s.title.toLowerCase()
        && (x.artist || '').trim().toLowerCase() === (s.artist || '').trim().toLowerCase());
      if (dup) {
        const ok = await confirmDialog({
          title: 'Song already exists',
          message: `“${esc(dup.title)}”${dup.artist ? ` by ${esc(dup.artist)}` : ''} is already in your library. Save this as a separate song anyway?`,
          confirmLabel: 'Save anyway',
          danger: false,
        });
        if (!ok) return false;
      }
    }

    s.artist = s.artist.trim();
    s.customTuning = (s.customTuning || '').trim();
    s.tabs.forEach((t) => { t.instruction = (t.instruction || '').trim(); t.section = (t.section || '').trim(); });
    renumber(s.tabs);
    const record = clone(s);
    if (ed.isNew) record.createdAt = new Date().toISOString();
    if (!Store.upsert(record)) return false;

    saveDraftSoon.cancel();
    Draft.clear();
    const msg = `“${s.title}” saved · ${plural(s.tabs.length, 'tab')}`;

    if (mode === 'open') {
      state.editor = null;
      toast(msg, 'success');
      location.hash = `#/song/${encodeURIComponent(record.id)}`;
    } else {
      const saved = Store.get(record.id);
      ed.isNew = false;
      ed.dirty = false;
      ed.song.createdAt = saved.createdAt;
      ed.baseUpdatedAt = saved.updatedAt;
      replaceHash(`#/edit/${encodeURIComponent(record.id)}`);
      currentRoute = parseHash();
      const eyebrow = $('.editor-head .eyebrow');
      if (eyebrow) eyebrow.textContent = 'Editing song';
      setAutosaveStatus(`Saved to library ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
      toast(msg, 'success');
    }
    return true;
  }

  async function confirmLeaveEditor() {
    const ed = state.editor;
    if (!ed) return true;
    if (!isEditorDirty()) { discardEditor(); return true; }
    const choice = await openModal({
      title: 'Unsaved changes',
      body: `<p>You have unsaved changes to <strong>${esc(ed.song.title || 'this song')}</strong>. What would you like to do?</p>`,
      actions: [
        { label: 'Keep editing', value: 'stay', variant: 'ghost' },
        { label: 'Discard', value: 'discard', variant: 'danger-ghost' },
        { label: 'Save song', value: 'save', variant: 'primary' },
      ],
    });
    if (choice === 'discard') { discardEditor(); return true; }
    if (choice === 'save') {
      const ok = await editorSave('stay');
      if (ok) { state.editor = null; return true; }
    }
    return false;
  }

  async function editorCancel() {
    const ed = state.editor;
    if (!ed) return;
    const target = ed.isNew ? '#/dashboard' : `#/song/${encodeURIComponent(ed.song.id)}`;
    if (isEditorDirty()) {
      const ok = await confirmDialog({
        title: 'Discard changes?',
        message: `Your unsaved changes to <strong>${esc(ed.song.title || 'this song')}</strong> will be lost.`,
        confirmLabel: 'Discard changes',
      });
      if (!ok) return;
    }
    discardEditor();
    location.hash = target;
  }

  /* ---------- Keyboard ---------- */
  function handleEditorKey(e) {
    const ed = state.editor;
    if (!ed) return;
    const t = e.target;
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && k.toLowerCase() === 's') { e.preventDefault(); editorSave('stay'); return; }
    if (isTypingTarget(t)) {
      // Enter / Esc in the instruction fields hands control back to the grid.
      if ((k === 'Enter' || k === 'Escape') && t.matches('[data-tg]')) { e.preventDefault(); focusGrid(); }
      return;
    }
    if (mod && k.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (mod || e.altKey) return;
    if ((t.tagName === 'BUTTON' || t.tagName === 'A') && (k === 'Enter' || k === ' ')) return; // let buttons click

    if (/^\d$/.test(k)) { e.preventDefault(); typeDigit(k); return; }
    if (Object.prototype.hasOwnProperty.call(TECH_KEYS, k)) { e.preventDefault(); setTechnique(TECH_KEYS[k]); return; }
    switch (k) {
      case 'ArrowLeft': e.preventDefault(); moveTo(ed.col - 1); break;
      case 'Enter': e.preventDefault(); if (e.shiftKey) startNewSection(); else moveTo(ed.col + 1); break;
      case 'n': case 'N': e.preventDefault(); startNewSection(); break;
      case 'ArrowRight': case ' ': e.preventDefault(); moveTo(ed.col + 1); break;
      case 'ArrowUp': e.preventDefault(); if (e.shiftKey) moveNoteString(-1); else moveString(-1); break;
      case 'ArrowDown': e.preventDefault(); if (e.shiftKey) moveNoteString(1); else moveString(1); break;
      case 'Backspace': e.preventDefault(); backspace(); break;
      case 'Delete': e.preventDefault(); deleteAtCursor(); break;
      case 'Home': e.preventDefault(); moveTo(0); break;
      case 'End': e.preventDefault(); moveTo(ed.song.tabs.length); break;
      case 'i': case 'I': case 'Insert': e.preventDefault(); insertBefore(); break;
      default: break;
    }
  }

  /* =========================================================
   * 10. Practice mode
   * ======================================================= */
  function openPractice(songId, start = 0) {
    const song = Store.get(songId);
    if (!song) return;
    if (!song.tabs.length) { toast('Add some tabs to this song before practicing.', 'error'); return; }
    state.practice = { songId, index: clamp(start, 0, song.tabs.length - 1), fs: false, wakeLock: null };
    const el = $('#practice');
    el.hidden = false;
    document.body.classList.add('no-scroll');
    renderPractice();
    el.focus && el.focus();

    const root = document.documentElement;
    if (root.requestFullscreen && !document.fullscreenElement) {
      root.requestFullscreen().then(() => { if (state.practice) state.practice.fs = true; }).catch(() => { /* overlay only */ });
    }
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then((lock) => {
        if (state.practice) state.practice.wakeLock = lock; else lock.release();
      }).catch(() => { /* not supported here */ });
    }
  }

  function closePractice() {
    const p = state.practice;
    if (!p) return;
    state.practice = null;
    if (p.wakeLock) p.wakeLock.release().catch(() => {});
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    const el = $('#practice');
    el.hidden = true;
    el.innerHTML = '';
    document.body.classList.remove('no-scroll');
    if (currentRoute && currentRoute.name === 'song' && state.detail.songId === p.songId) {
      state.detail.selected = p.index;
      renderDetailTabs();
    }
  }

  function renderPractice() {
    const p = state.practice;
    const song = p && Store.get(p.songId);
    if (!song || !song.tabs.length) { closePractice(); return; }
    p.index = clamp(p.index, 0, song.tabs.length - 1);
    const zoom = state.settings.practiceZoom;
    const stageWidth = Math.min(window.innerWidth, 1400) - 64;
    const sections = buildSections(song.tabs, getPerLine(stageWidth, 15 * zoom));
    const si = sections.findIndex((sec) => sec.items.some((it) => it.index === p.index));
    const sec = sections[si];
    const tab = song.tabs[p.index];
    const labels = stringLabels(song);
    const last = song.tabs.length - 1;
    const pct = song.tabs.length > 1 ? (p.index / last) * 100 : 100;
    const nextSec = sections[si + 1];

    $('#practice').innerHTML = `
      <div class="pr-top">
        <div class="pr-title">
          <strong>${esc(song.title)}</strong>
          <span>${esc(song.artist || 'Unknown artist')} · ${esc(tuningText(song))}${song.capo ? ` · Capo ${song.capo}` : ''}</span>
        </div>
        <div class="pr-top-actions">
          <button type="button" class="btn icon-btn" data-action="pr-zoom" data-delta="-0.2" aria-label="Smaller tab" title="Smaller (−)">A−</button>
          <button type="button" class="btn icon-btn" data-action="pr-zoom" data-delta="0.2" aria-label="Larger tab" title="Larger (+)">A+</button>
          <button type="button" class="btn icon-btn" data-action="pr-close" aria-label="Exit practice mode" title="Exit (Esc)">${icon('x')}</button>
        </div>
      </div>

      <div class="pr-section">
        <span class="pr-section-name">${esc(sectionTitle(sec, si))}</span>
        <span class="muted">Section ${si + 1} of ${sections.length}</span>
      </div>

      <div class="pr-stage" data-action="pr-tap" style="--pr-zoom:${zoom}">
        ${renderTabBlock(song, sec.items, { activeIndex: p.index, played: p.index, showSteps: true })}
      </div>

      <div class="pr-now" aria-live="polite">
        <div class="pr-step">Step <strong>${p.index + 1}</strong> of ${song.tabs.length}</div>
        <div class="pr-note">
          <span class="pr-string">${esc(labels[tab.string])}<small>${ordinal(STRING_NUMBER[tab.string])} string</small></span>
          <span class="pr-fret"><span>${tab.fret}${tab.moves.filter((m) => m.to != null).map((m) => `<span class="pr-arrow">→</span>${m.to}`).join('')}</span><small>fret</small></span>
          ${tab.moves.length ? `<span class="pr-tech">${esc(techLabel(tab))}</span>` : ''}
        </div>
        ${tab.instruction ? `<div class="pr-instruction">${esc(tab.instruction)}</div>` : ''}
        ${nextSec && p.index === sec.items[sec.items.length - 1].index ? `<div class="pr-upnext">Up next: ${esc(sectionTitle(nextSec, si + 1))}</div>` : ''}
      </div>

      <div class="pr-controls">
        <button type="button" class="btn lg" data-action="pr-section" data-delta="-1" ${si === 0 ? 'disabled' : ''} aria-label="Previous section">${icon('skipBack')}<span>Section</span></button>
        <button type="button" class="btn lg" data-action="pr-step" data-delta="-1" ${p.index === 0 ? 'disabled' : ''} aria-label="Previous step">${icon('chevL')}<span>Prev</span></button>
        <button type="button" class="btn lg primary" data-action="pr-step" data-delta="1" ${p.index === last ? 'disabled' : ''} aria-label="Next step"><span>Next</span>${icon('chevR')}</button>
        <button type="button" class="btn lg" data-action="pr-section" data-delta="1" ${si === sections.length - 1 ? 'disabled' : ''} aria-label="Next section"><span>Section</span>${icon('skipFwd')}</button>
      </div>
      <div class="pr-progress" role="progressbar" aria-valuemin="1" aria-valuemax="${song.tabs.length}" aria-valuenow="${p.index + 1}"><div style="width:${pct}%"></div></div>
      <p class="pr-hint hide-touch">← → step · ↑ ↓ section · Space next · + − size · Esc exit</p>
      <p class="pr-hint show-touch">Tap the right side of the tab for next, left side for previous</p>`;
    keepActiveVisible($('#practice'));
  }

  function practiceStep(delta) {
    const p = state.practice;
    const song = Store.get(p.songId);
    const next = clamp(p.index + delta, 0, song.tabs.length - 1);
    if (next !== p.index) { p.index = next; renderPractice(); }
  }

  function practiceSection(delta) {
    const p = state.practice;
    const song = Store.get(p.songId);
    const zoom = state.settings.practiceZoom;
    const sections = buildSections(song.tabs, getPerLine(Math.min(window.innerWidth, 1400) - 64, 15 * zoom));
    const si = sections.findIndex((sec) => sec.items.some((it) => it.index === p.index));
    const ti = clamp(si + delta, 0, sections.length - 1);
    if (ti === si && delta > 0) return; // already in the last section
    p.index = sections[ti].items[0].index; // previous on the first section rewinds to its start
    renderPractice();
  }

  function practiceZoom(delta) {
    state.settings.practiceZoom = clamp(Math.round((state.settings.practiceZoom + delta) * 10) / 10, 1, 3);
    Settings.save();
    renderPractice();
  }

  function handlePracticeKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'Escape': e.preventDefault(); closePractice(); break;
      case 'Enter': if (e.target.tagName === 'BUTTON') return; e.preventDefault(); practiceStep(1); break;
      case 'ArrowRight': case ' ': e.preventDefault(); practiceStep(1); break;
      case 'ArrowLeft': case 'Backspace': e.preventDefault(); practiceStep(-1); break;
      case 'ArrowUp': case 'PageUp': e.preventDefault(); practiceSection(-1); break;
      case 'ArrowDown': case 'PageDown': e.preventDefault(); practiceSection(1); break;
      case 'Home': e.preventDefault(); state.practice.index = 0; renderPractice(); break;
      case '+': case '=': e.preventDefault(); practiceZoom(0.2); break;
      case '-': case '_': e.preventDefault(); practiceZoom(-0.2); break;
      default: break;
    }
  }

  /* =========================================================
   * 11. Song actions
   * ======================================================= */
  async function deleteSong(id) {
    const s = Store.get(id);
    if (!s) return;
    const ok = await confirmDialog({
      title: 'Delete this song?',
      message: `<strong>${esc(s.title)}</strong>${s.artist ? ` by ${esc(s.artist)}` : ''} and its ${plural(s.tabs.length, 'tab')} will be permanently removed from your library.`,
      confirmLabel: 'Delete song',
    });
    if (!ok) return;
    const backup = clone(s);
    if (!Store.remove(id)) return;
    toast(`“${s.title}” deleted`, 'success', {
      actionLabel: 'Undo',
      onAction: () => {
        if (Store.get(backup.id)) return;
        if (Store.commit((list) => list.push(backup))) {
          toast('Song restored', 'success');
          if (currentRoute && ['songs', 'dashboard', 'recent', 'settings'].includes(currentRoute.name)) render({ keepScroll: true });
        }
      },
    });
    if (currentRoute.name === 'song') location.hash = '#/songs';
    else render({ keepScroll: true });
  }

  function duplicateSong(id) {
    const s = Store.get(id);
    if (!s) return;
    const now = new Date().toISOString();
    const copy = clone(s);
    copy.id = uid('s_');
    copy.title = `${s.title} (Copy)`.slice(0, 120);
    copy.createdAt = now;
    copy.lastOpenedAt = null;
    copy.tabs.forEach((t) => { t.id = uid('t_'); });
    if (!Store.upsert(copy)) return;
    if (currentRoute.name !== 'song') render({ keepScroll: true });
    toast(`Created “${copy.title}”`, 'success', {
      actionLabel: 'Open',
      onAction: () => go(`#/song/${encodeURIComponent(copy.id)}`),
    });
  }

  function copyToClipboard(text) {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
      return ok;
    };
    const done = (ok) => toast(ok ? 'Tab copied to clipboard' : 'Could not access the clipboard', ok ? 'success' : 'error');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => done(true)).catch(() => done(fallback()));
    } else {
      done(fallback());
    }
  }

  function loadExample() {
    const up = exampleTabs();
    const down = up.slice().reverse();
    const tabs = [...up, ...down].map((t, i) => ({
      ...t,
      id: uid('t_'),
      section: i === 0 ? 'Ascending' : i === up.length ? 'Descending' : '',
      instruction: i === 0 ? 'Middle finger for fret 2, ring finger for fret 3' : i === up.length ? 'Same notes, back down' : '',
    }));
    const song = normalizeSong({
      id: uid('s_'), title: 'E Minor Pentatonic (Example)', artist: 'TabVault', difficulty: 'Beginner', tuning: 'Standard E',
      notes: 'An example created by TabVault. Play each note slowly and evenly, then try it with a metronome. Edit or delete this song any time.',
      tags: ['Scale', 'Lead'], tabs,
    });
    if (Store.upsert(song)) {
      toast('Example song added', 'success');
      go(`#/song/${encodeURIComponent(song.id)}`);
    }
  }

  /* =========================================================
   * 12. Import / export
   * ======================================================= */
  function exportData() {
    const songs = Store.all();
    if (!songs.length) { toast('Nothing to export yet — add a song first.', 'info'); return; }
    const payload = { app: 'TabVault', version: 1, exportedAt: new Date().toISOString(), songCount: songs.length, songs };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tabvault-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast(`Exported ${plural(songs.length, 'song')}`, 'success');
  }

  /** Validate an imported JSON payload. Accepts a TabVault export, an array of songs, or a single song. */
  function validateImport(data) {
    let list = null;
    if (Array.isArray(data)) list = data;
    else if (data && typeof data === 'object' && Array.isArray(data.songs)) list = data.songs;
    else if (data && typeof data === 'object' && typeof data.title === 'string') list = [data];
    if (!list) return { error: 'This file doesn’t look like a TabVault backup (no list of songs found).' };

    const stats = { droppedTabs: 0 };
    const songs = [];
    const seen = new Set();
    let skipped = 0;
    list.forEach((raw) => {
      const s = normalizeSong(raw, stats);
      if (!s) { skipped += 1; return; }
      if (seen.has(s.id)) s.id = uid('s_');
      seen.add(s.id);
      songs.push(s);
    });
    return { songs, skipped, droppedTabs: stats.droppedTabs };
  }

  function importFile(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast('That file is too large to be a TabVault backup.', 'error'); return; }
    const reader = new FileReader();
    reader.onerror = () => toast('Could not read that file.', 'error');
    reader.onload = async () => {
      let data;
      try { data = JSON.parse(String(reader.result)); }
      catch (_) { toast('That file isn’t valid JSON.', 'error'); return; }

      const result = validateImport(data);
      if (result.error) { toast(result.error, 'error'); return; }
      if (!result.songs.length) { toast('No valid songs were found in that file.', 'error'); return; }

      const existing = Store.all();
      const ids = new Set(existing.map((s) => s.id));
      const overlap = result.songs.filter((s) => ids.has(s.id)).length;
      const tabCount = result.songs.reduce((n, s) => n + s.tabs.length, 0);
      const body = `
        <p>Found <strong>${plural(result.songs.length, 'valid song')}</strong> with ${plural(tabCount, 'tab')}.</p>
        ${result.skipped ? `<p class="text-warn">${result.skipped} ${result.skipped === 1 ? 'entry' : 'entries'} without a valid title will be skipped.</p>` : ''}
        ${result.droppedTabs ? `<p class="text-warn">${plural(result.droppedTabs, 'tab')} with an invalid string or fret will be skipped.</p>` : ''}
        ${existing.length ? `<p><strong>Merge</strong> adds these to your ${plural(existing.length, 'current song')}${overlap ? ` (${overlap} with matching IDs will be updated)` : ''}. <strong>Replace</strong> deletes your current library first.</p>` : ''}`;
      const actions = existing.length
        ? [
          { label: 'Cancel', value: null, variant: 'ghost' },
          { label: 'Replace library', value: 'replace', variant: 'danger-ghost' },
          { label: 'Merge', value: 'merge', variant: 'primary' },
        ]
        : [{ label: 'Cancel', value: null, variant: 'ghost' }, { label: 'Import', value: 'merge', variant: 'primary' }];
      const choice = await openModal({ title: 'Import songs', body, actions });
      if (!choice) return;

      if (choice === 'replace') {
        const sure = await confirmDialog({
          title: 'Replace your whole library?',
          message: `Your current ${plural(existing.length, 'song')} will be deleted and replaced with ${plural(result.songs.length, 'song')} from the file. Consider exporting a backup first.`,
          confirmLabel: 'Replace library',
        });
        if (!sure) return;
        if (Store.replaceAll(result.songs)) toast(`Library replaced · ${plural(result.songs.length, 'song')} imported`, 'success');
      } else {
        const ok = Store.commit((list) => {
          result.songs.forEach((s) => {
            const i = list.findIndex((x) => x.id === s.id);
            if (i >= 0) list[i] = s; else list.push(s);
          });
        });
        if (ok) toast(`Imported ${plural(result.songs.length, 'song')}`, 'success');
      }
      render({ keepScroll: true });
    };
    reader.readAsText(file);
  }

  async function clearAll() {
    const n = Store.all().length;
    if (!n) return;
    const choice = await openModal({
      title: 'Delete everything?',
      body: `<p>This permanently deletes all <strong>${plural(n, 'song')}</strong> from this browser. This cannot be undone.</p><p class="muted">Tip: export a backup first so you can restore later.</p>`,
      actions: [
        { label: 'Cancel', value: null, variant: 'ghost' },
        { label: 'Export backup', value: 'export', variant: 'ghost' },
        { label: 'Delete everything', value: 'delete', variant: 'danger' },
      ],
    });
    if (choice === 'export') { exportData(); return; }
    if (choice !== 'delete') return;
    if (Store.replaceAll([])) {
      state.detail.songId = null;
      toast('All songs deleted', 'success');
      render({ keepScroll: true });
    }
  }

  /* =========================================================
   * 13. Event wiring & init
   * ======================================================= */
  const actions = {
    // navigation & songs
    'open-song': (el) => go(`#/song/${encodeURIComponent(el.dataset.id)}`),
    'edit-song': (el) => go(`#/edit/${encodeURIComponent(el.dataset.id)}?details=1`),
    'duplicate-song': (el) => duplicateSong(el.dataset.id),
    'delete-song': (el) => deleteSong(el.dataset.id),
    'load-example': () => loadExample(),
    'discard-draft': async () => {
      const ok = await confirmDialog({ title: 'Discard draft?', message: 'Your unsaved song progress will be deleted.', confirmLabel: 'Discard' });
      if (ok) { Draft.clear(); render({ keepScroll: true }); toast('Draft discarded', 'info'); }
    },

    // filters
    'filter-tag': (el) => {
      state.filters.tag = el.dataset.tag;
      $$('.tag-filter .chip').forEach((c) => c.classList.toggle('active', c.dataset.tag === el.dataset.tag));
      renderSongResults();
    },
    'clear-filters': () => {
      state.filters = { q: '', difficulty: 'all', tag: 'all' };
      render({ keepScroll: true });
    },

    // data
    export: () => exportData(),
    import: () => $('#import-file').click(),
    'clear-all': () => clearAll(),

    // detail page
    'detail-view': (el) => {
      state.detail.view = el.dataset.view;
      $$('[data-action="detail-view"]').forEach((b) => {
        const on = b.dataset.view === el.dataset.view;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on);
      });
      renderDetailTabs();
    },
    'section-prev': () => goSection(-1),
    'section-next': () => goSection(1),
    'tab-click': (el, e) => {
      const cell = e.target.closest('[data-step-index]');
      if (!cell) return;
      const i = Number(cell.dataset.stepIndex);
      selectStep(state.detail.selected === i ? null : i);
    },
    'select-step': (el) => {
      const i = Number(el.dataset.index);
      selectStep(state.detail.selected === i ? null : i);
    },
    'clear-selection': () => selectStep(null),
    'detail-delete-step': (el) => detailDeleteStep(Number(el.dataset.index)),
    'copy-text': (el) => { const s = Store.get(el.dataset.id); if (s) copyToClipboard(tabAsText(s)); },
    practice: (el) => {
      const id = el.dataset.id || state.detail.songId;
      const start = el.dataset.start != null ? Number(el.dataset.start) : 0;
      openPractice(id, start);
    },
    'qa-string': (el) => {
      state.detail.qaString = el.dataset.string;
      $$('[data-action="qa-string"]').forEach((b) => {
        const on = b.dataset.string === el.dataset.string;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on);
      });
      const f = $('#qa-fret');
      if (f && !isCoarsePointer()) f.focus({ preventScroll: true });
    },
    'qa-add': () => qaAdd(),

    // editor
    'toggle-details': () => setDetailsOpen(!state.editor.detailsOpen),
    'set-difficulty': (el) => {
      state.editor.song.difficulty = el.dataset.value;
      $$('[data-action="set-difficulty"]').forEach((b) => {
        const on = b.dataset.value === el.dataset.value;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on);
      });
      $('#details-summary').textContent = detailsSummary(state.editor.song);
      markDirty();
    },
    'toggle-tag': (el) => {
      const tags = state.editor.song.tags;
      const t = el.dataset.tag;
      const i = tags.indexOf(t);
      if (i >= 0) tags.splice(i, 1); else tags.push(t);
      el.classList.toggle('active', i < 0);
      el.setAttribute('aria-pressed', i < 0);
      $('#details-summary').textContent = detailsSummary(state.editor.song);
      markDirty();
    },
    'tg-grid': (el, e) => {
      const cell = e.target.closest('.tg-cell[data-col]');
      if (!cell) return;
      moveTo(Number(cell.dataset.col), cell.dataset.str);
      focusGrid();
    },
    'tg-move': (el) => { moveTo(state.editor.col + Number(el.dataset.delta)); focusGrid(); },
    'tg-fret': (el) => { advanceAfterTechnique(); state.editor.buffer = ''; enterNumber(Number(el.dataset.fret)); focusGrid(); },
    'tg-section': () => { startNewSection(); focusGrid(); },
    'tg-part': (el) => { setPart(Number(el.dataset.part)); focusGrid(); },
    'tg-tech': (el) => { setTechnique(el.dataset.value); focusGrid(); },
    'tg-undo': () => { undo(); focusGrid(); },
    'tg-insert': () => { insertBefore(); focusGrid(); },
    'tg-delete': () => { deleteAtCursor(); focusGrid(); },
    'editor-save': () => editorSave('open'),
    'editor-cancel': () => editorCancel(),

    // practice
    'pr-close': () => closePractice(),
    'pr-step': (el) => practiceStep(Number(el.dataset.delta)),
    'pr-section': (el) => practiceSection(Number(el.dataset.delta)),
    'pr-zoom': (el) => practiceZoom(Number(el.dataset.delta)),
    'pr-tap': (el, e) => {
      const cell = e.target.closest('[data-step-index]');
      if (cell) { state.practice.index = Number(cell.dataset.stepIndex); renderPractice(); return; }
      const r = el.getBoundingClientRect();
      practiceStep(e.clientX < r.left + r.width / 3 ? -1 : 1);
    },
  };

  function onClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    const fn = actions[el.dataset.action];
    if (!fn) return;
    if (el.tagName === 'A') e.preventDefault();
    fn(el, e);
  }

  function onInput(e) {
    const t = e.target;
    if (t.tagName === 'SELECT') return; // handled on change
    if (t.matches('[data-field]') && state.editor) { onDetailField(t); return; }
    if (t.matches('[data-tg]') && state.editor) {
      const tab = cursorTab();
      if (!tab) return;
      tab[t.dataset.tg] = t.value;
      if (t.dataset.tg === 'section') {
        const box = $('[data-tg-break]');
        if (box) box.checked = startsSection(tab);
      }
      markDirty();
      renderGrid();
      return;
    }
    if (t.id === 'qa-fret') {
      const v = t.value.trim() === '' ? { ok: true } : parseNoteText(t.value);
      $('#qa-error').textContent = v.ok ? '' : v.error;
      t.classList.toggle('invalid', !v.ok);
      return;
    }
    if (t.id === 'songs-search') { state.filters.q = t.value; renderSongResults(); return; }
    if (t.id === 'dash-search') {
      state.dashQuery = t.value;
      $('#dash-results').innerHTML = t.value.trim() ? dashResults(t.value) : '';
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.matches('[data-tg-break]') && state.editor) { setSectionBreak(t.checked); return; }
    if (t.id === 'import-file') { importFile(t.files && t.files[0]); t.value = ''; return; }
    if (t.matches('[data-field]') && state.editor) { onDetailField(t); return; }
    if (t.id === 'filter-difficulty') { state.filters.difficulty = t.value; renderSongResults(); return; }
    if (t.id === 'sort-select') { state.settings.sort = t.value; Settings.save(); renderSongResults(); return; }
    if (t.id && t.id.startsWith('set-')) onSettingChange(t);
  }

  function onKeyDown(e) {
    if (modalOpen()) return;
    if (state.practice) { handlePracticeKey(e); return; }

    // Keyboard activation for non-button elements with actions (cards, rows).
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-action][role="button"]') && e.target.tagName !== 'BUTTON') {
      e.preventDefault();
      e.target.click();
      return;
    }

    const r = currentRoute ? currentRoute.name : '';
    if (r === 'new' || r === 'edit') { handleEditorKey(e); return; }

    if (e.key === 'Enter' && e.target.closest && e.target.closest('.quick-add') && e.target.tagName === 'INPUT') {
      e.preventDefault();
      qaAdd();
      return;
    }
    if (e.key === 'Enter' && e.target.id === 'dash-search' && e.target.value.trim()) {
      state.filters.q = e.target.value.trim();
      go('#/songs');
      return;
    }
    if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === '/' && (r === 'dashboard' || r === 'songs')) {
      const s = $('#dash-search') || $('#songs-search');
      if (s) { e.preventDefault(); s.focus(); }
      return;
    }
    if (r === 'song') {
      const d = state.detail;
      const song = Store.get(d.songId);
      if (!song) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); selectStep(d.selected == null ? (d.sectionOf.indexOf(d.section)) : d.selected + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); if (d.selected != null) selectStep(d.selected - 1); }
      else if (e.key === 'PageDown' || e.key === ']') { e.preventDefault(); goSection(1); }
      else if (e.key === 'PageUp' || e.key === '[') { e.preventDefault(); goSection(-1); }
      else if (e.key.toLowerCase() === 'p') { e.preventDefault(); openPractice(song.id, d.selected || 0); }
      else if (e.key.toLowerCase() === 'e') { e.preventDefault(); go(`#/edit/${encodeURIComponent(song.id)}${d.selected != null ? `?step=${d.selected + 1}` : ''}`); }
      else if (e.key === 'Escape' && d.selected != null) { selectStep(null); }
      else if ((e.key === 'Delete') && d.selected != null) { e.preventDefault(); detailDeleteStep(d.selected); }
    }
  }

  const onResize = debounce(() => {
    if (state.settings.perLine !== 'auto') return;
    if (state.practice) { renderPractice(); return; }
    if (!currentRoute) return;
    if (currentRoute.name === 'song') renderDetailTabs();
    else if (isEditorRoute(currentRoute) && state.editor) renderGrid();
  }, 180);

  function init() {
    // Static icons in the shell
    $$('[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon); });
    $$('[data-logo]').forEach((el) => { el.innerHTML = LOGO; });

    Settings.load();
    Store.load();
    if (!storageAvailable) {
      setTimeout(() => toast('LocalStorage is unavailable — songs cannot be saved in this browser mode.', 'error', { duration: 10000 }), 300);
    }

    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && state.practice && state.practice.fs) closePractice();
    });
    // Flush any pending draft before the page goes away.
    const flush = () => { if (state.editor) saveDraftSoon.flush(); };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

    if (!location.hash || location.hash === '#' || location.hash === '#/') replaceHash('#/dashboard');
    lastHash = location.hash;
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
