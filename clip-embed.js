/**
 * CLIP ViT-B/32 image embeddings for browser-side similarity detection.
 * Model weights cached via Transformers.js (Cache API); vectors in IndexedDB.
 */
export const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const DB_NAME = 'pb4pg_clip_cache';
const DB_VERSION = 1;
const STORE = 'embeddings';
const TRANSFORMERS_CDN =
  'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm';

let extractor = null;
let loadPromise = null;
const memCache = new Map();

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
}

function idbGet(key) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

function idbPut(record) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function idbDelete(key) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

/** Stable cache key: prefer Git blob SHA, else commit + path. */
export function cacheKeyFor(item, repoHead) {
  if (item && item.blobSha) return MODEL_ID + '::' + item.blobSha;
  const rel = item && item.newRel ? item.newRel : String(item || '');
  return MODEL_ID + '::' + (repoHead || 'head') + '::' + rel;
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Load CLIP model (once). Weights cached in browser Cache API by Transformers.js.
 * @param {function} onProgress - ({ status, file, progress, loaded, total })
 */
export async function ensureClip(onProgress) {
  if (extractor) return extractor;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const { pipeline, env } = await import(TRANSFORMERS_CDN);
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
      env.backends.onnx.wasm.numThreads = Math.min(navigator.hardwareConcurrency || 4, 8);
    }
    extractor = await pipeline('image-feature-extraction', MODEL_ID, {
      quantized: true,
      progress_callback: (data) => {
        if (onProgress) onProgress(data);
      }
    });
    return extractor;
  })();
  try {
    return await loadPromise;
  } catch (e) {
    loadPromise = null;
    throw e;
  }
}

async function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

async function imageToBlob(img) {
  const maxSide = 512;
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  if (w > maxSide || h > maxSide) {
    const scale = maxSide / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('canvas toBlob failed'))), 'image/png');
  });
}

async function encodeBlob(model, blob) {
  const { RawImage } = await import(TRANSFORMERS_CDN);
  const raw = await RawImage.fromBlob(blob);
  const out = await model(raw, { pooling: 'mean', normalize: true });
  const data = out && out.data;
  if (!data || !data.length) throw new Error('empty CLIP embedding');
  return new Float32Array(data);
}

/**
 * Get 512-d CLIP embedding for an item. Checks memory → IndexedDB → compute.
 * @returns {{ vec: Float32Array, fromCache: boolean }}
 */
export async function getEmbedding(item, urls, key, onModelProgress) {
  if (memCache.has(key)) {
    return { vec: memCache.get(key), fromCache: true };
  }
  const stored = await idbGet(key);
  if (stored && stored.vec && stored.model === MODEL_ID) {
    const vec = new Float32Array(stored.vec);
    memCache.set(key, vec);
    return { vec, fromCache: true };
  }

  const model = await ensureClip(onModelProgress);
  let lastErr;
  for (const url of urls) {
    try {
      const img = await loadImage(url);
      const blob = await imageToBlob(img);
      const vec = await encodeBlob(model, blob);
      memCache.set(key, vec);
      await idbPut({
        key,
        model: MODEL_ID,
        vec: vec.buffer.slice(0),
        dim: vec.length,
        rel: item.newRel,
        ts: Date.now()
      });
      return { vec, fromCache: false };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('无法计算 CLIP embedding');
}

export async function invalidateCache(key) {
  memCache.delete(key);
  try {
    await idbDelete(key);
  } catch (_) { /* ignore */ }
}

export async function clearMemCache() {
  memCache.clear();
}

export function formatLoadProgress(data) {
  if (!data) return '';
  if (data.status === 'initiate') return '准备下载模型…';
  if (data.status === 'download' && data.total) {
    const pct = Math.round((data.loaded / data.total) * 100);
    return '下载 CLIP 模型 ' + pct + '%';
  }
  if (data.status === 'done') return '模型就绪';
  if (data.status === 'progress' && data.file) return '加载 ' + data.file;
  return '加载 CLIP 模型…';
}
