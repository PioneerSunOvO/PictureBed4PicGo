# PictureBed4PicGo

GitHub 图床 · 自动同步 · 重复与相似检测

**管理页：** [https://pioneersunovo.github.io/PictureBed4PicGo/](https://pioneersunovo.github.io/PictureBed4PicGo/)（根路径自动进入 gallery）

PicGo 配置：仓库 `PioneerSunOvO/PictureBed4PicGo`，分支 `master`，路径 `images/`

## 相似检测（纯 GitHub）

浏览器**不再**现场跑 CLIP。流程：

1. 向 `images/` 推送图片（或手动 Run）
2. Actions 工作流 [similar-index](https://github.com/PioneerSunOvO/PictureBed4PicGo/actions/workflows/similar-index.yml) 用 Python 计算 pHash + CLIP
3. 写出并提交 `meta/similar-index.json`
4. Gallery「相似」页只读该 JSON；「刷新索引」重新拉取；「触发重算」跳转 Actions

本地调试：

```bash
pip install -r scripts/requirements-similar.txt
python scripts/build_similar_index.py --skip-clip   # 仅近重复
python scripts/build_similar_index.py               # 含 CLIP（较慢）
cd scripts && pytest test_similar_index.py -v
```
