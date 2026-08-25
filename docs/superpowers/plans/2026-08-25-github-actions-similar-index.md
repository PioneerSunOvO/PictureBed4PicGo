# GitHub Actions Similar Index Implementation Plan

> **For agentic workers:** Execute inline in this session (user requested end-to-end results).

**Goal:** CI-precomputed similar groups via Python; gallery reads JSON only.

**Architecture:** Action runs `build_similar_index.py` on image push / manual dispatch; commits `meta/similar-index.json`; remove browser CLIP stack.

**Tech Stack:** Python 3.12, Pillow, imagehash, numpy, torch (CPU), transformers, pytest; static gallery JS.

**Spec:** `docs/superpowers/specs/2026-08-25-github-actions-similar-index-design.md`

## Global Constraints

- Accuracy rules and thresholds from spec (verbatim).
- Trigger paths: `images/**` only (meta commits must not loop).
- Do not expose PATs in gallery.

---

### Task 1: Python indexer + regression test

**Files:**
- Create: `scripts/requirements-similar.txt`
- Create: `scripts/build_similar_index.py`
- Create: `scripts/test_similar_index.py`

- [x] Implement hash/SSIM/CLIP/cluster/JSON writer
- [x] Test Vieta pair in-repo images must form a near group
- [x] Commit

### Task 2: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/similar-index.yml`

- [x] Cache HuggingFace; commit JSON with `contents: write`
- [x] Commit

### Task 3: Gallery + delete CLIP JS

**Files:**
- Modify: `gallery-app.js`, `gallery.html`, `README.md`
- Delete: `clip-embed.js`, `clip-worker.js`
- Delete or replace: `scripts/self-check-sim.mjs`

- [x] Load/filter JSON; refresh + Actions link
- [x] Commit + push
