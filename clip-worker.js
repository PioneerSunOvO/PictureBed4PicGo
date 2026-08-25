/**
 * CLIP embedding worker — keeps heavy inference off the main thread.
 */
import { pipeline, env, RawImage } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const REMOTE_HOSTS = [
  'https://cdn.jsdelivr.net/npm/@xenova/',
  'https://hf-mirror.com/',
  'https://huggingface.co/'
];

let extractor = null;

function post(type, payload) {
  self.postMessage({ type, ...payload });
}

function configureEnv(host) {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.remoteHost = host;
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.numThreads = 1;
  }
}

async function loadModel() {
  if (extractor) return extractor;
  let lastErr;
  for (const host of REMOTE_HOSTS) {
    try {
      configureEnv(host);
      extractor = await pipeline('image-feature-extraction', MODEL_ID, {
        quantized: true,
        progress_callback: (data) => post('progress', { phase: 'model', data })
      });
      post('modelHost', { host });
      return extractor;
    } catch (e) {
      lastErr = e;
      extractor = null;
    }
  }
  throw lastErr || new Error('CLIP model load failed');
}

function normalizeVec(data) {
  const vec = data instanceof Float32Array ? data : new Float32Array(data);
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

async function encodeUrl(url) {
  const res = await fetch(url, { mode: 'cors', cache: 'default' });
  if (!res.ok) throw new Error('fetch ' + res.status);
  const blob = await res.blob();
  const raw = await RawImage.fromBlob(blob);
  const out = await extractor(raw, { pooling: 'mean', normalize: true });
  if (!out?.data?.length) throw new Error('empty embedding');
  return normalizeVec(new Float32Array(out.data));
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'init') {
      await loadModel();
      post('ready', {});
      return;
    }
    if (msg.type === 'encode') {
      if (!extractor) await loadModel();
      const vec = await encodeUrl(msg.url);
      post('encoded', {
        id: msg.id,
        key: msg.key,
        vec: Array.from(vec)
      });
      return;
    }
    if (msg.type === 'ping') {
      post('pong', {});
    }
  } catch (err) {
    post('error', { id: msg.id, message: String(err.message || err) });
  }
};
