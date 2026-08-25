/**
 * Self-check: verify near-duplicate rules on known pair (韦达定理笔记).
 * Run: node scripts/self-check-sim.mjs
 */
import sharp from 'sharp';
import { pipeline, RawImage, env } from '@xenova/transformers';
import fs from 'fs';
import path from 'path';

const URLS = [
  'https://cdn.jsdelivr.net/gh/PioneerSunOvO/PictureBed4PicGo@master/images/20241123141859218-9c310730f38b0a2e2dcd5166d5dc2c61.png',
  'https://cdn.jsdelivr.net/gh/PioneerSunOvO/PictureBed4PicGo@master/images/20241119194753146-ae8b0e862a001d1fa47bb18bae58490a.png'
];

const NEAR = {
  phashMax: 10,
  clipGrayMin: 0.94,
  clipHigh: 0.97,
  ssim: 0.85
};

function phashDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

async function dhash(path) {
  const { data, info } = await sharp(path)
    .resize(9, 8, { fit: 'contain', background: { r: 128, g: 128, b: 128 } })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits += data[y * w + x] < data[y * w + x + 1] ? '1' : '0';
    }
  }
  return bits;
}

function ssimGray(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let va = 0, vb = 0, cov = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    va += da * da; vb += db * db; cov += da * db;
  }
  va /= n; vb /= n; cov /= n;
  const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2;
  return ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
}

async function gray64Contain(p) {
  const { data } = await sharp(p).resize(64, 64, { fit: 'contain', background: { r: 128, g: 128, b: 128 } }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return Float32Array.from(data);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function main() {
  const dir = path.join(process.cwd(), '.self-check-tmp');
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < URLS.length; i++) {
    const f = path.join(dir, 'img' + i + '.png');
    const res = await fetch(URLS[i]);
    fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
    files.push(f);
  }

  const [h0, h1] = await Promise.all(files.map(dhash));
  const pd = phashDistance(h0, h1);
  const [g0, g1] = await Promise.all(files.map(gray64Contain));
  const ssim = ssimGray(g0, g1);

  env.allowLocalModels = false;
  const extractor = await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32', { quantized: true });
  async function embed(p) {
    const raw = await RawImage.read(p);
    const out = await extractor(raw, { pooling: 'mean', normalize: true });
    return Float32Array.from(out.data);
  }
  const [e0, e1] = await Promise.all(files.map(embed));
  const clip = cosine(e0, e1);

  const passPhash = pd <= NEAR.phashMax;
  const passClipHigh = clip >= NEAR.clipHigh;
  const passClipSsim = clip >= NEAR.clipGrayMin && ssim >= NEAR.ssim;
  const wouldMatch = passPhash || passClipHigh || passClipSsim;

  const result = {
    phashDist: pd,
    clip: Number(clip.toFixed(4)),
    ssimContain: Number(ssim.toFixed(4)),
    passPhash,
    passClipHigh,
    passClipSsim,
    wouldMatchNear: wouldMatch
  };
  console.log(JSON.stringify(result, null, 2));

  if (!wouldMatch) {
    console.error('SELF-CHECK FAILED: known pair should match near-duplicate rules');
    process.exit(1);
  }
  console.log('SELF-CHECK OK');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
