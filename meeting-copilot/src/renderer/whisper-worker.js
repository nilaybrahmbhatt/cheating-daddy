// Speech-to-text runs fully on-device (Whisper via transformers.js). Audio never leaves the machine;
// only the first-run model download touches the network (huggingface.co).
import { pipeline, env } from 'app://local/vendor/transformers.min.js';

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = 'app://local/vendor/';

let asr = null;
let backend = null;
let modelName = null;

const post = (m) => self.postMessage(m);

async function build(model, device) {
  const opts = {
    progress_callback: (p) => { if (p.status === 'progress') post({ type: 'progress', progress: p.progress, file: p.file }); },
    device,
  };
  opts.dtype = device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8';
  return pipeline('automatic-speech-recognition', model, opts);
}

async function load(model, preferred) {
  modelName = model;
  const order = preferred === 'wasm' ? ['wasm'] : ['webgpu', 'wasm'];
  let lastErr;
  for (const device of order) {
    try {
      asr = await build(model, device);
      backend = device;
      // Warm-up doubles as a check that the backend really works.
      await asr(new Float32Array(16000), {});
      post({ type: 'ready', backend });
      return;
    } catch (e) { lastErr = e; asr = null; }
  }
  post({ type: 'error', error: `Could not load speech model: ${lastErr?.message || lastErr}` });
}

let chain = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') { chain = chain.then(() => load(m.model, m.backend)); return; }
  if (m.type === 'transcribe') {
    chain = chain.then(async () => {
      if (!asr) return post({ type: 'result', id: m.id, text: '', error: 'model not ready' });
      try {
        const out = await asr(m.audio, { chunk_length_s: 30, stride_length_s: 5 });
        post({ type: 'result', id: m.id, text: (out.text || '').trim() });
      } catch (err) {
        if (backend === 'webgpu') { await load(modelName, 'wasm'); } // GPU failed mid-run: fall back once
        post({ type: 'result', id: m.id, text: '', error: String(err?.message || err) });
      }
    });
  }
};
