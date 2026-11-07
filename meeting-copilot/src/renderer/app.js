import { Segmenter, openSystemStream, openMicStream, attach } from './audio.js';

const api = window.api;
const $ = (id) => document.getElementById(id);
let settings = {};
let listening = false;
const sources = { system: null, mic: null };
const lines = [];       // transcript items
let pending = '';       // system speech not yet sent
let pendingTimer = null;
let uid = 0;

// ---------- tiny markdown ----------
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function inline(s) { return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|\W)\*([^*\n]+)\*/g, '$1<i>$2</i>'); }
function md(text) {
  const out = []; let list = null; let code = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of text.split('\n')) {
    if (raw.trim().startsWith('```')) {
      if (code === null) { closeList(); code = []; } else { out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; }
      continue;
    }
    if (code !== null) { code.push(raw); continue; }
    const ul = raw.match(/^\s*[*-]\s+(.*)/); const ol = raw.match(/^\s*\d+[.)]\s+(.*)/);
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol';
      if (list !== tag) { closeList(); out.push(`<${tag}>`); list = tag; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`); continue;
    }
    closeList();
    const h = raw.match(/^#{1,4}\s+(.*)/);
    if (h) out.push(`<p><b>${inline(h[1])}</b></p>`); else if (raw.trim()) out.push(`<p>${inline(raw)}</p>`);
  }
  if (code !== null) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  closeList();
  return out.join('');
}

// ---------- speech-to-text worker ----------
const worker = new Worker('app://local/whisper-worker.js', { type: 'module' });
const waiting = new Map();
let modelReady = false;
const setPill = (el, text, cls) => { el.textContent = text; el.className = 'pill' + (cls ? ' ' + cls : ''); };

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') setPill($('pillModel'), `speech: downloading ${Math.round(m.progress || 0)}%`);
  else if (m.type === 'ready') { modelReady = true; setPill($('pillModel'), `speech: ready (${m.backend})`, 'ok'); }
  else if (m.type === 'error') setPill($('pillModel'), 'speech: error', 'bad'), addHint(m.error);
  else if (m.type === 'result') { const cb = waiting.get(m.id); waiting.delete(m.id); cb?.(m.text, m.error); }
};
function loadModel() {
  modelReady = false;
  setPill($('pillModel'), 'speech: loading…');
  worker.postMessage({ type: 'load', model: settings.whisperModel });
}
function transcribe(audio) {
  return new Promise((resolve) => {
    const id = ++uid;
    waiting.set(id, (text, err) => resolve({ text, err }));
    worker.postMessage({ type: 'transcribe', id, audio }, [audio.buffer]);
  });
}

// ---------- transcript ----------
const JUNK = /^[\s.,!?-]*$|^[\[(*♪].*[\])*♪]$|^(thanks for watching|thank you)\W*$|^(you|uh|um|hmm|oh)\W*$/i;
const QSTART = /^(what|why|how|when|where|who|whom|whose|which|can|could|would|should|do|does|did|is|are|was|were|will|have|has|tell me|describe|explain|walk me|give me|talk about|suppose|imagine|let's say)\b/i;
const looksLikeQuestion = (t) => /\?\s*$/.test(t) || QSTART.test(t.trim()) || /\b(tell me about|walk me through|explain|describe|what is|how would|how do)\b/i.test(t);

function addHint(text) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = text; $('transcript').append(p); scrollDown(); }
const scrollDown = () => { const t = $('transcript'); t.scrollTop = t.scrollHeight; };

function addLine(who, text) {
  if (lines.length === 0) $('transcript').innerHTML = '';
  const item = { who, text };
  lines.push(item);
  const row = document.createElement('div'); row.className = 'line';
  const w = document.createElement('span'); w.className = `who ${who}`; w.textContent = who === 'them' ? 'Them' : 'You';
  const t = document.createElement('span'); t.className = 'txt'; t.textContent = text;
  const b = document.createElement('button'); b.className = 'ask'; b.textContent = 'Ask'; b.onclick = () => ask(text);
  row.append(w, t, b);
  $('transcript').append(row);
  scrollDown();
  return row;
}

let micSuppressedUntil = 0;
async function onSegment(who, audio, segmenter) {
  const endedAt = performance.now();
  if (who === 'you' && settings.ignoreMicDuringSystem && sources.system &&
      (sources.system.seg.speaking || endedAt - sources.system.seg.lastVoiceAt < 1500)) return;
  const { text, err } = await transcribe(audio);
  if (err) return console.warn('transcribe:', err);
  if (!text || JUNK.test(text)) return;
  addLine(who, text);
  if (who === 'them') queueQuestion(text);
}

function queueQuestion(text) {
  pending = (pending + ' ' + text).trim();
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    const q = pending; pending = '';
    if ($('chkAuto').checked && looksLikeQuestion(q)) ask(q);
  }, 1300);
}

function lastQuestion() {
  const parts = [];
  for (let i = lines.length - 1; i >= 0 && parts.length < 4; i--) { if (lines[i].who !== 'them') break; parts.unshift(lines[i].text); }
  return parts.join(' ');
}

// ---------- Gemini ----------
const cards = new Map();
function ask(question) {
  question = (question || '').trim();
  if (!question) return;
  const id = ++uid;
  const el = document.createElement('div'); el.className = 'ans wait';
  const q = document.createElement('div'); q.className = 'q'; q.textContent = '❝ ' + question;
  const a = document.createElement('div'); a.className = 'a';
  el.append(q, a);
  $('answers').prepend(el);
  cards.set(id, { el, a });
  api.geminiAsk(id, question);
}
api.onGeminiUpdate(({ id, text, done, error, cancelled }) => {
  const c = cards.get(id); if (!c) return;
  if (text != null) c.a.innerHTML = md(text);
  if (error) { c.el.classList.add('err'); c.a.textContent = error; setPill($('pillGemini'), 'gemini: error', 'bad'); }
  if (cancelled) { c.el.remove(); }
  if (done) { c.el.classList.remove('wait'); if (!error && !cancelled) setPill($('pillGemini'), 'gemini: ok', 'ok'); }
});

async function checkGemini() {
  setPill($('pillGemini'), 'gemini: checking…');
  const r = await api.geminiStatus();
  setPill($('pillGemini'), r.ok ? 'gemini: ok' : 'gemini: not signed in', r.ok ? 'ok' : 'bad');
  return r;
}

// ---------- audio sources ----------
async function startSource(name) {
  if (sources[name]) return;
  const who = name === 'system' ? 'them' : 'you';
  const seg = new Segmenter({
    silenceMs: settings.silenceMs,
    onSegment: (a) => onSegment(who, a),
    onLevel: (l) => { $(name === 'system' ? 'lvlSys' : 'lvlMic').style.width = l * 100 + '%'; },
  });
  const stream = await (name === 'system' ? openSystemStream(api) : openMicStream());
  const conn = await attach(stream, seg, () => { addHint(`${name} audio stopped.`); stopSource(name); });
  sources[name] = { seg, conn };
}
function stopSource(name) {
  const s = sources[name]; if (!s) return;
  s.conn.stop(); sources[name] = null;
  $(name === 'system' ? 'lvlSys' : 'lvlMic').style.width = '0';
}

async function startListening() {
  try {
    await startSource('system');
  } catch (e) {
    addHint(`System audio unavailable: ${e.message}. (macOS: grant Screen & System Audio Recording permission; then restart the app.)`);
  }
  if ($('chkMic').checked) {
    try { await startSource('mic'); } catch (e) { addHint(`Microphone unavailable: ${e.message}`); }
  }
  if (!sources.system && !sources.mic) return;
  listening = true;
  $('btnListen').textContent = 'Stop'; $('btnListen').classList.add('on'); $('dotListen').classList.add('live');
}
function stopListening() {
  stopSource('system'); stopSource('mic');
  listening = false;
  $('btnListen').textContent = 'Start'; $('btnListen').classList.remove('on'); $('dotListen').classList.remove('live');
}
const toggleListening = () => (listening ? stopListening() : startListening());

// ---------- settings UI ----------
function fillSettings() {
  $('setModel').value = settings.whisperModel; $('setSilence').value = settings.silenceMs;
  $('setIgnoreMic').checked = settings.ignoreMicDuringSystem; $('setHide').checked = settings.hideFromCapture;
  $('setOpacity').value = settings.opacity; $('setPrompt').value = settings.systemPrompt; $('setCookies').value = settings.manualCookies;
  $('chkAuto').checked = settings.autoAsk;
}
async function save(patch) { settings = await api.setSettings(patch); }

$('btnSettings').onclick = () => { fillSettings(); $('modal').hidden = false; };
$('btnClose').onclick = async () => {
  const modelChanged = $('setModel').value !== settings.whisperModel;
  await save({
    whisperModel: $('setModel').value, silenceMs: Math.max(300, +$('setSilence').value || 800),
    ignoreMicDuringSystem: $('setIgnoreMic').checked, hideFromCapture: $('setHide').checked,
    opacity: +$('setOpacity').value, systemPrompt: $('setPrompt').value, manualCookies: $('setCookies').value.trim(),
  });
  Object.values(sources).forEach((s) => s?.seg.setSilenceMs(settings.silenceMs));
  if (modelChanged) loadModel();
  $('modal').hidden = true;
};
$('setOpacity').oninput = () => save({ opacity: +$('setOpacity').value });
$('btnTest').onclick = async () => {
  await save({ manualCookies: $('setCookies').value.trim() });
  $('testOut').textContent = 'checking…';
  const r = await checkGemini();
  $('testOut').textContent = r.ok ? `Signed in via ${r.source}` : r.error;
};
$('btnQuit').onclick = () => api.quit();
$('btnHide').onclick = () => api.hide();
$('btnListen').onclick = toggleListening;
$('btnNew').onclick = async () => { await api.geminiReset(); $('answers').innerHTML = ''; };
$('chkAuto').onchange = () => save({ autoAsk: $('chkAuto').checked });
$('chkMic').onchange = async () => {
  if (!listening) return;
  if ($('chkMic').checked) { try { await startSource('mic'); } catch (e) { addHint(`Microphone unavailable: ${e.message}`); } } else stopSource('mic');
};
$('manual').addEventListener('keydown', (e) => { if (e.key === 'Enter') { ask($('manual').value); $('manual').value = ''; } });

api.onAskLast(() => { const q = (pending || lastQuestion()).trim(); pending = ''; ask(q); });
api.onToggleListen(toggleListening);
api.onClickThrough((on) => { document.body.style.outline = on ? '2px dashed #6ea8fe' : ''; });

// ---------- boot ----------
(async () => {
  settings = await api.getSettings();
  fillSettings();
  loadModel();
  checkGemini();
})();
