# private/ — 私有图床目录

将**不应出现在 Markdown 公开外链**中的敏感图片放在此目录。

| 对比 | `images/`（公开轨） | `private/`（私有轨） |
|------|---------------------|----------------------|
| Markdown `![]()` | ✅ 可用 jsDelivr / raw | ❌ 不提供公开 CDN 链接 |
| Gallery 列表 | 登录后可见 | 登录后可见（「私有」分类） |
| 直链访问 | 公开可访问 | 需登录 + 代理签名 URL（见 `docs/private-proxy-setup.md`） |

**上传方式：** 手动 git push、PicGo 自定义路径，或 Gallery 替换到 `private/文件名`。

**注意：** 仓库若为 **Public**，知道完整路径的人仍可能通过 GitHub Raw 访问——请使用 hash 文件名，并部署 Cloudflare Worker 代理作为 Gallery 访问层。
