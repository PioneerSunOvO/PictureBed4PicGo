/**
 * Multi-signal similarity: pHash (fast) + CLIP (optional) + contain SSIM (gray zone).
 */
export const MODEL_ID = 'Xenova/clip-vit-base-patch32';
export const ALGO_VERSION = 3;
export const CACHE_VERSION = 3;
const DB_NAME = 'pb4pg_clip_cache';
const DB_VERSION = 3;
const STORE = 'embeddings';
const PHASH_STORE = 'phash';

export const SIMILAR_MODES = {
  near: {
    label: '近重复',
    threshold: 0.94,
    min: 0.90,
    max: 0.99,
    clipGrayMin: 0.94,
    clipHigh: 0.97,
    ssim: 0.85,
    phashMax: 10,
    phashSuspectMax: 14,
    useSsim: true,
    maxGroupSize: 12
  },
  semantic: {
    label: '语义相似',
    threshold: 0.97,
    min: 0.94,
    max: 0.995,
    clipGrayMin: 0.97,
    clipHigh: 0.97,
    ssim: 0,
    phashMax: null,
    useSsim: false,
    maxGroupSize: 6
  }
};

export function getSimilarModeConfig(mode) {
  return SIMILAR_MODES[mode] || SIMILAR_MODES.near;
}

const memCache = new Map();
const phashMem = new Map();
let worker = null;
let workerReady = null;
let workerHost = null;
let clipAvailable = true;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(PHASH_STORE)) {
        db.createObjectStore(PHASH_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
}

function idbGet(storeName, key) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

function idbPut(storeName, record) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

export async function invalidateCache(key) {
  memCache.delete(key);
  try {
    await openDb().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  } catch (_) { /* ignore */ }
}

export function clearMemCache() {
  memCache.clear();
  phashMem.clear();
}

function isCurrentCacheRecord(rec) {
  if (!rec) return false;
  if (rec.version != null || rec.model != null) {
    return rec.version === CACHE_VERSION && rec.model === MODEL_ID;
  }
  const key = String(rec.key || '');
  return key.includes('::v' + CACHE_VERSION + '::') && key.startsWith(MODEL_ID + '::');
}

export async function purgeStaleCache() {
  memCache.clear();
  phashMem.clear();
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, PHASH_STORE], 'readwrite');
      let scanned = 0;
      let removed = 0;
      const clipStore = tx.objectStore(STORE);
      const req = clipStore.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        scanned++;
        if (!isCurrentCacheRecord(cursor.value)) {
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

export async function clearAllCache() {
  memCache.clear();
  phashMem.clear();
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, PHASH_STORE], 'readwrite');
      let cleared = 0;
      const clipStore = tx.objectStore(STORE);
      const countReq = clipStore.count();
      countReq.onsuccess = () => {
        cleared = countReq.result || 0;
        clipStore.clear();
        tx.objectStore(PHASH_STORE).clear();
      };
      countReq.onerror = () => reject(countReq.error);
      tx.oncomplete = () => resolve({ cleared });
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) {
    return { cleared: 0 };
  }
}

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

