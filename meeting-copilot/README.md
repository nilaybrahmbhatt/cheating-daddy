# Meeting Copilot

Windows + macOS desktop app (Electron) that:

1. **Listens** to your laptop's **output audio** (what the other side says, via OS loopback – no virtual driver) and optionally your **microphone**.
2. **Transcribes** it live, **on-device** (Whisper via transformers.js – audio never leaves your machine).
3. Sends detected questions to **Gemini** (gemini.google.com) using your **Firefox login cookies** (no API key) and shows the streamed answer in the same window.
4. Is **excluded from screen sharing / recording** (`setContentProtection`) and doesn't show in the taskbar/Dock.

## Run

```bash
cd meeting-copilot
npm install        # also rebuilds better-sqlite3 for Electron
npm start
npm run dist:win   # or dist:mac  (build on the matching OS)
npm test           # parser + Firefox-cookie unit tests
```

Requirements: Node 18+, Windows 10 2004+ or macOS 13+, Firefox signed in to https://gemini.google.com.
First launch downloads the speech model (~40–250 MB depending on the chosen size) from huggingface.co and caches it.

## Using it

* **Start** begins capture. “Them” = system audio, “You” = microphone. Use headphones to avoid the mic re-hearing the speakers (there is also an “ignore mic while system audio is speaking” option).
* With **auto-ask** on, speech from “Them” that looks like a question is sent to Gemini after a short pause. Hover any line and click **Ask** to send it manually, or type in the bottom box.
* Hotkeys (global): `Ctrl/Cmd+Shift+` **H** hide/show · **X** click-through · **Enter** ask last question · **L** start/stop · **arrows** move window.
* Settings: speech model size, pause length, opacity, prompt prefix, and an optional manual cookie string (`__Secure-1PSID=…; __Secure-1PSIDTS=…`) that overrides Firefox.

## How the Gemini part works

`src/firefoxCookies.js` finds the Firefox profile (`profiles.ini`), copies `cookies.sqlite` (+WAL) to a temp dir and reads the `google.com` cookies. `src/gemini.js` then talks to Gemini's web endpoint (`StreamGenerate`) like the web page does. This is an **unofficial** interface: Google may change it, rate-limit it, or object to automated use of a consumer account. Cookies are only read locally and only sent to `gemini.google.com`.

## Hiding from screen share – what to expect

* Windows: `WDA_EXCLUDEFROMCAPTURE` – invisible to Zoom/Teams/Meet/OBS window & screen capture (Win10 2004+).
* macOS: window sharing type “none” + hidden from Dock/Mission Control. Newer macOS versions (15+) with ScreenCaptureKit-based sharing can ignore this for some apps – **test with your meeting app (share your screen to yourself) before relying on it.**
* The window is not hidden from a second physical person looking at your screen, from proctoring software that inspects processes, or from audio your speakers play into a mic. Check the rules of the meeting/interview you are in.

## macOS permissions

Grant **Screen & System Audio Recording** (needed for system-audio loopback) and **Microphone** to the app in System Settings → Privacy & Security, then relaunch.

## Layout

```
src/main.js        window, stealth, hotkeys, app:// protocol, IPC
src/gemini.js      Gemini web client (streaming)
src/firefoxCookies.js
src/renderer/      UI, audio capture (loopback + mic), VAD segmenter, Whisper worker
```
