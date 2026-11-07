'use strict';
const { app, BrowserWindow, ipcMain, globalShortcut, protocol, session, systemPreferences, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { initMain: initLoopback } = require('electron-audio-loopback');
const { GeminiClient } = require('./gemini');

// Must run before app is ready: enables system-audio loopback (WASAPI on Windows, ScreenCaptureKit on macOS).
initLoopback();

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const RENDERER_DIR = path.join(__dirname, 'renderer');
const VENDOR_DIR = path.join(__dirname, '..', 'node_modules', '@huggingface', 'transformers', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };

const DEFAULTS = {
  whisperModel: 'Xenova/whisper-base.en',
  silenceMs: 800,
  autoAsk: true,
  ignoreMicDuringSystem: true,
  hideFromCapture: true,
  opacity: 0.95,
  manualCookies: '',
  systemPrompt:
    'You are a discreet real-time assistant helping me during a live conversation. ' +
    'The text below is a question that was just asked to me, transcribed from audio (it may contain recognition errors). ' +
    'Reply with a concise, spoken-style answer I can say aloud: lead with the direct answer in 1-2 sentences, ' +
    'then at most 3 short supporting bullets. Use code blocks only if code is explicitly requested.',
};

let win = null;
let settings = { ...DEFAULTS };
let clickThrough = false;
let currentAbort = null;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { settings = { ...DEFAULTS }; }
}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {}
}

const gemini = new GeminiClient({ getManualCookies: () => settings.manualCookies });
const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

/** Keep the window out of screen shares / recordings and out of task switchers. */
function applyStealth() {
  if (!win) return;
  win.setContentProtection(!!settings.hideFromCapture); // WDA_EXCLUDEFROMCAPTURE (Win) / NSWindowSharingNone (macOS)
  win.setSkipTaskbar(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setOpacity(Math.min(1, Math.max(0.3, settings.opacity)));
  if (process.platform === 'darwin') app.dock?.hide();
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 980, height = 560;
  win = new BrowserWindow({
    width, height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y + 20,
    minWidth: 520, minHeight: 300,
    frame: false,
    show: false,
    title: 'Notes',
    backgroundColor: '#0f1115',
    skipTaskbar: true,
    hiddenInMissionControl: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // keep transcribing when not focused
    },
  });
  applyStealth(); // before first paint so the window is never capturable
  win.once('ready-to-show', () => win.showInactive()); // don't steal focus from the meeting
  win.loadURL('app://local/index.html');
  win.on('closed', () => { win = null; });
}

function toggleVisible() {
  if (!win) return;
  if (win.isVisible()) win.hide(); else win.showInactive();
}
function toggleClickThrough() {
  if (!win) return;
  clickThrough = !clickThrough;
  win.setIgnoreMouseEvents(clickThrough, { forward: true });
  send('ui:clickthrough', clickThrough);
}

function registerShortcuts() {
  const reg = (acc, fn) => { try { globalShortcut.register(acc, fn); } catch {} };
  reg('CommandOrControl+Shift+H', toggleVisible);
  reg('CommandOrControl+Shift+X', toggleClickThrough);
  reg('CommandOrControl+Shift+Enter', () => send('ui:ask-last'));
  reg('CommandOrControl+Shift+L', () => send('ui:toggle-listen'));
  const step = 40;
  const nudge = (dx, dy) => () => { if (win) { const [x, y] = win.getPosition(); win.setPosition(x + dx, y + dy); } };
  reg('CommandOrControl+Shift+Left', nudge(-step, 0));
  reg('CommandOrControl+Shift+Right', nudge(step, 0));
  reg('CommandOrControl+Shift+Up', nudge(0, -step));
  reg('CommandOrControl+Shift+Down', nudge(0, step));
}

function registerIpc() {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, patch) => {
    settings = { ...settings, ...patch };
    saveSettings();
    if ('manualCookies' in patch) gemini.session = null;
    applyStealth();
    return settings;
  });

  ipcMain.handle('gemini:status', async () => {
    try { const s = await gemini.init(true); return { ok: true, source: s.source }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('gemini:reset', () => { gemini.resetChat(); return true; });
  ipcMain.handle('gemini:cancel', () => { currentAbort?.abort(); return true; });
  ipcMain.handle('gemini:ask', async (_e, { id, question }) => {
    currentAbort?.abort();
    const ctl = (currentAbort = new AbortController());
    try {
      const text = await gemini.ask(`${settings.systemPrompt}\n\nQuestion: ${question}`, {
        signal: ctl.signal,
        onUpdate: (t) => send('gemini:update', { id, text: t, done: false }),
      });
      send('gemini:update', { id, text, done: true });
    } catch (e) {
      if (ctl.signal.aborted) send('gemini:update', { id, cancelled: true, done: true });
      else send('gemini:update', { id, error: e.message, done: true });
    }
    return true;
  });

  ipcMain.handle('win:quit', () => app.quit());
  ipcMain.handle('win:hide', () => win?.hide());
}

app.whenReady().then(async () => {
  loadSettings();

  protocol.handle('app', async (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    const vendor = rel.startsWith('/vendor/');
    const root = vendor ? VENDOR_DIR : RENDERER_DIR;
    const file = path.resolve(root, '.' + (vendor ? rel.slice(7) : rel));
    if (!file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const buf = await fs.promises.readFile(file);
      return new Response(buf, { headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } });
    } catch { return new Response('Not found', { status: 404 }); }
  });

  // Only our own pages may use mic / display capture.
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'display-capture'].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => ['media', 'display-capture'].includes(perm));

  if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('microphone').catch(() => {});

  registerIpc();
  createWindow();
  registerShortcuts();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