export function phashKeyFor(item) {
  if (item?.blobSha) return 'phash::v' + ALGO_VERSION + '::' + item.blobSha;
  return 'phash::v' + ALGO_VERSION + '::' + (item?.newRel || '');
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

export function phashDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
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

export function getClipStatus() {
  return { available: clipAvailable, host: workerHost };
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

function drawImageContain(ctx, img, w, h, bg) {
  ctx.fillStyle = bg || '#808080';
  ctx.fillRect(0, 0, w, h);
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function rgbGray(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** 64-bit difference hash (dHash). */
export async function computePhashFromUrl(url) {
  const img = await loadImage(url);
  const w = 9;
  const h = 8;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  drawImageContain(ctx, img, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  let bits = '';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < 8; x++) {
      const o1 = (y * w + x) * 4;
      const o2 = (y * w + x + 1) * 4;
      const g1 = rgbGray(px[o1], px[o1 + 1], px[o1 + 2]);
      const g2 = rgbGray(px[o2], px[o2 + 1], px[o2 + 2]);
      bits += g1 < g2 ? '1' : '0';
    }
  }
  return bits;
}

async function gray64ContainFromUrl(url) {
  const img = await loadImage(url);
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  drawImageContain(ctx, img, size, size);
  const px = ctx.getImageData(0, 0, size, size).data;
  const gray = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    gray[i] = rgbGray(px[o], px[o + 1], px[o + 2]);
  }
  return gray;
}

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

async function getCachedPhash(key) {
  if (phashMem.has(key)) return phashMem.get(key);
  const stored = await idbGet(PHASH_STORE, key);
  if (stored?.hash && stored.version === ALGO_VERSION) {
    phashMem.set(key, stored.hash);
    return stored.hash;
  }
  return null;
}

async function storePhash(key, hash, rel) {
  phashMem.set(key, hash);
  await idbPut(PHASH_STORE, { key, hash, version: ALGO_VERSION, rel, ts: Date.now() });
}

async function getCachedVec(key) {
  if (memCache.has(key)) return { vec: memCache.get(key), fromCache: true };
  const stored = await idbGet(STORE, key);
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
  await idbPut(STORE, {
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

function resetWorker() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  workerReady = null;
  workerHost = null;
}

function ensureWorker() {
  if (workerReady) return workerReady;
  worker = new Worker(new URL('./clip-worker.js', import.meta.url), { type: 'module' });
  workerReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resetWorker();
      reject(new Error('Worker 启动超时'));
    }, 120000);
    const onMsg = (e) => {
      const msg = e.data || {};
      if (msg.type === 'modelHost') workerHost = msg.host;
      if (msg.type === 'ready') {
        clearTimeout(timer);
        worker.removeEventListener('message', onMsg);
        clipAvailable = true;
        resolve(worker);
      } else if (msg.type === 'error' && !msg.id) {
        clearTimeout(timer);
        worker.removeEventListener('message', onMsg);
        clipAvailable = false;
        resetWorker();
        reject(new Error(msg.message || 'Worker error'));
      }
    };
    worker.addEventListener('message', onMsg);
    worker.onerror = (err) => {
      clearTimeout(timer);
      clipAvailable = false;
      resetWorker();
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
 * Phase A — fast pHash scan (always runs, no CDN dependency).
 */
export async function scanPhashes(opts) {
  const { items, urlFor, onProgress } = opts;
  let done = 0;
  let cacheHits = 0;
  const total = items.length;
  for (const item of items) {
    const key = phashKeyFor(item);
    const cached = await getCachedPhash(key);
    if (cached) {
      item.phash = cached;
      cacheHits++;
    } else {
      try {
        item.phash = await computePhashFromUrl(urlFor(item));
        await storePhash(key, item.phash, item.newRel);
      } catch (_) {
        item.phash = null;
      }
    }
    done++;
    if (done % 2 === 0 || done === total) {
      onProgress?.({ phase: 'phash', done, total, cacheHits, label: '感知哈希 ' + done + '/' + total });
    }
  }
  return { cacheHits };
}

/**
 * Phase B — CLIP embeddings (optional; failure does not abort scan).
 */
export async function scanEmbeddings(opts) {
  const { items, repoHead, urlFor, onProgress } = opts;
  let done = 0;
  let cacheHits = 0;
  let encoded = 0;
  let failed = 0;
  const total = items.length;
  const pending = [];

  onProgress?.({ phase: 'model', done: 0, total, cacheHits, label: '正在加载 CLIP 模型…' });

  try {
    await ensureWorker();
  } catch (e) {
    clipAvailable = false;
    onProgress?.({ phase: 'encode', done: total, total, cacheHits, label: 'CLIP 不可用，仅感知哈希' });
    return { cacheHits: 0, encoded: 0, failed: total, clipAvailable: false, error: e.message };
  }

  for (const item of items) {
    const key = cacheKeyFor(item, repoHead);
    const cached = await getCachedVec(key);
    if (cached) {
      item.embedding = cached.vec;
      item.embeddingKey = key;
      cacheHits++;
      done++;
      continue;
    }
    pending.push({ item, key });
  }

  onProgress?.({
    phase: 'encode',
    done,
    total,
    cacheHits,
    label: 'CLIP 向量（待算 ' + pending.length + '）…'
  });

  let encodeId = 0;
  for (const { item, key } of pending) {
    let vec = null;
    try {
      vec = await encodeInWorker('e' + (encodeId++), key, urlFor(item));
    } catch (_) {
      failed++;
    }
    if (vec) {
      item.embedding = await storeVec(key, vec, item.newRel);
      item.embeddingKey = key;
      encoded++;
    }
    done++;
    if (done % 1 === 0 || done === total) {
      onProgress?.({ phase: 'encode', done, total, cacheHits, label: 'CLIP 向量 ' + done + '/' + total });
    }
  }

  onProgress?.({ phase: 'cluster', done: total, total, cacheHits, label: '聚类分析…' });
  return { cacheHits, encoded, failed, clipAvailable: clipAvailable && encoded + cacheHits > 0 };
}

const ssimCache = new Map();

async function ssimBetween(urlA, urlB) {
  const k = urlA + '||' + urlB;
  if (ssimCache.has(k)) return ssimCache.get(k);
  const [ga, gb] = await Promise.all([
    gray64ContainFromUrl(urlA),
    gray64ContainFromUrl(urlB)
  ]);
  const s = ssimGray64(ga, gb);
  ssimCache.set(k, s);
  return s;
}

function pairKey(i, j) {
  return i < j ? i + ':' + j : j + ':' + i;
}

function formatPath(edge) {
  if (edge.path === 'phash') return 'pHash≤' + edge.phashDist;
  if (edge.path === 'clip') return 'CLIP ' + formatSimilarity(edge.clip);
  if (edge.path === 'clip+ssim') {
    return 'CLIP ' + formatSimilarity(edge.clip) + ' + SSIM ' + Math.round(edge.ssim * 1000) / 10 + '%';
  }
  if (edge.path === 'semantic') return '语义 ' + formatSimilarity(edge.clip);
  return edge.path || '';
}

/**
 * Evaluate whether two items match under the given mode.
 */
async function evaluatePair(a, b, ai, bi, mode, threshold, urlFor, hasClip) {
  const cfg = getSimilarModeConfig(mode);
  const thresh = threshold ?? cfg.threshold;
  const phashDist = (a.phash && b.phash) ? phashDistance(a.phash, b.phash) : 64;
  const clip = (hasClip && a.embedding && b.embedding)
    ? cosineSimilarity(a.embedding, b.embedding) : null;

  if (mode === 'near') {
    if (phashDist <= cfg.phashMax) {
      return { i: ai, j: bi, confirmed: true, suspect: false, path: 'phash', phashDist, clip };
    }
    if (clip != null && clip >= cfg.clipHigh) {
      return { i: ai, j: bi, confirmed: true, suspect: false, path: 'clip', phashDist, clip };
    }
    if (clip != null && clip >= cfg.clipGrayMin && cfg.useSsim) {
      try {
        const ssim = await ssimBetween(urlFor(a), urlFor(b));
        if (ssim >= cfg.ssim) {
          return { i: ai, j: bi, confirmed: true, suspect: false, path: 'clip+ssim', phashDist, clip, ssim };
        }
        if (clip >= thresh - 0.02 || phashDist <= cfg.phashSuspectMax) {
          return { i: ai, j: bi, confirmed: false, suspect: true, path: 'clip+ssim', phashDist, clip, ssim };
        }
      } catch (_) { /* skip */ }
    }
    if (phashDist <= cfg.phashSuspectMax || (clip != null && clip >= thresh - 0.02 && clip < thresh)) {
      return { i: ai, j: bi, confirmed: false, suspect: true, path: 'near-suspect', phashDist, clip };
    }
    return null;
  }

  // semantic
  if (clip != null && clip >= thresh) {
    return { i: ai, j: bi, confirmed: true, suspect: false, path: 'semantic', phashDist, clip };
  }
  if (clip != null && clip >= thresh - 0.02 && clip < thresh) {
    return { i: ai, j: bi, confirmed: false, suspect: true, path: 'semantic-suspect', phashDist, clip };
  }
  return null;
}

/** Union-find single-linkage clustering from pair edges. */
export function clusterFromPairs(n, pairs, maxGroupSize) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const edgeMap = new Map();

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  }

  for (const p of pairs) {
    union(p.i, p.j);
    edgeMap.set(pairKey(p.i, p.j), p);
  }

  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!buckets.has(r)) buckets.set(r, []);
    buckets.get(r).push(i);
  }

  return [...buckets.values()]
    .filter(g => g.length >= 2)
    .map(indices => {
      if (maxGroupSize && indices.length > maxGroupSize) {
        return indices.slice(0, maxGroupSize);
      }
      return indices;
    })
    .filter(g => g.length >= 2);
}

