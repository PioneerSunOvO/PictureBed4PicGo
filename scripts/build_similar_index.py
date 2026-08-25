#!/usr/bin/env python3
"""Build meta/similar-index.json from images/ (pHash + CLIP)."""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import imagehash
import numpy as np
from PIL import Image, ImageOps

ALGO_VERSION = 1
CLIP_MODEL_ID = "openai/clip-vit-base-patch32"
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}

# Near-duplicate rules (spec)
DHASH_MAX = 8
PHASH_MAX = 8
LOW_ENTROPY_HASH_MAX = 4
LOW_ENTROPY_VAR = 120.0
CLIP_HIGH = 0.97
CLIP_GRAY = 0.94
SSIM_MIN = 0.85
MAX_GROUP_SIZE = 6
SUSPECT_PHASH = 12
SUSPECT_CLIP = 0.90


@dataclass
class ImageRecord:
    file: str
    path: Path
    dhash: Any = None
    phash: Any = None
    variance: float = 0.0
    low_entropy: bool = False
    embedding: np.ndarray | None = None


@dataclass
class PairHit:
    a: str
    b: str
    kind: str  # near | semantic | suspect
    match_path: str
    phash_dist: int | None = None
    dhash_dist: int | None = None
    clip_sim: float | None = None
    ssim: float | None = None


def list_images(images_dir: Path) -> list[Path]:
    files = [
        p
        for p in sorted(images_dir.iterdir())
        if p.is_file() and p.suffix.lower() in IMAGE_EXTS
    ]
    return files


