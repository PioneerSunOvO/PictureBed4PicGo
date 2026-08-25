/**
 * CLIP similarity utilities: IndexedDB cache, clustering, SSIM refine, worker scanner.
 */
export const MODEL_ID = 'Xenova/clip-vit-base-patch32';
export const CACHE_VERSION = 2;
const DB_NAME = 'pb4pg_clip_cache';
const DB_VERSION = 2;
const STORE = 'embeddings';

const SIMILAR_MODES = {
  near: { label: '近重复', threshold: 0.98, min: 0.96, max: 0.995, ssim: 0.88 },
  semantic: { label: '语义相似', threshold: 0.92, min: 0.85, max: 0.97, ssim: 0.75 }
};

export function getSimilarModeConfig(mode) {
  return SIMILAR_MODES[mode] || SIMILAR_MODES.near;
}

const memCache = new Map();
let worker = null;
let workerReady = null;

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

export async function invalidateCache(key) {
  memCache.delete(key);
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) { /* ignore */ }
}

export function clearMemCache() {
  memCache.clear();
}

function isCurrentCacheRecord(rec) {
  if (!rec) return false;
  if (rec.version != null || rec.model != null) {
    return rec.version === CACHE_VERSION && rec.model === MODEL_ID;
  }
  // Legacy rows without version/model: require current version marker in key.
  const key = String(rec.key || '');
  return key.includes('::v' + CACHE_VERSION + '::') && key.startsWith(MODEL_ID + '::');
}

/**
 * Delete IndexedDB rows that do not match current MODEL_ID + CACHE_VERSION.
 * Safe to call on every page open.
 * @returns {{ scanned: number, removed: number }}
 */
export async function purgeStaleCache() {
  memCache.clear();
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.openCursor();
      let scanned = 0;
      let removed = 0;
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        scanned++;
        const rec = cursor.value;
        if (!isCurrentCacheRecord(rec)) {
          cursor.delete();
          removed++;
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve({ scanned, removed });
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) {
    return { scanned: 0, removed: 0 };
  }
}

/**
 * Wipe all CLIP embedding cache (IndexedDB + memory).
 * @returns {{ cleared: number }}
 */
export async function clearAllCache() {
  memCache.clear();
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      let cleared = 0;
      const countReq = store.count();
      countReq.onsuccess = () => {
        cleared = countReq.result || 0;
        store.clear();
      };
      countReq.onerror = () => reject(countReq.error);
      tx.oncomplete = () => resolve({ cleared });
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) {
    return { cleared: 0 };
  }
}

/** Approximate entry count for UI hints. */
export async function cacheStats() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => resolve({ count: req.result || 0 });
      req.onerror = () => reject(req.error);
    });
  } catch (_) {
    return { count: 0 };
  }
}

export function cacheKeyFor(item, repoHead) {
  if (item?.blobSha) return MODEL_ID + '::v' + CACHE_VERSION + '::' + item.blobSha;
  const rel = item?.newRel ? item.newRel : String(item || '');
  return MODEL_ID + '::v' + CACHE_VERSION + '::' + (repoHead || 'head') + '::' + rel;
}

export function normalizeVec(vec) {
  const out = vec instanceof Float32Array ? new Float32Array(vec) : new Float32Array(vec);
  let norm = 0;
  for (let i = 0; i < out.length; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  const va = normalizeVec(a);
  const vb = normalizeVec(b);
  let dot = 0;
  for (let i = 0; i < va.length; i++) dot += va[i] * vb[i];
  return Math.max(-1, Math.min(1, dot));
}

export function formatSimilarity(sim) {
  const pct = Math.round(Math.max(0, Math.min(1, sim)) * 1000) / 10;
  return pct + '%';
}

export function formatLoadProgress(data) {
  if (!data) return '加载 CLIP 模型…';
  if (data.status === 'initiate') return '准备下载模型…';
  if (data.status === 'download' && data.total) {
    return '下载 CLIP 模型 ' + Math.round((data.loaded / data.total) * 100) + '%';
  }
  if (data.status === 'done') return '模型就绪';
  if (data.status === 'progress' && data.file) return '加载 ' + data.file;
  return '加载 CLIP 模型…';
}

async function getCachedVec(key) {
  if (memCache.has(key)) return { vec: memCache.get(key), fromCache: true };
  const stored = await idbGet(key);
  if (stored?.vec && stored.version === CACHE_VERSION && stored.model === MODEL_ID) {
    const vec = normalizeVec(new Float32Array(stored.vec));
    memCache.set(key, vec);
    return { vec, fromCache: true };
  }
  return null;
}

async function storeVec(key, vec, rel) {
  const normalized = normalizeVec(vec);
  memCache.set(key, normalized);
  await idbPut({
    key,
    model: MODEL_ID,
    version: CACHE_VERSION,
    vec: normalized.buffer.slice(0),
    dim: normalized.length,
    rel,
    ts: Date.now()
  });
  return normalized;
}

function ensureWorker() {
  if (workerReady) return workerReady;
  worker = new Worker(new URL('./clip-worker.js', import.meta.url), { type: 'module' });
  workerReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker 启动超时')), 120000);
    worker.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'ready') {
        clearTimeout(timer);
        resolve(worker);
      } else if (msg.type === 'error' && !msg.id) {
        clearTimeout(timer);
        reject(new Error(msg.message || 'Worker error'));
      }
    };
    worker.onerror = (err) => {
      clearTimeout(timer);
      reject(err);
    };
    worker.postMessage({ type: 'init' });
  });
  return workerReady;
}

