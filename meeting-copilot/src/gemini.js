'use strict';
// Minimal client for the Gemini web app (gemini.google.com), authenticated with browser cookies.
// This is an unofficial interface: Google can change it at any time.
const { findGeminiCookies, cookieHeader, parseCookieHeader } = require('./firefoxCookies');

const BASE = 'https://gemini.google.com';
const GENERATE = `${BASE}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

/** Extract the per-session tokens embedded in the /app HTML. */
function parseInitPage(html) {
  const pick = (re) => (html.match(re) || [])[1];
  return { at: pick(/"SNlM0e":"(.*?)"/), bl: pick(/"cfb2h":"(.*?)"/), sid: pick(/"FdrFJe":"(.*?)"/) };
}

/**
 * Parse a (possibly partial) StreamGenerate response.
 * Frames look like: <len>\n[["wrb.fr",null,"<json string>"...]]\n ; streaming frames are cumulative,
 * so the last frame that carries candidates wins.
 */
function parseStream(raw) {
  let best = null;
  for (const line of raw.replace(/^\)\]\}'\s*/, '').split('\n')) {
    if (!line.startsWith('[')) continue;
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    for (const part of Array.isArray(frame) ? frame : []) {
      if (!Array.isArray(part) || typeof part[2] !== 'string') continue;
      let body;
      try { body = JSON.parse(part[2]); } catch { continue; }
      const cand = body && body[4] && body[4][0];
      const text = cand && cand[1] && cand[1][0];
      if (typeof text !== 'string') continue;
      best = { text, meta: [body[1]?.[0] ?? null, body[1]?.[1] ?? null, cand[0] ?? null] };
    }
  }
  return best;
}

class GeminiClient {
  constructor({ getManualCookies } = {}) {
    this.getManualCookies = getManualCookies || (() => '');
    this.session = null; // { cookies, header, at, bl, sid, source }
    this.meta = [null, null, null];
    this.reqId = 100000 + Math.floor(Math.random() * 900000);
  }

  resetChat() { this.meta = [null, null, null]; }

  loadCookies() {
    const manual = parseCookieHeader(this.getManualCookies());
    if (manual['__Secure-1PSID']) return { cookies: manual, source: 'manual cookie' };
    const { cookies, profileDir } = findGeminiCookies();
    return { cookies, source: `Firefox (${profileDir})` };
  }

  async init(force = false) {
    if (this.session && !force) return this.session;
    const { cookies, source } = this.loadCookies();
    const header = cookieHeader(cookies);
    const res = await fetch(`${BASE}/app`, { headers: { Cookie: header, 'User-Agent': UA }, redirect: 'follow' });
    const tokens = parseInitPage(await res.text());
    if (!tokens.at) throw new Error('Gemini rejected the session (not signed in or cookies expired). Sign in to gemini.google.com in Firefox.');
    this.session = { cookies, header, source, ...tokens };
    return this.session;
  }

  /** Ask Gemini. onUpdate(text) is called while streaming. Resolves with the final text. */
  async ask(prompt, { onUpdate, signal } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this._ask(prompt, { onUpdate, signal });
      } catch (e) {
        if (attempt === 0 && e.code === 'AUTH') { this.session = null; continue; } // cookies may have rotated
        throw e;
      }
    }
  }

  async _ask(prompt, { onUpdate, signal }) {
    const s = await this.init();
    const params = new URLSearchParams({ bl: s.bl || '', 'f.sid': s.sid || '', hl: 'en', _reqid: String((this.reqId += 100000)), rt: 'c' });
    const body = new URLSearchParams({ at: s.at, 'f.req': JSON.stringify([null, JSON.stringify([[prompt], null, this.meta])]) });
    const res = await fetch(`${GENERATE}?${params}`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        Origin: BASE, Referer: `${BASE}/`, 'X-Same-Domain': '1', Cookie: s.header, 'User-Agent': UA,
      },
      body,
    });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('Gemini auth failed'), { code: 'AUTH' });
    if (!res.ok) throw new Error(`Gemini request failed (HTTP ${res.status})`);

    const decoder = new TextDecoder();
    let raw = '';
    let last = null;
    for await (const chunk of res.body) {
      raw += decoder.decode(chunk, { stream: true });
      const parsed = parseStream(raw);
      if (parsed && parsed.text !== last?.text) { last = parsed; onUpdate?.(parsed.text); }
    }
    raw += decoder.decode();
    const final = parseStream(raw) || last;
    if (!final) {
      if (/"SNlM0e"|accounts\.google\.com/.test(raw)) throw Object.assign(new Error('Gemini auth failed'), { code: 'AUTH' });
      throw new Error('Gemini returned no answer (rate-limited, or the web API changed).');
    }
    this.meta = final.meta;
    return final.text;
  }
}

module.exports = { GeminiClient, parseInitPage, parseStream };