def gray_variance(img: Image.Image, size: int = 32) -> float:
    g = ImageOps.contain(img.convert("L"), (size, size))
    canvas = Image.new("L", (size, size), 128)
    canvas.paste(g, ((size - g.width) // 2, (size - g.height) // 2))
    arr = np.asarray(canvas, dtype=np.float64)
    return float(arr.var())


def compute_hashes(rec: ImageRecord) -> None:
    with Image.open(rec.path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        rec.dhash = imagehash.dhash(im)
        rec.phash = imagehash.phash(im)
        rec.variance = gray_variance(im)
        rec.low_entropy = rec.variance < LOW_ENTROPY_VAR


def contain_gray64(path: Path) -> np.ndarray:
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("L")
        g = ImageOps.contain(im, (64, 64))
        canvas = Image.new("L", (64, 64), 128)
        canvas.paste(g, ((64 - g.width) // 2, (64 - g.height) // 2))
        return np.asarray(canvas, dtype=np.float64)


def ssim_simple(a: np.ndarray, b: np.ndarray) -> float:
    a = a.ravel()
    b = b.ravel()
    n = a.size
    ma = float(a.mean())
    mb = float(b.mean())
    va = float(((a - ma) ** 2).mean())
    vb = float(((b - mb) ** 2).mean())
    cov = float(((a - ma) * (b - mb)).mean())
    c1 = (0.01 * 255) ** 2
    c2 = (0.03 * 255) ** 2
    return float(
        ((2 * ma * mb + c1) * (2 * cov + c2))
        / ((ma * ma + mb * mb + c1) * (va + vb + c2) + 1e-12)
    )


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na < 1e-12 or nb < 1e-12:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def load_clip(device: str = "cpu"):
    import torch
    from transformers import CLIPModel, CLIPProcessor

    model = CLIPModel.from_pretrained(CLIP_MODEL_ID)
    processor = CLIPProcessor.from_pretrained(CLIP_MODEL_ID)
    model.eval()
    model.to(device)
    return model, processor, torch


def encode_clip(
    records: list[ImageRecord],
    model,
    processor,
    torch,
    device: str = "cpu",
    batch_size: int = 8,
) -> None:
    for i in range(0, len(records), batch_size):
        batch = records[i : i + batch_size]
        images = []
        for rec in batch:
            with Image.open(rec.path) as im:
                images.append(ImageOps.exif_transpose(im).convert("RGB"))
        inputs = processor(images=images, return_tensors="pt", padding=True)
        inputs = {k: v.to(device) for k, v in inputs.items()}
        with torch.no_grad():
            feats = model.get_image_features(**inputs)
            feats = feats / feats.norm(dim=-1, keepdim=True)
        arr = feats.detach().cpu().numpy()
        for j, rec in enumerate(batch):
            rec.embedding = arr[j].astype(np.float32)


def hash_limits(a: ImageRecord, b: ImageRecord) -> tuple[int, int]:
    if a.low_entropy or b.low_entropy:
        return LOW_ENTROPY_HASH_MAX, LOW_ENTROPY_HASH_MAX
    return DHASH_MAX, PHASH_MAX


def analyze_pairs(
    records: list[ImageRecord],
    clip_ok: bool,
) -> tuple[list[PairHit], list[PairHit]]:
    by_name = {r.file: r for r in records}
    confirmed: list[PairHit] = []
    suspects: list[PairHit] = []
    names = [r.file for r in records]
    gray_cache: dict[str, np.ndarray] = {}

    def gray(name: str) -> np.ndarray:
        if name not in gray_cache:
            gray_cache[name] = contain_gray64(by_name[name].path)
        return gray_cache[name]

    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            ra, rb = by_name[names[i]], by_name[names[j]]
            dd = ra.dhash - rb.dhash
            pd = ra.phash - rb.phash
            d_max, p_max = hash_limits(ra, rb)
            clip_sim = None
            if clip_ok and ra.embedding is not None and rb.embedding is not None:
                clip_sim = cosine(ra.embedding, rb.embedding)

            # Near: dual-hash OR (CLIP gray + SSIM). Bare CLIP_HIGH is semantic-only
            # to avoid theme-level false positives in near groups.
            near = False
            match_path = ""
            ssim_v = None

            # OR: imagehash.phash (DCT) and dhash disagree on some true pairs
            # (e.g. Vieta notes: dd=3, pd=18). Either signal ≤ max is enough.
            if dd <= d_max or pd <= p_max:
                near = True
                match_path = (
                    f"dhash<={d_max}"
                    if dd <= d_max
                    else f"phash<={p_max}"
                )
                if dd <= d_max and pd <= p_max:
                    match_path = f"dhash<={d_max}|phash<={p_max}"
            elif clip_sim is not None and clip_sim >= CLIP_GRAY:
                ssim_v = ssim_simple(gray(ra.file), gray(rb.file))
                if ssim_v >= SSIM_MIN:
                    near = True
                    match_path = f"clip>={CLIP_GRAY}+ssim>={SSIM_MIN}"

            if near:
                confirmed.append(
                    PairHit(
                        a=ra.file,
                        b=rb.file,
                        kind="near",
                        match_path=match_path,
                        phash_dist=pd,
                        dhash_dist=dd,
                        clip_sim=clip_sim,
                        ssim=ssim_v,
                    )
                )
                continue

            if clip_sim is not None and clip_sim >= CLIP_HIGH:
                confirmed.append(
                    PairHit(
                        a=ra.file,
                        b=rb.file,
                        kind="semantic",
                        match_path=f"clip>={CLIP_HIGH}",
                        phash_dist=pd,
                        dhash_dist=dd,
                        clip_sim=clip_sim,
                    )
                )
                continue

            if pd <= SUSPECT_PHASH or (clip_sim is not None and clip_sim >= SUSPECT_CLIP):
                suspects.append(
                    PairHit(
                        a=ra.file,
                        b=rb.file,
                        kind="suspect",
                        match_path="suspect",
                        phash_dist=pd,
                        dhash_dist=dd,
                        clip_sim=clip_sim,
                    )
                )

    return confirmed, suspects


def complete_linkage_clusters(
    names: list[str],
    pairs: list[PairHit],
    max_size: int = MAX_GROUP_SIZE,
) -> list[list[str]]:
    """Complete-linkage: merge only if all cross-edges exist in pair set."""
    pair_set = {frozenset((p.a, p.b)) for p in pairs}
    parent = {n: n for n in names}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def members(root: str) -> list[str]:
        return [n for n in names if find(n) == root]

    # Sort pairs by strength (prefer tighter phash / higher clip)
    def strength(p: PairHit) -> tuple:
        pd = p.phash_dist if p.phash_dist is not None else 99
        cs = -(p.clip_sim or 0)
        return (pd, cs)

    for p in sorted(pairs, key=strength):
        ra, rb = find(p.a), find(p.b)
        if ra == rb:
            continue
        ma, mb = members(ra), members(rb)
        if len(ma) + len(mb) > max_size:
            continue
        ok = True
        for x in ma:
            for y in mb:
                if frozenset((x, y)) not in pair_set:
                    ok = False
                    break
            if not ok:
                break
        if not ok:
            continue
        # union
        parent[rb] = ra

    clusters: dict[str, list[str]] = {}
    for n in names:
        r = find(n)
        clusters.setdefault(r, []).append(n)
    return [sorted(v) for v in clusters.values() if len(v) >= 2]


def single_linkage_clusters(
    names: list[str],
    pairs: list[PairHit],
    max_size: int = MAX_GROUP_SIZE,
) -> list[list[str]]:
    parent = {n: n for n in names}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def size(root: str) -> int:
        return sum(1 for n in names if find(n) == root)

    for p in pairs:
        ra, rb = find(p.a), find(p.b)
        if ra == rb:
            continue
        if size(ra) + size(rb) > max_size:
            continue
        parent[rb] = ra

    clusters: dict[str, list[str]] = {}
    for n in names:
        r = find(n)
        clusters.setdefault(r, []).append(n)
    return [sorted(v) for v in clusters.values() if len(v) >= 2]


def pick_keep(files: list[str]) -> str:
    """Prefer filename with later PicGo timestamp prefix."""
    return sorted(files)[-1]


def _num(v):
    if v is None:
        return None
    if isinstance(v, (np.floating, float)):
        return float(v)
    if isinstance(v, (np.integer, int)):
        return int(v)
    return v


def build_group_payload(
    cluster: list[str],
    kind: str,
    gid: str,
    pair_index: dict[frozenset, PairHit],
) -> dict[str, Any]:
    keep = pick_keep(cluster)
    items = []
    paths = set()
    sims = []
    for f in sorted(cluster):
        role = "keep" if f == keep else "dup"
        hit = pair_index.get(frozenset((f, keep))) if f != keep else None
        entry: dict[str, Any] = {
            "file": f,
            "role": role,
            "matchPath": hit.match_path if hit else (kind if role == "keep" else None),
            "phashDist": _num(hit.phash_dist) if hit else None,
            "clipSim": _num(hit.clip_sim) if hit else None,
            "ssim": _num(hit.ssim) if hit else None,
        }
        if hit:
            paths.add(hit.match_path)
            if hit.clip_sim is not None:
                sims.append(float(hit.clip_sim))
        items.append(entry)
    out: dict[str, Any] = {"id": gid, "kind": kind, "items": items, "paths": sorted(paths)}
    if sims:
        out["minSimilarity"] = float(min(sims))
        out["maxSimilarity"] = float(max(sims))
        out["avgSimilarity"] = float(sum(sims) / len(sims))
    return out


def build_index(
    images_dir: Path,
    skip_clip: bool = False,
    device: str = "cpu",
) -> dict[str, Any]:
    paths = list_images(images_dir)
    records = [ImageRecord(file=p.name, path=p) for p in paths]
    for i, rec in enumerate(records, 1):
        try:
            compute_hashes(rec)
        except Exception as e:
            print(f"hash fail {rec.file}: {e}", file=sys.stderr)
        if i % 20 == 0 or i == len(records):
            print(f"hashes {i}/{len(records)}", flush=True)

    clip_status = "skipped"
    clip_error = None
    if not skip_clip and records:
        try:
            print("loading CLIP…", flush=True)
            model, processor, torch = load_clip(device)
            encode_clip(records, model, processor, torch, device=device)
            clip_status = "ok"
            print("CLIP encode done", flush=True)
        except Exception as e:
            clip_status = "failed"
            clip_error = str(e)
            print(f"CLIP failed: {e}", file=sys.stderr)

    clip_ok = clip_status == "ok"
    confirmed, suspects = analyze_pairs(records, clip_ok=clip_ok)

    near_pairs = [p for p in confirmed if p.kind == "near"]
    # semantic pairs that are not also near
    near_edges = {frozenset((p.a, p.b)) for p in near_pairs}
    semantic_pairs = [
        p
        for p in confirmed
        if p.kind == "semantic" and frozenset((p.a, p.b)) not in near_edges
    ]
    # Also promote high CLIP that was classified near via clip path stays near only

    names = [r.file for r in records]
    near_clusters = complete_linkage_clusters(names, near_pairs)
    semantic_clusters = single_linkage_clusters(names, semantic_pairs)

    near_members = {f for c in near_clusters for f in c}
    semantic_clusters = [
        c for c in semantic_clusters if not any(f in near_members for f in c)
    ]

    pair_index: dict[frozenset, PairHit] = {}
    for p in near_pairs + semantic_pairs:
        key = frozenset((p.a, p.b))
        prev = pair_index.get(key)
        if prev is None or (p.clip_sim or 0) > (prev.clip_sim or 0):
            pair_index[key] = p

    groups: list[dict[str, Any]] = []
    for i, c in enumerate(near_clusters, 1):
        groups.append(build_group_payload(c, "near", f"near-{i}", pair_index))
    for i, c in enumerate(semantic_clusters, 1):
        groups.append(build_group_payload(c, "semantic", f"semantic-{i}", pair_index))

    suspect_groups = []
    for i, p in enumerate(suspects[:30], 1):
        suspect_groups.append(
            build_group_payload(
                [p.a, p.b],
                "suspect",
                f"suspect-{i}",
                {frozenset((p.a, p.b)): p},
            )
        )

    return {
        "algoVersion": ALGO_VERSION,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "imageCount": len(records),
        "clipStatus": clip_status,
        "clipModel": CLIP_MODEL_ID if clip_ok else None,
        "clipError": clip_error,
        "groups": groups,
        "suspects": suspect_groups,
        "meta": {
            "nearPairs": len(near_pairs),
            "semanticPairs": len(semantic_pairs),
            "suspectPairs": len(suspects),
            "nearGroups": len(near_clusters),
            "semanticGroups": len(semantic_clusters),
        },
    }


def files_in_same_near_group(index: dict[str, Any], a: str, b: str) -> bool:
    for g in index.get("groups", []):
        if g.get("kind") != "near":
            continue
        names = {it["file"] for it in g.get("items", [])}
        if a in names and b in names:
            return True
    return False


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--images", type=Path, default=Path("images"))
    ap.add_argument("--out", type=Path, default=Path("meta/similar-index.json"))
    ap.add_argument("--skip-clip", action="store_true")
    ap.add_argument("--device", default="cpu")
    args = ap.parse_args(argv)

    if not args.images.is_dir():
        print(f"missing images dir: {args.images}", file=sys.stderr)
        return 1

    index = build_index(args.images, skip_clip=args.skip_clip, device=args.device)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote {args.out} groups={len(index['groups'])} "
        f"clip={index['clipStatus']} images={index['imageCount']}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