function encodeInWorker(id, key, url) {
  return new Promise((resolve, reject) => {
    const onMsg = (e) => {
      const msg = e.data || {};
      if (msg.type === 'encoded' && msg.id === id) {
        worker.removeEventListener('message', onMsg);
        resolve(normalizeVec(new Float32Array(msg.vec)));
      } else if (msg.type === 'error' && msg.id === id) {
        worker.removeEventListener('message', onMsg);
        reject(new Error(msg.message || 'encode failed'));
      }
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage({ type: 'encode', id, key, url });
  });
}

/**
 * Complete-linkage clustering: every pair in a cluster must meet minSimilarity.
 */
export function clusterCompleteLinkage(items, minSimilarity) {
  const n = items.length;
  if (n < 2) return [];
  let clusters = items.map((item, i) => [i]);

  while (clusters.length > 1) {
    let bestA = -1;
    let bestB = -1;
    let bestMin = -1;
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        let pairMin = 1;
        for (const i of clusters[a]) {
          for (const j of clusters[b]) {
            pairMin = Math.min(pairMin, cosineSimilarity(items[i].embedding, items[j].embedding));
          }
        }
        if (pairMin >= minSimilarity && pairMin > bestMin) {
          bestMin = pairMin;
          bestA = a;
          bestB = b;
        }
      }
    }
    if (bestA < 0) break;
    clusters[bestA] = clusters[bestA].concat(clusters[bestB]);
    clusters.splice(bestB, 1);
  }
  return clusters.map(c => c.map(i => items[i])).filter(g => g.length >= 2);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

async function gray64FromUrl(url) {
  const img = await loadImage(url);
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, size, size);
  const px = ctx.getImageData(0, 0, size, size).data;
  const gray = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    gray[i] = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
  }
  return gray;
}

/** Lightweight SSIM on 64×64 grayscale (structural check for near-duplicates). */
export function ssimGray64(a, b) {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;
  let varA = 0;
  let varB = 0;
  let cov = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    varA += da * da;
    varB += db * db;
    cov += da * db;
  }
  varA /= n;
  varB /= n;
  cov /= n;
  const c1 = 0.01 * 255 * 0.01 * 255;
  const c2 = 0.03 * 255 * 0.03 * 255;
  const num = (2 * meanA * meanB + c1) * (2 * cov + c2);
  const den = (meanA * meanA + meanB * meanB + c1) * (varA + varB + c2);
  return den ? num / den : 0;
}

export async function refineGroupBySsim(items, keepRel, urlsFor, minSsim) {
  const keep = items.find(i => i.newRel === keepRel) || items[0];
  const keepUrl = urlsFor(keep);
  let keepGray;
  try {
    keepGray = await gray64FromUrl(keepUrl);
  } catch (_) {
    return items;
  }
  const refined = [keep];
  for (const item of items) {
    if (item.newRel === keep.newRel) continue;
    try {
      const g = await gray64FromUrl(urlsFor(item));
      const s = ssimGray64(keepGray, g);
      item.ssimToKeep = s;
      if (s >= minSsim) refined.push(item);
    } catch (_) { /* drop unreadable */ }
  }
  return refined.length >= 2 ? refined : [];
}

export function groupStats(items, keepRel) {
  const keep = items.find(i => i.newRel === keepRel) || items[0];
  let min = 1;
  let max = 0;
  let sum = 0;
  let cnt = 0;
  for (const item of items) {
    if (item === keep) continue;
    const s = cosineSimilarity(keep.embedding, item.embedding);
    item.simToKeep = s;
    min = Math.min(min, s);
    max = Math.max(max, s);
    sum += s;
    cnt++;
  }
  return {
    min: cnt ? min : 1,
    max: cnt ? max : 1,
    avg: cnt ? sum / cnt : 1
  };
}

/**
 * Scan items: incremental IndexedDB + Web Worker encoding.
 * @param {object} opts
 * @param {Array} opts.items
 * @param {string} opts.repoHead
 * @param {function} opts.urlFor - (item) => string
 * @param {function} [opts.onProgress] - ({phase, done, total, cacheHits, label})
 */
export async function scanEmbeddings(opts) {
  const { items, repoHead, urlFor, onProgress } = opts;
  await ensureWorker();

  let done = 0;
  let cacheHits = 0;
  const total = items.length;
  const pending = [];

  onProgress?.({ phase: 'model', done: 0, total, cacheHits, label: '正在加载 CLIP 模型（Worker）…' });

  for (const item of items) {
    const key = cacheKeyFor(item, repoHead);
    const cached = await getCachedVec(key);
    if (cached) {
      item.embedding = cached.vec;
      item.embeddingKey = key;
      cacheHits++;
      done++;
      if (done % 3 === 0 || done === total) {
        onProgress?.({ phase: 'encode', done, total, cacheHits, label: '读取缓存向量…' });
      }
      continue;
    }
    pending.push({ item, key });
  }

  onProgress?.({
    phase: 'encode',
    done,
    total,
    cacheHits,
    label: '正在提取向量（' + pending.length + ' 张待计算）…'
  });

  let encodeId = 0;
  for (const { item, key } of pending) {
    const urls = [urlFor(item)];
    let vec = null;
    let lastErr;
    for (const url of urls) {
      try {
        vec = await encodeInWorker('e' + (encodeId++), key, url);
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (vec) {
      item.embedding = await storeVec(key, vec, item.newRel);
      item.embeddingKey = key;
    }
    done++;
    if (done % 1 === 0 || done === total) {
      onProgress?.({ phase: 'encode', done, total, cacheHits, label: '提取 CLIP 向量…' });
    }
    if (!vec && lastErr) {
      /* skip item */
    }
  }

  onProgress?.({ phase: 'cluster', done: total, total, cacheHits, label: '聚类分析…' });
  return { cacheHits, encoded: pending.length };
}

export function terminateWorker() {
  if (worker) {
    worker.terminate();
    worker = null;
    workerReady = null;
  }
}
