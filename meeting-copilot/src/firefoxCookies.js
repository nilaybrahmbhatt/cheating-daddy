'use strict';
// Reads the Google session cookies from the user's local Firefox profile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function firefoxRoot(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Mozilla', 'Firefox');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Firefox');
  return path.join(home, '.mozilla', 'firefox');
}

function parseIni(text) {
  const sections = {};
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) { cur = sections[m[1]] = {}; continue; }
    const kv = line.match(/^([^=]+)=(.*)$/);
    if (kv && cur) cur[kv[1].trim()] = kv[2].trim();
  }
  return sections;
}

/** Candidate Firefox profile dirs, most likely (default) first. */
function listProfiles(root = firefoxRoot()) {
  const iniPath = path.join(root, 'profiles.ini');
  if (!fs.existsSync(iniPath)) return [];
  const sections = parseIni(fs.readFileSync(iniPath, 'utf8'));
  const resolve = (s) => (s.IsRelative === '0' ? s.Path : path.join(root, s.Path));
  const out = [];
  const add = (dir) => { if (dir && !out.includes(dir)) out.push(dir); };

  // Installs (Firefox >= 67) record the profile actually in use.
  for (const [name, s] of Object.entries(sections)) {
    if (name.startsWith('Install') && s.Default) add(path.isAbsolute(s.Default) ? s.Default : path.join(root, s.Default));
  }
  const profiles = Object.entries(sections).filter(([n, s]) => n.startsWith('Profile') && s.Path).map(([, s]) => s);
  profiles.filter((s) => s.Default === '1').forEach((s) => add(resolve(s)));
  profiles.forEach((s) => add(resolve(s)));
  return out.filter((d) => fs.existsSync(path.join(d, 'cookies.sqlite')));
}

function defaultOpenDb(file) {
  const Database = require('better-sqlite3');
  return new Database(file, { readonly: false });
}

/** Copy the (possibly locked) DB + WAL to a temp dir and query it. */
function readGoogleCookies(profileDir, { openDb = defaultOpenDb } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ff-'));
  try {
    const dst = path.join(tmp, 'cookies.sqlite');
    fs.copyFileSync(path.join(profileDir, 'cookies.sqlite'), dst);
    for (const ext of ['-wal', '-shm']) {
      const src = path.join(profileDir, 'cookies.sqlite' + ext);
      if (fs.existsSync(src)) fs.copyFileSync(src, dst + ext);
    }
    const db = openDb(dst);
    try {
      const rows = db
        .prepare("SELECT name, value, host FROM moz_cookies WHERE host LIKE '%google.com' ORDER BY (originAttributes = '') DESC, lastAccessed DESC")
        .all();
      const cookies = {};
      for (const r of rows) {
        const host = String(r.host).replace(/^\./, '');
        if (host !== 'google.com' && !host.endsWith('.google.com')) continue;
        if (!(r.name in cookies)) cookies[r.name] = r.value;
      }
      return cookies;
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Returns { cookies, profileDir } for the first profile holding a Gemini session, or throws. */
function findGeminiCookies(opts = {}) {
  const profiles = listProfiles(opts.root);
  if (!profiles.length) throw new Error('No Firefox profile found. Is Firefox installed and has it been run once?');
  let lastErr = null;
  for (const dir of profiles) {
    try {
      const cookies = readGoogleCookies(dir, opts);
      if (cookies['__Secure-1PSID']) return { cookies, profileDir: dir };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    lastErr
      ? `Could not read Firefox cookies: ${lastErr.message}`
      : 'No Google login found in Firefox. Open https://gemini.google.com in Firefox and sign in, then retry.'
  );
}

const cookieHeader = (cookies) => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

/** Parse a pasted "Cookie:" header (or "a=b; c=d") into an object. */
function parseCookieHeader(str) {
  const out = {};
  for (const part of String(str || '').replace(/^cookie:\s*/i, '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

module.exports = { firefoxRoot, parseIni, listProfiles, readGoogleCookies, findGeminiCookies, cookieHeader, parseCookieHeader };