export function annotateGroup(items, indices, edgeMap, keepRel) {
  const groupItems = indices.map(i => items[i]);
  const keep = groupItems.find(it => it.newRel === keepRel) || groupItems[groupItems.length - 1];
  const paths = new Set();
  let minClip = 1;
  let maxClip = 0;
  let sumClip = 0;
  let clipCnt = 0;

  for (const item of groupItems) {
    delete item.matchPath;
    delete item.simToKeep;
    delete item.ssimToKeep;
    delete item.phashDistToKeep;
  }

  for (let a = 0; a < indices.length; a++) {
    for (let b = a + 1; b < indices.length; b++) {
      const edge = edgeMap.get(pairKey(indices[a], indices[b]));
      if (edge) paths.add(formatPath(edge));
    }
  }

  const keepIdx = indices.find(i => items[i].newRel === keepRel) ?? indices[indices.length - 1];
  for (const idx of indices) {
    if (idx === keepIdx) continue;
    const edge = edgeMap.get(pairKey(keepIdx, idx));
    const item = items[idx];
    if (edge) {
      item.matchPath = formatPath(edge);
      if (edge.clip != null) item.simToKeep = edge.clip;
      if (edge.ssim != null) item.ssimToKeep = edge.ssim;
      if (edge.phashDist != null) item.phashDistToKeep = edge.phashDist;
    }
    if (item.simToKeep != null) {
      minClip = Math.min(minClip, item.simToKeep);
      maxClip = Math.max(maxClip, item.simToKeep);
      sumClip += item.simToKeep;
      clipCnt++;
    }
  }

  return {
    items: groupItems,
    keepRel: keep.newRel,
    paths: [...paths],
    minSimilarity: clipCnt ? minClip : null,
    maxSimilarity: clipCnt ? maxClip : null,
    avgSimilarity: clipCnt ? sumClip / clipCnt : null
  };
}

