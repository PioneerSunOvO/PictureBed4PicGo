# Design: GitHub Actions Similar Index (Pure GitHub)

**Date:** 2026-08-25  
**Repo:** PictureBed4PicGo  
**Status:** Approved (user: pure GitHub · full Python · accuracy-first · remove browser CLIP)

## Goal

Replace unreliable in-browser CLIP/pHash scanning with a deterministic CI pipeline that writes `meta/similar-index.json`. Gallery only reads and displays that file.

## Decisions

| Topic | Choice |
|-------|--------|
| Hosting | GitHub Pages (static) + GitHub Actions (compute) |
| Stack | All Python (`Pillow`, `imagehash`, `torch`+`transformers` CLIP) |
| Detection | Near-duplicate + semantic CLIP |
| Rebuild | `push` on `images/**` + `workflow_dispatch`; gallery links to Actions |
| Browser CLIP | Remove (`clip-embed.js`, `clip-worker.js`) |

## Architecture

```
push images/** | workflow_dispatch
  → scripts/build_similar_index.py
  → meta/similar-index.json (committed)
  → gallery fetch JSON
```

## Algorithm (accuracy baseline)

**Near confirmed** if any of:

1. dHash ≤ 8 **or** pHash ≤ 8 (low-entropy: ≤ 4 for the signal used)
2. CLIP ≥ 0.94 **and** contain-SSIM ≥ 0.85

Clustering: complete-linkage; `maxGroupSize = 6`.

**Semantic:** CLIP ≥ 0.97 only (no SSIM); exclude members already in a near group.  
Bare CLIP≥0.97 is **not** treated as near (reduces theme-level false positives).

**CLIP failure:** still emit near groups; `clipStatus: "failed"`; no semantic groups.

## JSON

Path: `meta/similar-index.json`  
Fields: `algoVersion`, `generatedAt`, `imageCount`, `clipStatus`, `clipModel`, `clipError`, `groups[]`, `suspects[]`.  
Group `kind`: `near` | `semantic`. Items carry `file`, `role`, `matchPath`, optional metrics.

## Regression

- Vieta theorem pair must share one `near` group.
- At least one known false-positive pair must not share a group.

## Gallery UX

- 「相似」loads JSON (cache-bust).
- 「刷新索引」re-fetches JSON.
- 「触发重算」opens Actions workflow page (manual Run).
- Mode filter: show near / semantic / both (client filter only; no recompute).

## Non-goals

- No HTTP similarity API on Pages.
- No browser model download.
- No Cloudflare/Vercel workers in this phase.
