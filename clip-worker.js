/**
 * CLIP embedding worker — inference off main thread, multi-CDN + WebGPU when available.
 */
import { pipeline, env, RawImage } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const REMOTE_HOSTS = [
  'https://cdn.jsdelivr.net/npm/@xenova/',
  'https://hf-mirror.com/',
  'https://huggingface.co/'
];
const HOST_TIMEOUT_MS = 90000;

let extractor = null;
let activeHost = null;

function post(type, payload) {
  self.postMessage({ type, ...payload });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('model load timeout')), ms))
  ]);
}

function configureEnv(host) {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.remoteHost = host;
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.numThreads = typeof navigator !== 'undefined' && navigator.hardwareConcurrency > 1 ? 2 : 1;
  }
}

async function tryWebGpu() {
  try {
    if (typeof navigator !== 'undefined' && navigator.gpu && env.backends?.onnx?.webgpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        post('backend', { name: 'webgpu' });
        return true;
      }
    }
  } catch (_) { /* wasm fallback */ }
  post('backend', { name: 'wasm' });
  return false;
}

async function loadModel() {
  if (extractor) return extractor;
  await tryWebGpu();
  let lastErr;
  for (const host of REMOTE_HOSTS) {
    try {
      configureEnv(host);
      extractor = await withTimeout(
        pipeline('image-feature-extraction', MODEL_ID, {
          quantized: true,
          progress_callback: (data) => post('progress', { phase: 'model', data })
        }),
        HOST_TIMEOUT_MS
      );
      activeHost = host;
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

async function fetchImage(url) {
  const urls = [url];
  if (url.includes('cdn.jsdelivr.net/gh/')) {
    urls.push(url.replace('cdn.jsdelivr.net/gh/', 'raw.githubusercontent.com/').replace(/@[a-f0-9]{40}\//, '/master/'));
  }
  let lastErr;
  for (const u of urls) {
    try {
      const res = await fetch(u, { mode: 'cors', cache: 'default' });
      if (!res.ok) throw new Error('fetch ' + res.status);
      return await res.blob();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('fetch failed');
}

async function encodeUrl(url) {
  const blob = await fetchImage(url);
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
      post('ready', { host: activeHost });
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