/**
 * Build confirmed groups + suspect pairs from multi-signal rules.
 */
export async function buildSimilarGroups(opts) {
  const {
    items,
    mode,
    threshold,
    urlFor,
    clipAvailable: clipOk,
    onProgress
  } = opts;

  const cfg = getSimilarModeConfig(mode);
  const thresh = threshold ?? cfg.threshold;
  const hasClip = !!clipOk;
  const n = items.length;
  const confirmed = [];
  const suspects = [];
  let pairChecks = 0;
  const totalPairs = (n * (n - 1)) / 2;

  ssimCache.clear();

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const result = await evaluatePair(
        items[i], items[j], i, j, mode, thresh, urlFor, hasClip
      );
      pairChecks++;
      if (pairChecks % 50 === 0 || pairChecks === totalPairs) {
        onProgress?.({
          phase: 'cluster',
          done: pairChecks,
          total: totalPairs,
          label: '配对分析 ' + pairChecks + '/' + totalPairs
        });
      }
      if (!result) continue;
      if (result.confirmed) confirmed.push(result);
      else if (result.suspect) suspects.push(result);
    }
  }

  const edgeMap = new Map();
  confirmed.forEach(p => edgeMap.set(pairKey(p.i, p.j), p));

  const clusterIndices = clusterFromPairs(n, confirmed, cfg.maxGroupSize);
  const groups = clusterIndices.map((indices, gi) => {
    const groupItems = indices.map(i => items[i]);
    const sorted = [...groupItems].sort((a, b) => {
      const da = a.date ? a.date.getTime() : 0;
      const db = b.date ? b.date.getTime() : 0;
      return da - db || a.name.localeCompare(b.name);
    });
    const keep = sorted[sorted.length - 1];
    const ann = annotateGroup(items, indices, edgeMap, keep.newRel);
    return {
      id: 'sim-' + gi + '-' + keep.newRel.slice(7, 16),
      type: 'similar',
      items: sorted,
      keepRel: keep.newRel,
      paths: ann.paths,
      minSimilarity: ann.minSimilarity,
      maxSimilarity: ann.maxSimilarity,
      avgSimilarity: ann.avgSimilarity
    };
  }).sort((a, b) => b.items.length - a.items.length);

  const suspectGroups = suspects.slice(0, 30).map((p, si) => {
    const a = items[p.i];
    const b = items[p.j];
    return {
      id: 'suspect-' + si,
      type: 'suspect',
      items: [a, b],
      keepRel: a.newRel,
      paths: [formatPath(p)],
      minSimilarity: p.clip,
      phashDist: p.phashDist,
      ssim: p.ssim
    };
  });

  return {
    groups,
    suspects: suspectGroups,
    meta: {
      mode,
      threshold: thresh,
      clipAvailable: hasClip,
      clipHost: workerHost,
      confirmedPairs: confirmed.length,
      suspectPairs: suspects.length
    }
  };
}

/** @deprecated use buildSimilarGroups */
export function clusterCompleteLinkage(items, minSimilarity) {
  const pairs = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (!items[i].embedding || !items[j].embedding) continue;
      const s = cosineSimilarity(items[i].embedding, items[j].embedding);
      if (s >= minSimilarity) pairs.push({ i, j, clip: s, path: 'clip', confirmed: true });
    }
  }
  const clusters = clusterFromPairs(items.length, pairs, 99);
  return clusters.map(c => c.map(i => items[i])).filter(g => g.length >= 2);
}

export function groupStats(items, keepRel) {
  const keep = items.find(i => i.newRel === keepRel) || items[0];
  let min = 1;
  let max = 0;
  let sum = 0;
  let cnt = 0;
  for (const item of items) {
    if (item === keep) continue;
    const s = item.simToKeep != null
      ? item.simToKeep
      : (keep.embedding && item.embedding ? cosineSimilarity(keep.embedding, item.embedding) : null);
    if (s == null) continue;
    item.simToKeep = s;
    min = Math.min(min, s);
    max = Math.max(max, s);
    sum += s;
    cnt++;
  }
  return { min: cnt ? min : 1, max: cnt ? max : 1, avg: cnt ? sum / cnt : 1 };
}

export function terminateWorker() {
  resetWorker();
  clipAvailable = false;
}
