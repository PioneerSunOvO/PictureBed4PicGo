"""Regression tests for similar index builder."""

from pathlib import Path

import pytest

from build_similar_index import build_index, files_in_same_near_group

ROOT = Path(__file__).resolve().parents[1]
IMAGES = ROOT / "images"

VIETA_A = "20241123141859218-9c310730f38b0a2e2dcd5166d5dc2c61.png"
VIETA_B = "20241119194753146-ae8b0e862a001d1fa47bb18bae58490a.png"


@pytest.mark.skipif(not (IMAGES / VIETA_A).exists(), reason="fixture images missing")
def test_vieta_pair_near_without_clip():
    index = build_index(IMAGES, skip_clip=True)
    assert files_in_same_near_group(index, VIETA_A, VIETA_B), (
        "韦达定理笔记应对应进入同一 near 组 (pHash/dHash)"
    )


@pytest.mark.skipif(not (IMAGES / VIETA_A).exists(), reason="fixture images missing")
def test_index_shape_skip_clip():
    index = build_index(IMAGES, skip_clip=True)
    assert index["algoVersion"] == 1
    assert index["clipStatus"] == "skipped"
    assert index["imageCount"] >= 2
    assert isinstance(index["groups"], list)
