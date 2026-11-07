// Audio capture + simple energy-based voice-activity segmentation.
const RATE = 16000;
const FRAME = 512; // 32 ms

export class Segmenter {
  constructor({ silenceMs = 800, onSegment, onLevel }) {
    this.silenceFrames = Math.max(5, Math.round(silenceMs / 32));
    this.onSegment = onSegment;
    this.onLevel = onLevel;
    this.buf = new Float32Array(FRAME);
    this.fill = 0;
    this.preroll = [];
    this.frames = [];
    this.speaking = false;
    this.loud = 0;
    this.quiet = 0;
    this.noise = 0.004;
    this.lastVoiceAt = 0;
    this.lastLevelAt = 0;
  }

  setSilenceMs(ms) { this.silenceFrames = Math.max(5, Math.round(ms / 32)); }

  push(samples) {
    let i = 0;
    while (i < samples.length) {
      const n = Math.min(FRAME - this.fill, samples.length - i);
      this.buf.set(samples.subarray(i, i + n), this.fill);
      this.fill += n; i += n;
      if (this.fill === FRAME) { this.frame(this.buf); this.buf = new Float32Array(FRAME); this.fill = 0; }
    }
  }

  frame(f) {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    const rms = Math.sqrt(sum / f.length);
    const threshold = Math.max(0.012, this.noise * 3);
    const voiced = rms > threshold;

    const now = performance.now();
    if (voiced) this.lastVoiceAt = now;
    if (this.onLevel && now - this.lastLevelAt > 100) { this.lastLevelAt = now; this.onLevel(Math.min(1, rms * 8)); }
    if (!this.speaking && !voiced) this.noise = Math.min(0.02, this.noise * 0.99 + rms * 0.01);

    if (!this.speaking) {
      this.preroll.push(f);
      if (this.preroll.length > 10) this.preroll.shift();
      this.loud = voiced ? this.loud + 1 : 0;
      if (this.loud >= 2) { this.speaking = true; this.frames = [...this.preroll]; this.preroll = []; this.quiet = 0; this.voicedFrames = this.loud; }
      return;
    }

    this.frames.push(f);
    if (voiced) { this.quiet = 0; this.voicedFrames++; } else this.quiet++;
    const len = this.frames.length;
    const endOfPhrase = this.quiet >= this.silenceFrames;
    const longPause = len > 375 && this.quiet >= 8; // >12 s: cut at the first short pause
    if (endOfPhrase || longPause || len > 800) this.flush();
  }

  flush() {
    const frames = this.frames;
    const voiced = this.voicedFrames;
    this.frames = []; this.speaking = false; this.loud = 0; this.quiet = 0; this.voicedFrames = 0;
    if (voiced < 10) return; // shorter than ~320 ms of voice: noise / click
    const keep = frames.length - Math.max(0, this.quiet - 6);
    const out = new Float32Array(frames.length * FRAME);
    frames.forEach((f, idx) => out.set(f, idx * FRAME));
    this.onSegment(out.subarray(0, Math.max(FRAME, keep * FRAME)).slice());
  }
}

export async function openSystemStream(api) {
  await api.enableLoopbackAudio();
  try {
    // getDisplayMedia needs video:true; the video track is discarded immediately.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
    if (!stream.getAudioTracks().length) throw new Error('No system audio track was provided by the OS.');
    return stream;
  } finally {
    await api.disableLoopbackAudio();
  }
}

export const openMicStream = () =>
  navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });

/** Connects a MediaStream to a Segmenter. Returns { stop() }. */
export async function attach(stream, segmenter, onEnded) {
  const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('app://local/capture-worklet.js');
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
  node.port.onmessage = (e) => segmenter.push(e.data);
  const mute = ctx.createGain();
  mute.gain.value = 0; // keep the graph alive without playing anything back
  src.connect(node).connect(mute).connect(ctx.destination);
  await ctx.resume();
  stream.getAudioTracks().forEach((t) => { t.onended = () => onEnded?.(); });
  return {
    stop() {
      try { segmenter.flush(); } catch {}
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    },
  };
}
