# 私有目录与 C1 代理部署

## 架构

```text
images/          → jsDelivr / raw（Markdown 公开外链，不变）
private/         → 仅 Gallery + Worker 签名 URL
Gallery 列表     → 登录后 GitHub API 拉取
private/ 预览    → Worker /sign + /img（或回退 GitHub API Blob）
```

## 1. 仓库准备

1. 提交 `private/` 目录（已有 `.gitkeep`）
2. 敏感图放入 `private/`，文件名建议带 hash（与 `images/` 相同命名规则）
3. **不要**在 Markdown 中引用 `private/` 路径

## 2. Gallery 配置

编辑 `gallery.html` 中的 `SECURITY`：

```javascript
const SECURITY = {
  requireLogin: true,
  privateProxyBase: 'https://pb4pg-private.你的子域.workers.dev',
  allowedLogins: ['你的GitHub用户名']  // 可选
};
```

- `privateProxyBase` 留空：私有图通过浏览器内 GitHub API 拉 Blob（需登录，无 Worker）
- 填写 Worker URL：推荐生产环境，签名 URL 可给 `<img>` 使用

## 3. 部署 Cloudflare Worker

```bash
cd worker
cp wrangler.toml.example wrangler.toml
# 编辑 wrangler.toml 中的 REPO_OWNER / ALLOWED_ORIGIN / ALLOWED_LOGINS

npm install
npx wrangler secret put PROXY_SECRET    # 随机长字符串
npx wrangler secret put GITHUB_PAT        # 有 repo 读权限的 PAT（仅 Worker 持有）

npm run deploy
```

将部署输出的 URL 填入 `SECURITY.privateProxyBase`。

### Worker 环境变量

| 变量 | 说明 |
|------|------|
| `PROXY_SECRET` | HMAC 签名密钥（secret） |
| `GITHUB_PAT` | 读取 `private/` 的 PAT（secret） |
| `REPO_OWNER` / `REPO_NAME` | 仓库坐标 |
| `ALLOWED_ORIGIN` | CORS 允许的来源（GitHub Pages 域名） |
| `ALLOWED_LOGINS` | 可选，允许签名的 GitHub 用户名 |

### API

**POST /sign**

```http
Authorization: Bearer <用户 GitHub Token>
Content-Type: application/json

{"path":"private/example-hash.webp"}
```

响应：`{ "url": "https://.../img?path=...&exp=...&sig=...", "exp": 1730000000 }`

**GET /img** — 浏览器 `<img>` 直接加载签名 URL，无需 Header。

## 4. 安全说明

| 能力 | 状态 |
|------|------|
| A 列表隐私 | ✅ `requireLogin` |
| B 写入安全 | ✅ 仍依赖 GitHub 权限 + OAuth/PAT |
| C 内容隐私 | ⚠️ `private/` + 代理；Public 仓 Raw 直链理论上仍可猜 URL |
| 反爬 | ✅ `robots.txt` + `noindex` + 登录门控 |

**Public 仓库限制：** `private/` 文件若被猜到完整路径，仍可能通过 `raw.githubusercontent.com` 访问。极高敏感内容请使用 **Private 仓库** 或不要推送到公开仓。

## 5. PicGo

公开图继续上传到 `images/`。私有图需自定义上传路径为 `private/`（或手动 git push）。
