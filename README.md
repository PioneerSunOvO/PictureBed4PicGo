# PictureBed4PicGo

GitHub 图床 · 自动同步 · 重复与相似检测

**管理页：** [https://pioneersunovo.github.io/PictureBed4PicGo/](https://pioneersunovo.github.io/PictureBed4PicGo/)（根路径自动进入 gallery）

PicGo 配置：仓库 `PioneerSunOvO/PictureBed4PicGo`，分支 `master`，路径 `images/`

## 安全与私有目录

| 目录 | 用途 | Markdown |
|------|------|----------|
| `images/` | 公开图床（PicGo 默认） | ✅ jsDelivr / raw 直链 |
| `private/` | 敏感图，仅 Gallery 管理 | ❌ 不提供公开外链 |

- **登录门控：** Gallery 默认需 GitHub 登录后才加载文件列表（`gallery.html` → `SECURITY.requireLogin`）
- **私有代理（C1）：** 部署 Cloudflare Worker 为 `private/` 签发短期签名 URL → [docs/private-proxy-setup.md](docs/private-proxy-setup.md)
- **反爬：** `robots.txt` + `noindex` 元标签

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
