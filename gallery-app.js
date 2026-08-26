/**
 * PictureBed4PicGo — GitHub Pages 图床画廊
 *
 * 单页应用（无构建工具），主要职责：
 * 1. 从 GitHub 仓库同步 images/ 与 private/ 文件列表
 * 2. 网格/列表浏览、灯箱预览、侧栏详情
 * 3. 重复/相似分组审阅（读 meta/similar-index.json）
 * 4. 加密标签持久化（meta/asset-tags.enc.json）
 * 5. Hash 路由：菜单、预览、详情、对比均可分享链接
 *
 * 全局状态集中在文件顶部 let/const；UI 通过 innerHTML 渲染。
 * 写操作需 GitHub PAT（sessionStorage），读公开 images/ 无需登录。
 */
(function (global) {
  'use strict';

  /* ——— 认证 / OAuth（sessionStorage，关标签页即失效） ——— */
  const TOKEN_KEY = 'pb4pg_pat';
  const AUTH_USER_KEY = 'pb4pg_user';
  const AUTH_AVATAR_KEY = 'pb4pg_avatar';
  const SITE_OG_IMAGE = 'https://pioneersunovo.github.io/PictureBed4PicGo/assets/og-image.png';
  const SITE_FAVICON = 'assets/favicon.png';
  const SITE_APPLE_ICON = 'assets/apple-touch-icon.png';
  const OAUTH_STATE_KEY = 'pb4pg_oauth_state';
  const OAUTH_VERIFIER_KEY = 'pb4pg_code_verifier';
  const OAUTH_SECRET_KEY = 'pb4pg_oauth_secret';
  /** 从 PicGo 风格文件名提取 32 位内容 hash，用于重复检测 */
  const HASH_RE = /([a-f0-9]{32})(?:-\d+)?\.[^.]+$/i;

  /**
   * 扩展名 → 媒体大类。决定缩略图样式、灯箱渲染分支、侧栏分类计数。
   * kind === 'other' 时走「不支持内嵌预览」友好提示。
   */
  const EXT_MAP = {
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic', 'heif', 'tif', 'tiff', 'jfif', 'pjpeg'],
    video: ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'ogv', 'wmv', 'flv', '3gp'],
    audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'wma', 'aiff', 'mid', 'midi'],
    document: ['pdf'],
    text: ['txt', 'md', 'markdown', 'json', 'csv', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'tsx', 'jsx', 'vue', 'yaml', 'yml', 'log', 'sql', 'sh', 'bat', 'ps1', 'ini', 'toml', 'env', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp', 'php', 'rb', 'swift', 'kt', 'scss', 'less', 'graphql', 'dockerfile']
  };

  const TYPE_ICONS = {
    image: '🖼', video: '▶', audio: '♫', document: '📄', text: '⌨', other: '📦'
  };

  let ITEMS = [];
  let OLD_MAP = {};
  /** 重命名双向链：手动改名后仍可从旧路径恢复拍摄日期 */
  const RENAME_LINKS = new Map();
  /** 当前筛选结果（普通菜单为 filter() 输出；重复/相似为 flattenSets） */
  let filtered = [];
  /** 当前菜单下勾选的 newRel 集合（切换菜单时会换一套，见 selectionByCat） */
  const selected = new Set();
  /** 按侧栏菜单分别记忆勾选：category -> rel[]，切回菜单时 restore */
  const selectionByCat = new Map();
  let focused = null;
  /** 侧栏详情面板正在展示的文件 */
  let detailItem = null;
  /** 灯箱内 filtered/lbNavPool 的当前索引 */
  let lightboxIdx = -1;
  /** 侧栏当前分类：all | image | vault | dup | similar … */
  let category = 'all';
  let viewMode = 'grid';
  let sortBy = 'date-desc';
  let devicePollAbort = null;
  const hashGroups = new Map();
  let exactSets = [];
  let similarSets = [];
  let suspectSets = [];
  let scanMeta = null;
  let similarIndexRaw = null;
  let similarLoaded = false;
  let similarLoading = false;
  let autoSmartSelected = false;
  /** near | semantic | all — filters precomputed JSON groups */
  let similarMode = 'all';
  const collapsedGroups = new Set();
  let suspectExpanded = false;
  const ASSET_VERSION = 'hashfix';
  /** 公开图床根路径（PicGo 默认）；Markdown 外链指向此目录 */
  const PUBLIC_PREFIX = 'images/';
  /** 私有目录；列表需登录，预览走 blob 或可选 Worker 代理 */
  const PRIVATE_PREFIX = 'private/';
  /** 加密标签密文文件路径（仓库内无明文标签） */
  const TAGS_META_PATH = 'meta/asset-tags.enc.json';
  /** 标签口令仅存 sessionStorage，关页即失；不写入 GitHub */
  const TAGS_PASS_SESSION_KEY = 'pb4pg_tags_pass';
  /** PBKDF2 迭代次数，与 meta 文件内 iter 字段一致 */
  const TAGS_PBKDF2_ITER = 600000;
  /** Hash 路由允许的菜单段 */
  const ROUTE_CATS = new Set(['all', 'image', 'video', 'audio', 'document', 'text', 'other', 'vault', 'dup', 'similar']);
  /** 为 true 时禁止 syncAppRoute，避免 applyRouteFromHash 与 UI 互相触发死循环 */
  let routeQuiet = false;
  /** init 完成且 ITEMS 已加载后才写入地址栏 hash */
  let routeReady = false;
  const ACTIONS_SIMILAR_URL =
    'https://github.com/PioneerSunOvO/PictureBed4PicGo/actions/workflows/similar-index.yml';
  /** Latest master commit — pin CDN/Raw URLs to avoid @master cache lag. */
  let repoHeadCommit = null;
  /** 私有文件 blob URL 缓存，避免重复拉 GitHub API */
  const privateUrlCache = new Map();
  /** 解锁后内存中的标签：entryId(SHA256) -> string[] */
  let tagsById = new Map();
  /** 从仓库加载的整包密文 JSON 结构 */
  let tagsEnvelope = null;
  let tagsFileSha = null;
  /** 由口令 + salt 派生的 AES-GCM 密钥，仅内存持有 */
  let tagsCryptoKey = null;
  let tagsSalt = null;
  let tagsUnlocked = false;
  let tagsBusy = false;

  function securityCfg() { return global.SECURITY || {}; }
  function requireGalleryLogin() { return securityCfg().requireLogin !== false; }
  function isPrivateRel(rel) { return !!rel && rel.startsWith(PRIVATE_PREFIX); }
  function relPrefix(rel) { return isPrivateRel(rel) ? PRIVATE_PREFIX : PUBLIC_PREFIX; }

  /* ========================================================================
   * Hash 路由（GitHub Pages 静态站，用 location.hash 实现可分享深链）
   *
   * 路径形态：
   *   #/vault                          — 私有菜单
   *   #/image?q=cat&sort=name-asc      — 搜索/排序/视图
   *   #/all/preview/images/foo.jpg     — 灯箱预览
   *   #/all/preview/private/x.jpg?fs=1&info=1 — 全屏 + 详情抽屉
   *   #/all/detail/images/foo.md       — 侧栏详情
   *   #/similar/compare?l=...&r=...    — 左右对比
   *
   * syncAppRoute('push') 进历史栈；'replace' 仅修正 URL 不增加后退步数。
   * ======================================================================== */

  /** 将仓库相对路径编码进 hash 段（逐段 encodeURIComponent） */
  function encodeRelPath(rel) {
    return String(rel || '').split('/').map(encodeURIComponent).join('/');
  }

  function decodeRelPath(parts) {
    return (parts || []).map(p => {
      try { return decodeURIComponent(p); } catch (_) { return p; }
    }).join('/');
  }

  /** 从 DOM 读取应写入 hash 查询串的 UI 状态 */
  function readRouteQuery() {
    const qEl = document.getElementById('q');
    return {
      q: qEl ? String(qEl.value || '').trim() : '',
      sort: sortBy || 'date-desc',
      view: viewMode || 'grid',
      sim: similarMode || 'all'
    };
  }

  /** 根据当前 category、灯箱/详情状态、筛选条件生成完整 hash */
  function buildAppHash() {
    const rq = readRouteQuery();
    const params = new URLSearchParams();
    if (rq.q) params.set('q', rq.q);
    if (rq.sort && rq.sort !== 'date-desc') params.set('sort', rq.sort);
    if (rq.view && rq.view !== 'grid') params.set('view', rq.view);
    if (category === 'similar' && rq.sim && rq.sim !== 'all') params.set('sim', rq.sim);

    let path = '/' + (ROUTE_CATS.has(category) ? category : 'all');
    const lb = document.getElementById('lightbox');
    const lbOpen = !!(lb && lb.classList.contains('open'));

    if (lbOpen && lbMode === 'compare' && lbCompareLeft && lbCompareRight) {
      path += '/compare';
      params.set('l', lbCompareLeft.newRel);
      params.set('r', lbCompareRight.newRel);
    } else if (lbOpen) {
      const item = (typeof lightboxNavList === 'function' ? lightboxNavList()[lightboxIdx] : null) ||
        (typeof currentLightboxItem === 'function' ? currentLightboxItem() : null);
      if (item && item.newRel) {
        path += '/preview/' + encodeRelPath(item.newRel);
        if (lbFullscreen) params.set('fs', '1');
        if (lbInfoOpen) params.set('info', '1');
      }
    } else if (detailItem && detailItem.newRel) {
      path += '/detail/' + encodeRelPath(detailItem.newRel);
    }

    const qs = params.toString();
    return '#' + path + (qs ? '?' + qs : '');
  }

  /** 解析 location.hash 为结构化路由对象 */
  function parseAppHash() {
    let raw = String(location.hash || '').replace(/^#/, '');
    if (!raw) {
      return { category: 'all', mode: 'list', rel: '', left: '', right: '', q: '', sort: '', view: '', sim: '', fs: false, info: false };
    }
    const qi = raw.indexOf('?');
    const pathRaw = (qi >= 0 ? raw.slice(0, qi) : raw).replace(/^\/+|\/+$/g, '');
    const qs = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
    const parts = pathRaw ? pathRaw.split('/').filter(Boolean) : [];
    let cat = 'all';
    let i = 0;
    if (parts[0] && ROUTE_CATS.has(parts[0])) {
      cat = parts[0];
      i = 1;
    }
    let mode = 'list';
    let rel = '';
    if (parts[i] === 'preview' || parts[i] === 'detail') {
      mode = parts[i];
      rel = decodeRelPath(parts.slice(i + 1));
    } else if (parts[i] === 'compare') {
      mode = 'compare';
    }
    return {
      category: cat,
      mode,
      rel,
      left: qs.get('l') || '',
      right: qs.get('r') || '',
      q: qs.get('q') || '',
      sort: qs.get('sort') || '',
      view: qs.get('view') || '',
      sim: qs.get('sim') || '',
      fs: qs.get('fs') === '1',
      info: qs.get('info') === '1'
    };
  }

  /** 将 buildAppHash() 结果写入地址栏；push 用 location.hash 保证地址栏可见更新 */
  function syncAppRoute(mode) {
    if (routeQuiet || !routeReady) return;
    const hash = buildAppHash();
    const body = hash.replace(/^#/, '');
    const cur = (location.hash || '').replace(/^#/, '');
    if (body === cur) return;
    routeQuiet = true;
    try {
      const url = location.pathname + location.search + hash;
      if (mode === 'push') {
        location.hash = body;
      } else {
        history.replaceState({ gallery: 1 }, '', url);
        if ((location.hash || '').replace(/^#/, '') !== body) location.replace(url);
      }
    } finally {
      routeQuiet = false;
    }
  }

  function setNavActive(cat) {
    document.querySelectorAll('.nav-item[data-cat]').forEach(b => {
      b.classList.toggle('active', b.dataset.cat === cat);
    });
  }

  function setViewModeUI(mode) {
    viewMode = mode === 'list' ? 'list' : 'grid';
    const g = document.getElementById('viewGrid');
    const l = document.getElementById('viewList');
    if (g) g.classList.toggle('active', viewMode === 'grid');
    if (l) l.classList.toggle('active', viewMode === 'list');
  }

  /**
   * 从 URL 恢复 UI（前进/后退、粘贴链接打开、init 收尾）。
   * 切换 category 时同步做勾选快照/恢复，与 switchCategory 行为一致。
   */
  async function applyRouteFromHash() {
    const parsed = parseAppHash();
    routeQuiet = true;
    try {
      if (parsed.category && parsed.category !== category) {
        snapshotSelectionForCategory(category);
        autoSmartSelected = false;
        category = parsed.category;
        restoreSelectionForCategory(category);
      } else if (parsed.category) {
        category = parsed.category;
      }
      setNavActive(category);

      const qEl = document.getElementById('q');
      if (qEl) qEl.value = parsed.q || '';

      if (parsed.sort) {
        sortBy = parsed.sort;
        const sortEl = document.getElementById('sort');
        if (sortEl) sortEl.value = sortBy;
      }
      if (parsed.view) setViewModeUI(parsed.view);
      if (parsed.sim) similarMode = parsed.sim;

      await filter();

      const wantPreview = parsed.mode === 'preview' && parsed.rel;
      const wantDetail = parsed.mode === 'detail' && parsed.rel;
      const wantCompare = parsed.mode === 'compare' && parsed.left && parsed.right;
      const lb = document.getElementById('lightbox');
      const lbOpen = !!(lb && lb.classList.contains('open'));

      if (wantCompare) {
        const left = itemByRel(parsed.left);
        const right = itemByRel(parsed.right);
        if (left && right) openCompare(left, right, [left, right]);
        else if (lbOpen) closeLightbox({ sync: false });
      } else if (wantPreview) {
        const item = itemByRel(parsed.rel);
        if (item) {
          openLightbox(item, parsed.fs);
          if (parsed.info) await openLbInfo(item);
          else closeLbInfo({ sync: false });
        } else if (lbOpen) closeLightbox({ sync: false });
      } else if (wantDetail) {
        if (lbOpen) closeLightbox({ sync: false });
        const item = itemByRel(parsed.rel);
        if (item) await openDetail(item);
        else closeDetail({ sync: false });
      } else {
        if (lbOpen) closeLightbox({ sync: false });
        if (detailItem) closeDetail({ sync: false });
      }
    } finally {
      routeQuiet = false;
    }
    syncAppRoute('replace');
  }

  /* ——— 按菜单隔离勾选：私有里选的图切到「图片」会清空，回到「私有」再恢复 ——— */

  /** 离开菜单前把当前 selected 存入 selectionByCat */
  function snapshotSelectionForCategory(cat) {
    if (!cat) return;
    selectionByCat.set(cat, [...selected]);
  }

  /** 进入菜单时从 selectionByCat 恢复；已删除的 rel 自动忽略 */
  function restoreSelectionForCategory(cat) {
    selected.clear();
    const saved = selectionByCat.get(cat);
    if (!saved || !saved.length) return;
    const valid = new Set(ITEMS.map(i => i.newRel));
    saved.forEach(rel => {
      if (valid.has(rel)) selected.add(rel);
    });
  }

  /** 登出或全量同步后清空所有菜单的勾选记忆 */
  function clearAllSelections() {
    selected.clear();
    selectionByCat.clear();
  }

  /** 删除文件时从 selected 与各菜单快照中移除该 rel */
  function pruneSelectionMemory(rel) {
    if (!rel) return;
    selected.delete(rel);
    selectionByCat.forEach((list, cat) => {
      const next = list.filter(r => r !== rel);
      if (next.length) selectionByCat.set(cat, next);
      else selectionByCat.delete(cat);
    });
  }

  /** 重命名后把各菜单快照里的 oldRel 替换为 newRel */
  function migrateSelectionRel(oldRel, newRel) {
    if (!oldRel || !newRel || oldRel === newRel) return;
    if (selected.has(oldRel)) {
      selected.delete(oldRel);
      selected.add(newRel);
    }
    selectionByCat.forEach((list, cat) => {
      selectionByCat.set(cat, list.map(r => (r === oldRel ? newRel : r)));
    });
  }

  /** 侧栏菜单切换：快照旧菜单勾选 → 恢复新菜单勾选 → 关闭灯箱/详情 → 刷新列表 */
  function switchCategory(next, routeMode) {
    if (!next || !ROUTE_CATS.has(next)) return;
    if (next === category) {
      void filter().then(() => syncAppRoute(routeMode || 'replace'));
      return;
    }
    snapshotSelectionForCategory(category);
    autoSmartSelected = false;
    category = next;
    restoreSelectionForCategory(category);
    setNavActive(category);
    routeQuiet = true;
    try {
      const lb = document.getElementById('lightbox');
      if (lb && lb.classList.contains('open')) closeLightbox({ sync: false });
      if (detailItem) closeDetail({ sync: false });
    } finally {
      routeQuiet = false;
    }
    void filter().then(() => syncAppRoute(routeMode || 'push'));
  }

  function clearPrivateUrlCache() {
    privateUrlCache.forEach(entry => {
      if (entry.revoke) URL.revokeObjectURL(entry.url);
    });
    privateUrlCache.clear();
  }

  function metaContentType(name) {
    const ext = extOf(name);
    const map = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
      avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', pdf: 'application/pdf'
    };
    return map[ext] || 'application/octet-stream';
  }

  async function verifyGalleryAccess() {
    const allowed = securityCfg().allowedLogins;
    if (!Array.isArray(allowed) || !allowed.length) return true;
    const login = sessionStorage.getItem(AUTH_USER_KEY);
    return !!login && allowed.includes(login);
  }

  function updateLoginGate() {
    const gate = document.getElementById('loginGate');
    const shell = document.getElementById('appShell');
    const need = requireGalleryLogin() && !token();
    if (gate) gate.classList.toggle('hidden', !need);
    if (shell) shell.classList.toggle('gated', need);
  }

  function renderLoginGate() {
    const container = document.getElementById('mediaContainer');
    if (!container) return;
    container.innerHTML =
      '<div class="login-gate-panel">' +
      '<div class="login-gate-icon">🔒</div>' +
      '<h2>登录后查看图库</h2>' +
      '<p>为保护隐私，文件列表与相似索引仅对已授权 GitHub 账号开放。<br>公开 Markdown 中的 <code>images/</code> 外链不受影响。</p>' +
      '<p class="login-gate-hint">请在左侧使用 <strong>GitHub 登录</strong>。</p>' +
      '</div>';
    const stats = document.getElementById('stats');
    if (stats) stats.textContent = '';
  }

  /* ——— 灯箱 / 对比模式状态 ——— */
  let lbMode = 'single'; // 'single' 单图预览 | 'compare' 左右对比
  let lbFullscreen = false;
  /** 灯箱内右侧深色详情抽屉是否展开 */
  let lbInfoOpen = false;
  let lbCompareLeft = null;
  let lbCompareRight = null;
  /** 对比模式下除左侧保留项外的候选项列表 */
  let lbComparePool = [];
  /**
   * 灯箱 ←/→ 导航范围。非 null 时只在组内切换（如相似/重复同组），
   * 否则在 filtered 全列表循环。
   */
  let lbNavPool = null;
  /** 图片缩放控制器实例，关闭灯箱时 destroyLbZoom 统一销毁 */
  let lbZoomControllers = [];

  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
  }

  /** 根据扩展名返回 image | video | audio | document | pdf | text | other */
  function fileKind(name) {
    const ext = extOf(name);
    for (const [kind, exts] of Object.entries(EXT_MAP)) {
      if (exts.includes(ext)) return kind;
    }
    return 'other';
  }

  /** 是否允许进入灯箱：当前所有类型均可打开，不支持的走友好降级 UI */
  function canLightboxPreview(item) {
    return !!item;
  }

  function supportsLbFullscreen(item) {
    if (!item) return false;
    return item.kind === 'image' || item.kind === 'video' ||
      (item.kind === 'document' && item.ext === 'pdf');
  }

  /**
   * 文本预览拉取 URL：私有 blob 优先；否则用 shareUrlOf（CDN/Raw）以便 fetch 读内容
   */
  function textFetchUrl(item, previewUrl) {
    if (previewUrl && previewUrl.startsWith('blob:')) return previewUrl;
    const share = shareUrlOf(item);
    return share || previewUrl;
  }

  /** Lightweight Markdown → HTML for gallery preview (no external deps). */
  function renderSimpleMarkdown(src) {
    const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let inCode = false;
    let codeBuf = [];
    let inList = false;

    function closeList() {
      if (inList) { out.push('</ul>'); inList = false; }
    }

    function inlineFormat(s) {
      return escapeHtml(s)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^```/.test(line)) {
        if (inCode) {
          out.push('<pre class="md-code"><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
          codeBuf = [];
          inCode = false;
        } else {
          closeList();
          inCode = true;
        }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }

      if (/^\s*[-*+]\s+/.test(line)) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + inlineFormat(line.replace(/^\s*[-*+]\s+/, '')) + '</li>');
        continue;
      }
      closeList();

      if (/^###\s+/.test(line)) out.push('<h3>' + inlineFormat(line.slice(4)) + '</h3>');
      else if (/^##\s+/.test(line)) out.push('<h2>' + inlineFormat(line.slice(3)) + '</h2>');
      else if (/^#\s+/.test(line)) out.push('<h1>' + inlineFormat(line.slice(2)) + '</h1>');
      else if (/^>\s?/.test(line)) out.push('<blockquote>' + inlineFormat(line.replace(/^>\s?/, '')) + '</blockquote>');
      else if (/^---+$/.test(line.trim())) out.push('<hr>');
      else if (!line.trim()) out.push('<br>');
      else out.push('<p>' + inlineFormat(line) + '</p>');
    }
    if (inCode) out.push('<pre class="md-code"><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
    closeList();
    return out.join('');
  }

  /* ========================================================================
   * 加密标签子系统（Web Crypto API，零后端）
   *
   * 仓库文件 meta/asset-tags.enc.json 结构：
   *   { v, alg, kdf, iter, salt, entries: { [entryId]: { iv, data } } }
   *
   * entryId = SHA256('pb4pg-tag:' + newRel)，不暴露原始路径明文。
   * 每条 entry 的 data 为 AES-256-GCM 密文（含认证标签），明文 JSON: { t: ['标签1',…] }。
   *
   * 口令 → PBKDF2-SHA256(salt, 600000 次) → AES 密钥。
   * 口令仅存 sessionStorage（pb4pg_tags_pass），换浏览器需重新输入同一口令。
   * 写操作需 GitHub PAT，通过 putFileViaGit 提交密文。
   * ======================================================================== */

  function b64FromBytes(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function bytesFromB64(b64) {
    const binary = atob(String(b64 || '').replace(/\s/g, ''));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text || '')));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /** 文件在密文包中的稳定键：SHA256('pb4pg-tag:' + rel) */
  async function tagEntryIdForRel(rel) {
    return sha256Hex('pb4pg-tag:' + String(rel || ''));
  }

  /** 从用户口令派生 AES-256-GCM 密钥（PBKDF2） */
  async function deriveTagsKey(passphrase, saltBytes, iterations) {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: iterations || TAGS_PBKDF2_ITER, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptTagPayload(tagsArr, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify({ t: tagsArr }));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, plain);
    return { iv: b64FromBytes(iv), data: b64FromBytes(new Uint8Array(ct)) };
  }

  async function decryptTagPayload(entry, key) {
    const iv = bytesFromB64(entry.iv);
    const data = bytesFromB64(entry.data);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, data);
    const obj = JSON.parse(new TextDecoder().decode(plain));
    const tags = Array.isArray(obj.t) ? obj.t : (Array.isArray(obj) ? obj : []);
    return tags.map(t => String(t).trim()).filter(Boolean);
  }

  function normalizeTagList(list) {
    const seen = new Set();
    const out = [];
    (list || []).forEach(raw => {
      const t = String(raw || '').trim().slice(0, 48);
      if (!t) return;
      const key = t.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(t);
    });
    return out;
  }

  function getSessionTagPass() {
    try { return sessionStorage.getItem(TAGS_PASS_SESSION_KEY) || ''; } catch (_) { return ''; }
  }

  function setSessionTagPass(pass) {
    try {
      if (pass) sessionStorage.setItem(TAGS_PASS_SESSION_KEY, pass);
      else sessionStorage.removeItem(TAGS_PASS_SESSION_KEY);
    } catch (_) { /* ignore */ }
  }

  function hasEncryptedTagEntry(rel) {
    if (!tagsEnvelope || !tagsEnvelope.entries || !rel) return false;
    const id = tagIdCache.get(rel);
    return !!(id && tagsEnvelope.entries[id]);
  }

  const tagIdCache = new Map();

  async function ensureTagIds(items) {
    const list = items || ITEMS;
    await Promise.all(list.map(async item => {
      if (!item || !item.newRel) return;
      if (tagIdCache.has(item.newRel)) {
        item._tagId = tagIdCache.get(item.newRel);
        return;
      }
      const id = await tagEntryIdForRel(item.newRel);
      tagIdCache.set(item.newRel, id);
      item._tagId = id;
    }));
  }

  function tagsBadgeHtmlSync(item) {
    if (!item) return '';
    const id = item._tagId || tagIdCache.get(item.newRel);
    if (!id) return '';
    if (tagsUnlocked) return itemTagsChipHtml(tagsById.get(id) || []);
    if (tagsEnvelope && tagsEnvelope.entries && tagsEnvelope.entries[id]) {
      return itemTagsChipHtml(null, true);
    }
    return '';
  }

  async function tagsForItem(item) {
    if (!item || !tagsUnlocked) return [];
    const id = item._tagId || await tagEntryIdForRel(item.newRel);
    item._tagId = id;
    return tagsById.get(id) || [];
  }

  function updateTagsUnlockUI() {
    /* 标签入口在卡片右上角，不再使用顶部工具栏 */
  }

  let tagPopoverItem = null;

  /** 从 GitHub 拉取 meta/asset-tags.enc.json；若 session 有口令则尝试自动解锁 */
  async function loadTagsEnvelope() {
    tagsEnvelope = null;
    tagsFileSha = null;
    tagsById = new Map();
    tagsUnlocked = false;
    tagsCryptoKey = null;
    tagsSalt = null;
    try {
      const meta = await ghFetch('/contents/' + encodePath(TAGS_META_PATH) + '?ref=' + REPO.branch + '&_=' + Date.now());
      if (meta && meta.content) {
        tagsFileSha = meta.sha;
        const text = atob(meta.content.replace(/\s/g, ''));
        tagsEnvelope = JSON.parse(text);
      }
    } catch (_) {
      tagsEnvelope = { v: 1, alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iter: TAGS_PBKDF2_ITER, salt: '', entries: {} };
    }
    if (!tagsEnvelope || typeof tagsEnvelope !== 'object') {
      tagsEnvelope = { v: 1, alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iter: TAGS_PBKDF2_ITER, salt: '', entries: {} };
    }
    if (!tagsEnvelope.entries) tagsEnvelope.entries = {};
    updateTagsUnlockUI();
    const saved = getSessionTagPass();
    if (saved) {
      try { await unlockTags(saved, true); } catch (_) { setSessionTagPass(''); }
    }
  }

  /**
   * 用口令解密全部 entries 到内存 tagsById。
   * 首次使用（entries 为空）会生成新 salt 并初始化 envelope 骨架。
   */
  async function unlockTags(passphrase, silent) {
    const pass = String(passphrase || '').trim();
    if (pass.length < 6) throw new Error('标签口令至少 6 位');
    let saltBytes;
    let iter = TAGS_PBKDF2_ITER;
    const entries = (tagsEnvelope && tagsEnvelope.entries) || {};
    const hasEntries = Object.keys(entries).length > 0;
    if (hasEntries) {
      if (!tagsEnvelope.salt) throw new Error('标签密文缺少 salt');
      saltBytes = bytesFromB64(tagsEnvelope.salt);
      iter = tagsEnvelope.iter || TAGS_PBKDF2_ITER;
    } else {
      saltBytes = crypto.getRandomValues(new Uint8Array(16));
    }
    const key = await deriveTagsKey(pass, saltBytes, iter);
    const nextMap = new Map();
    if (hasEntries) {
      const ids = Object.keys(entries);
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        try {
          const tags = await decryptTagPayload(entries[id], key);
          nextMap.set(id, normalizeTagList(tags));
        } catch (e) {
          throw new Error('口令错误或密文已损坏');
        }
      }
    }
    tagsCryptoKey = key;
    tagsSalt = saltBytes;
    tagsById = nextMap;
    tagsUnlocked = true;
    if (!hasEntries) {
      tagsEnvelope = {
        v: 1,
        alg: 'AES-256-GCM',
        kdf: 'PBKDF2-SHA256',
        iter: TAGS_PBKDF2_ITER,
        salt: b64FromBytes(saltBytes),
        entries: {}
      };
    }
    setSessionTagPass(pass);
    updateTagsUnlockUI();
    if (!silent) setStatus('标签已解锁', 'ok');
    void filter();
    if (detailItem) void openDetail(detailItem);
    if (lbInfoOpen) void syncLbInfoIfOpen();
  }

  function lockTags() {
    tagsUnlocked = false;
    tagsCryptoKey = null;
    tagsById = new Map();
    setSessionTagPass('');
    updateTagsUnlockUI();
    void filter();
    if (detailItem) void openDetail(detailItem);
    if (lbInfoOpen) void syncLbInfoIfOpen();
    setStatus('标签已锁定', 'ok');
  }

  /** 将 tagsById 全量重新加密后写入仓库（Git Data API） */
  async function persistTagsEnvelope() {
    if (!token()) throw new Error('请先登录 GitHub');
    if (!tagsUnlocked || !tagsCryptoKey || !tagsSalt) throw new Error('请先解锁标签');
    const entries = {};
    const ids = [...tagsById.keys()];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const list = normalizeTagList(tagsById.get(id));
      if (!list.length) continue;
      entries[id] = await encryptTagPayload(list, tagsCryptoKey);
    }
    const envelope = {
      v: 1,
      alg: 'AES-256-GCM',
      kdf: 'PBKDF2-SHA256',
      iter: tagsEnvelope && tagsEnvelope.iter ? tagsEnvelope.iter : TAGS_PBKDF2_ITER,
      salt: b64FromBytes(tagsSalt),
      entries
    };
    const json = JSON.stringify(envelope, null, 2);
    const contentBase64 = b64FromBytes(new TextEncoder().encode(json));
    const result = await putFileViaGit(TAGS_META_PATH, contentBase64, 'gallery: update encrypted asset tags');
    tagsEnvelope = envelope;
    tagsFileSha = result && result.content ? result.content.sha : tagsFileSha;
    if (result && result.commitSha) bumpRepoHead(result.commitSha);
    updateTagsUnlockUI();
  }

  /** 更新某文件的标签列表并持久化；tagsArr 为空则删除该 entry */
  async function setItemTags(item, tagsArr) {
    if (!item) return;
    if (!tagsUnlocked || !tagsCryptoKey) throw new Error('请先解锁标签口令');
    const id = item._tagId || await tagEntryIdForRel(item.newRel);
    item._tagId = id;
    const list = normalizeTagList(tagsArr);
    if (list.length) tagsById.set(id, list);
    else tagsById.delete(id);
    tagsBusy = true;
    try {
      await persistTagsEnvelope();
      setStatus('标签已加密保存到仓库', 'ok');
    } finally {
      tagsBusy = false;
    }
    void filter();
    if (detailItem && detailItem.newRel === item.newRel) void openDetail(item);
    if (lbInfoOpen) void syncLbInfoIfOpen();
    if (tagPopoverItem && tagPopoverItem.newRel === item.newRel) void refreshTagPopover();
  }

  /** 重命名文件时迁移密文 entry 键（oldId → newId） */
  async function migrateItemTags(oldRel, newRel) {
    if (!tagsUnlocked || !oldRel || !newRel || oldRel === newRel) return;
    const oldId = await tagEntryIdForRel(oldRel);
    const newId = await tagEntryIdForRel(newRel);
    if (!tagsById.has(oldId)) return;
    tagsById.set(newId, tagsById.get(oldId));
    tagsById.delete(oldId);
    await persistTagsEnvelope();
  }

  function itemTagsChipHtml(tags, lockedHint) {
    if (lockedHint) {
      return '<span class="tag-chip tag-locked" title="已加密，解锁后可见">🔒</span>';
    }
    if (!tags || !tags.length) return '';
    return tags.slice(0, 4).map(t =>
      '<span class="tag-chip" title="' + escapeAttr(t) + '">' + escapeHtml(t) + '</span>'
    ).join('') + (tags.length > 4 ? '<span class="tag-chip tag-more">+' + (tags.length - 4) + '</span>' : '');
  }

  /** 详情/灯箱底部标签编辑区 HTML；未解锁时显示「解锁口令」按钮 */
  function buildTagEditorHtml(item, tags) {
    if (!token()) {
      return '<div class="tag-editor muted">登录后可管理加密标签</div>';
    }
    if (!tagsUnlocked) {
      return '<div class="tag-editor">' +
        '<div class="tag-editor-title">标签（AES-256-GCM 加密）</div>' +
        '<p class="tag-editor-hint">标签口令未解锁。仓库内仅存密文，解锁后可查看与编辑。</p>' +
        '<button type="button" class="primary" data-tag-action="unlock">解锁 / 设置口令</button>' +
        '</div>';
    }
    const chips = (tags || []).map(t =>
      '<span class="tag-chip editable" data-tag="' + escapeAttr(t) + '">' +
      escapeHtml(t) + '<button type="button" data-tag-remove="' + escapeAttr(t) + '" aria-label="移除">×</button></span>'
    ).join('');
    return '<div class="tag-editor" data-tag-rel="' + escapeAttr(item.newRel) + '">' +
      '<div class="tag-editor-title">标签（已加密持久化）</div>' +
      '<div class="tag-chip-row" id="tagChipRow">' + (chips || '<span class="tag-empty">暂无标签</span>') + '</div>' +
      '<div class="tag-add-row">' +
      '<input type="text" id="tagInput" maxlength="48" placeholder="输入标签后回车">' +
      '<button type="button" class="primary" data-tag-action="add">添加</button>' +
      '</div>' +
      '<p class="tag-editor-hint">口令仅存于本会话；密文提交到 meta/asset-tags.enc.json</p>' +
      '</div>';
  }

  async function promptUnlockTags() {
    const has = tagsEnvelope && tagsEnvelope.entries && Object.keys(tagsEnvelope.entries).length;
    const msg = has
      ? '输入标签口令以解密（AES-256-GCM）'
      : '设置新的标签口令（至少 6 位，用于加密仓库内标签密文）';
    const pass = prompt(msg, '');
    if (pass == null) return;
    try {
      await unlockTags(pass, false);
    } catch (e) {
      setStatus(e.message || String(e), 'err');
    }
  }

  async function handleTagEditorEvent(e, item) {
    if (!item) return;
    const unlockBtn = e.target.closest('[data-tag-action="unlock"]');
    if (unlockBtn) {
      e.preventDefault();
      await promptUnlockTags();
      if (tagsUnlocked) {
        void filter();
        if (tagPopoverItem) await refreshTagPopover();
      }
      return;
    }
    const removeBtn = e.target.closest('[data-tag-remove]');
    if (removeBtn) {
      e.preventDefault();
      const name = removeBtn.getAttribute('data-tag-remove');
      const cur = await tagsForItem(item);
      await setItemTags(item, cur.filter(t => t !== name));
      return;
    }
    const addBtn = e.target.closest('[data-tag-action="add"]');
    const root = e.target.closest('.tag-editor');
    const input = root ? root.querySelector('input[type="text"]') : null;
    if (addBtn || (e.type === 'keydown' && e.key === 'Enter' && e.target && e.target.matches('.tag-editor input[type="text"]'))) {
      e.preventDefault();
      const val = input ? input.value : '';
      if (!String(val).trim()) return;
      const cur = await tagsForItem(item);
      await setItemTags(item, cur.concat([val]));
      if (input) input.value = '';
      return;
    }
  }

  function validDate(y, mo, d, h, mi, s) {
    if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, mo - 1, d, h || 0, mi || 0, s || 0);
    if (isNaN(dt.getTime())) return null;
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt;
  }

  /**
   * Supported date patterns (priority):
   * 1. PicGo 紧凑时间戳 YYYYMMDDHHmmss[SSS]
   * 2. 分隔日期时间 2026-08-12_02:13:56 / 2026年8月12日
   * 3. 手机命名 IMG_/PXL_/Screenshot_…
   * 4. 紧凑日期 YYYYMMDD
   * 5. Unix 秒/毫秒时间戳
   * Fallback sources: 当前文件名 → 旧路径 → rename-mapping 关联名 → Git 提交时间
   */
  function githubAvatarUrl(login, size) {
    const name = login || REPO.owner;
    return 'https://github.com/' + encodeURIComponent(name) + '.png?size=' + (size || 96);
  }

  function sizedAvatar(avatarUrl, login, size) {
    if (avatarUrl && avatarUrl.includes('avatars.githubusercontent.com')) {
      const sep = avatarUrl.includes('?') ? '&' : '?';
      return avatarUrl + sep + 's=' + size;
    }
    if (avatarUrl) return avatarUrl;
    return githubAvatarUrl(login, size);
  }

  function updateSiteBranding(avatarUrl, login) {
    const useRemote = !!(avatarUrl && avatarUrl.includes('avatars.githubusercontent.com'));
    const url32 = useRemote ? sizedAvatar(avatarUrl, login, 32) : SITE_FAVICON;
    const url64 = useRemote ? sizedAvatar(avatarUrl, login, 64) : SITE_APPLE_ICON;
    const url180 = useRemote ? sizedAvatar(avatarUrl, login, 180) : SITE_APPLE_ICON;
    const fav = document.getElementById('siteFavicon');
    const apple = document.getElementById('appleTouchIcon');
    const og = document.getElementById('ogImage');
    const tw = document.getElementById('twitterImage');
    const brand = document.getElementById('brandAvatar');
    const authAv = document.getElementById('authAvatar');
    if (fav) fav.href = url32;
    if (apple) apple.href = url180;
    if (og) og.content = SITE_OG_IMAGE;
    if (tw) tw.content = SITE_OG_IMAGE;
    if (brand) brand.src = url64;
    if (authAv) authAv.src = url64;
  }

  async function refreshUserProfile() {
    const t = token();
    if (!t) return;
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: 'Bearer ' + t, Accept: 'application/vnd.github+json' }
      });
      if (!res.ok) return;
      const u = await res.json();
      if (u.login) sessionStorage.setItem(AUTH_USER_KEY, u.login);
      if (u.avatar_url) sessionStorage.setItem(AUTH_AVATAR_KEY, u.avatar_url);
      updateSiteBranding(u.avatar_url, u.login);
    } catch (_) { /* ignore */ }
  }

  const DATE_PARSERS = [
    {
      name: 'PicGo 紧凑时间戳',
      re: /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\d{0,3}(?!\d)/,
      pick: m => validDate(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6])
    },
    {
      name: '分隔日期时间',
      re: /(\d{4})[-_./年](\d{1,2})[-_./月](\d{1,2})日?(?:[Tt\s_-]+(\d{1,2})[:._-](\d{1,2})(?:[:._-](\d{1,2}))?)?/,
      pick: m => validDate(+m[1], +m[2], +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0)
    },
    {
      name: '手机命名',
      re: /(?:IMG|PXL|VID|DSC|Screenshot|WX|MMEXPORT)[-_]?(\d{4})(\d{2})(\d{2})[-_]?(?:(\d{2})(\d{2})(\d{2}))?/i,
      pick: m => validDate(+m[1], +m[2], +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0)
    },
    {
      name: '紧凑日期',
      re: /(?:^|[^\d])(\d{4})(\d{2})(\d{2})(?:[^\d]|$)/,
      pick: m => validDate(+m[1], +m[2], +m[3])
    },
    {
      name: 'Unix 时间戳',
      re: /(?:^|[^\d])(1\d{9}|1\d{12})(?:[^\d]|$)/,
      pick: m => {
        const raw = m[1];
        const ms = raw.length > 10 ? +raw : +raw * 1000;
        const dt = new Date(ms);
        return dt.getFullYear() >= 1990 && dt.getFullYear() <= 2100 ? dt : null;
      }
    }
  ];

  function parseDateFromString(str, sourceLabel) {
    const s = String(str || '');
    if (!s) return null;
    for (let i = 0; i < DATE_PARSERS.length; i++) {
      const p = DATE_PARSERS[i];
      const m = s.match(p.re);
      if (!m) continue;
      const date = p.pick(m);
      if (date) {
        return {
          date,
          source: sourceLabel ? sourceLabel + ' · ' + p.name : p.name
        };
      }
    }
    return null;
  }

  function addRenameLink(a, b) {
    if (!a || !b || a === b) return;
    if (!RENAME_LINKS.has(a)) RENAME_LINKS.set(a, new Set());
    if (!RENAME_LINKS.has(b)) RENAME_LINKS.set(b, new Set());
    RENAME_LINKS.get(a).add(b);
    RENAME_LINKS.get(b).add(a);
  }

  function relatedPaths(newRel) {
    const out = new Set([newRel]);
    const mapped = OLD_MAP[newRel];
    if (mapped) out.add(mapped);
    const linked = RENAME_LINKS.get(newRel);
    if (linked) linked.forEach(p => out.add(p));
    Object.keys(OLD_MAP).forEach(k => {
      if (OLD_MAP[k] === newRel) out.add(k);
    });
    return [...out];
  }

  function resolveItemDate(name, newRel, oldRel) {
    let r = parseDateFromString(name, '文件名');
    if (r) return r;
    if (oldRel) {
      r = parseDateFromString(String(oldRel).replace(/^images\//, ''), '旧路径');
      if (r) return r;
    }
    for (const rel of relatedPaths(newRel)) {
      if (rel === newRel) continue;
      r = parseDateFromString(String(rel).replace(/^images\//, ''), '重命名映射');
      if (r) return r;
    }
    return null;
  }

  function extractDate(name) {
    const r = parseDateFromString(name);
    return r ? r.date : null;
  }

  function formatDate(d) {
    if (!d) return '';
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function monthKey(d) {
    if (!d) return '未知日期';
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月';
  }

  function apiBase() {
    return 'https://api.github.com/repos/' + REPO.owner + '/' + REPO.repo;
  }

  function oauthCfg() { return global.OAUTH || {}; }

  function oauthClientId() {
    const cfgId = String(oauthCfg().clientId || '').trim();
    if (cfgId && !/PLACEHOLDER/i.test(cfgId)) return cfgId;
    return sessionStorage.getItem('pb4pg_oauth_client_id') || '';
  }

  function oauthClientSecret() {
    return sessionStorage.getItem(OAUTH_SECRET_KEY) || '';
  }

  function appManifest() {
    const redirect = oauthRedirectUri() || 'https://pioneersunovo.github.io/PictureBed4PicGo/gallery.html';
    return {
      name: 'PictureBed4PicGo Gallery',
      url: redirect,
      redirect_url: redirect,
      callback_urls: [redirect],
      public: true,
      request_oauth_on_install: false,
      default_permissions: { contents: 'write', metadata: 'read' },
      default_events: []
    };
  }

  function registerGithubApp() {
    const redirect = oauthRedirectUri();
    if (!redirect) { setStatus('请通过 GitHub Pages 打开本页', 'err'); return; }
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = 'https://github.com/settings/apps/new';
    form.style.display = 'none';
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'manifest';
    input.value = JSON.stringify(appManifest());
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
  }

  async function handleManifestReturn() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (!code || params.get('setup_action') === 'install') return false;
    setStatus('正在注册 GitHub App…');
    const res = await fetch('https://api.github.com/app-manifests/' + encodeURIComponent(code) + '/conversions', {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json' }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'GitHub App 注册失败');
    if (data.client_id) sessionStorage.setItem('pb4pg_oauth_client_id', data.client_id);
    if (data.client_secret) sessionStorage.setItem(OAUTH_SECRET_KEY, data.client_secret);
    history.replaceState(null, '', location.pathname + location.hash);
    setStatus('GitHub App 已就绪，正在登录…', 'ok');
    return data;
  }

  function oauthRedirectUri() {
    const cfg = oauthCfg();
    if (cfg.redirectUri) return cfg.redirectUri;
    if (location.protocol === 'file:') return '';
    return location.origin + location.pathname;
  }

  function token() { return sessionStorage.getItem(TOKEN_KEY) || ''; }

  function randomString(len) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    let s = '';
    for (let i = 0; i < len; i++) s += chars[arr[i] % chars.length];
    return s;
  }

  async function sha256Base64Url(str) {
    const data = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(hash);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function oauthTokenExchange(body) {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body
    });
    return res.json();
  }

  async function saveToken(accessToken) {
    sessionStorage.setItem(TOKEN_KEY, accessToken);
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/vnd.github+json' }
      });
      if (res.ok) {
        const u = await res.json();
        sessionStorage.setItem(AUTH_USER_KEY, u.login || '');
        if (u.avatar_url) sessionStorage.setItem(AUTH_AVATAR_KEY, u.avatar_url);
        updateSiteBranding(u.avatar_url, u.login);
      } else {
        sessionStorage.removeItem(AUTH_USER_KEY);
        sessionStorage.removeItem(AUTH_AVATAR_KEY);
      }
    } catch (_) {
      sessionStorage.removeItem(AUTH_USER_KEY);
      sessionStorage.removeItem(AUTH_AVATAR_KEY);
    }
    showAuthUI();
    updateLoginGate();
    if (!(await verifyGalleryAccess())) {
      sessionStorage.removeItem(TOKEN_KEY);
      throw new Error('此 GitHub 账号无权访问图库');
    }
    if (location.protocol !== 'file:') await refreshFromGitHub(true);
    await filter();
  }

  async function handleOAuthReturn() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (!code || !oauthClientId()) return false;
    const state = params.get('state');
    const saved = sessionStorage.getItem(OAUTH_STATE_KEY);
    const verifier = sessionStorage.getItem(OAUTH_VERIFIER_KEY);
    sessionStorage.removeItem(OAUTH_STATE_KEY);
    sessionStorage.removeItem(OAUTH_VERIFIER_KEY);
    history.replaceState(null, '', location.pathname + location.hash);
    if (!state || state !== saved) throw new Error('OAuth 校验失败，请重试');
    setStatus('正在完成 GitHub 登录…');
    const body = new URLSearchParams({
      client_id: oauthClientId(),
      code,
      redirect_uri: oauthRedirectUri()
    });
    if (verifier) body.set('code_verifier', verifier);
    const secret = oauthClientSecret();
    if (secret) body.set('client_secret', secret);
    const data = await oauthTokenExchange(body);
    if (data.error) {
      if (oauthClientSecret()) throw new Error(data.error_description || data.error);
      setStatus('正在尝试设备码登录…');
      await startDeviceLogin();
      return true;
    }
    await saveToken(data.access_token);
    setStatus('GitHub 登录成功', 'ok');
    return true;
  }

  async function startOAuthRedirect() {
    const clientId = oauthClientId();
    const redirectUri = oauthRedirectUri();
    if (!clientId) { setStatus('OAuth 未配置 Client ID', 'err'); return; }
    if (!redirectUri) { setStatus('请通过 GitHub Pages 打开本页以使用 GitHub 登录', 'err'); return; }
    const state = randomString(24);
    sessionStorage.setItem(OAUTH_STATE_KEY, state);
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state });
    if (!oauthClientSecret()) params.set('scope', oauthCfg().scope || 'repo');
    if (!oauthClientSecret()) {
      const verifier = randomString(96);
      const challenge = await sha256Base64Url(verifier);
      sessionStorage.setItem(OAUTH_VERIFIER_KEY, verifier);
      params.set('code_challenge', challenge);
      params.set('code_challenge_method', 'S256');
    }
    location.assign('https://github.com/login/oauth/authorize?' + params.toString());
  }

  async function pollDeviceToken(deviceCode, intervalSec) {
    if (devicePollAbort) devicePollAbort.aborted = true;
    const abort = { aborted: false };
    devicePollAbort = abort;
    let wait = Math.max(5, intervalSec || 5);
    const deadline = Date.now() + 900000;
    while (!abort.aborted && Date.now() < deadline) {
      await sleep(wait * 1000);
      const body = new URLSearchParams({
        client_id: oauthClientId(),
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:device_code'
      });
      const data = await oauthTokenExchange(body);
      if (data.error === 'authorization_pending') continue;
      if (data.error === 'slow_down') { wait += 5; continue; }
      if (data.error) throw new Error(data.error_description || data.error);
      if (data.access_token) { devicePollAbort = null; return data.access_token; }
    }
    devicePollAbort = null;
    throw new Error('授权超时，请重试');
  }

  async function startDeviceLogin() {
    const clientId = oauthClientId();
    if (!clientId) { setStatus('OAuth 未配置 Client ID', 'err'); return; }
    if (oauthClientSecret()) { setStatus('请使用 GitHub 登录按钮（浏览器授权）', 'err'); return; }
    setStatus('正在连接 GitHub…');
    const res = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, scope: oauthCfg().scope || 'repo' })
    });
    const data = await res.json();
    if (data.error || data.message) {
      throw new Error(data.error_description || data.message || data.error || '设备码请求失败');
    }
    const verifyUrl = data.verification_uri + '?user_code=' + encodeURIComponent(data.user_code);
    window.open(verifyUrl, 'pb4pg_github_auth', 'noopener,width=520,height=720');
    setStatus('已在 GitHub 打开授权页…');
    const accessToken = await pollDeviceToken(data.device_code, data.interval);
    await saveToken(accessToken);
    setStatus('GitHub 登录成功', 'ok');
  }

  async function loginGithub() {
    try {
      if (!oauthRedirectUri()) { setStatus('请通过 GitHub Pages 打开本页以登录', 'err'); return; }
      if (!oauthClientId()) {
        setStatus('首次使用：正在跳转 GitHub 注册应用…');
        registerGithubApp();
        return;
      }
      await startOAuthRedirect();
    } catch (e) {
      setStatus('登录失败: ' + e.message, 'err');
    }
  }

  function logout() {
    if (devicePollAbort) devicePollAbort.aborted = true;
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(AUTH_USER_KEY);
    sessionStorage.removeItem(AUTH_AVATAR_KEY);
    sessionStorage.removeItem(OAUTH_STATE_KEY);
    sessionStorage.removeItem(OAUTH_VERIFIER_KEY);
    clearPrivateUrlCache();
    clearAllSelections();
    detailItem = null;
    ITEMS = [];
    similarLoaded = false;
    similarSets = [];
    suspectSets = [];
    similarIndexRaw = null;
    closeDetail();
    const pat = document.getElementById('pat');
    if (pat) pat.value = '';
    updateSiteBranding(null, REPO.owner);
    showAuthUI();
    updateLoginGate();
    void filter();
    setStatus('已退出', 'ok');
  }

  function setStatus(msg, kind) {
    const el = document.getElementById('status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'status' + (kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : '');
  }

  function encodePath(path) {
    return path.split('/').map(s => encodeURIComponent(s)).join('/');
  }

  function extractHash(name) {
    const m = String(name).match(HASH_RE);
    return m ? m[1].toLowerCase() : '';
  }

  function sortItemsByDate(items) {
    return [...items].sort((a, b) => {
      const da = a.date ? a.date.getTime() : 0;
      const db = b.date ? b.date.getTime() : 0;
      if (da !== db) return da - db;
      return a.name.localeCompare(b.name);
    });
  }

  function pickKeepItem(items) {
    const sorted = sortItemsByDate(items);
    return sorted[sorted.length - 1];
  }

  function buildExactSets() {
    exactSets = [];
    hashGroups.forEach((rels, hash) => {
      if (rels.length < 2) return;
      const items = rels.map(r => itemByRel(r)).filter(Boolean);
      if (items.length < 2) return;
      const keep = pickKeepItem(items);
      exactSets.push({
        id: 'exact-' + hash.slice(0, 12),
        type: 'exact',
        items: sortItemsByDate(items),
        keepRel: keep.newRel
      });
    });
    exactSets.sort((a, b) => b.items.length - a.items.length);
  }

  function isExactOnlyGroup(items) {
    const hashes = new Set(items.map(i => i.hash).filter(Boolean));
    return hashes.size === 1 && items.every(i => i.hash);
  }

  function itemByFileName(file) {
    const rel = file.includes('/')
      ? file
      : (ITEMS.find(i => i.name === file && i.isPrivate)
        ? PRIVATE_PREFIX + file
        : PUBLIC_PREFIX + file);
    return itemByRel(rel) || ITEMS.find(i => i.name === file || i.name === rel.split('/').pop());
  }

  function stripItemSimilarMeta() {
    ITEMS.forEach(item => {
      delete item.simToKeep;
      delete item.ssimToKeep;
      delete item.phashDistToKeep;
      delete item.matchPath;
    });
  }

  function formatSimPct(sim) {
    return Math.round(Math.max(0, Math.min(1, sim)) * 1000) / 10 + '%';
  }

  function mapIndexGroup(g, isSuspect) {
    const mapped = [];
    (g.items || []).forEach(it => {
      const item = itemByFileName(it.file);
      if (!item) return;
      if (it.role !== 'keep') {
        if (it.clipSim != null) item.simToKeep = it.clipSim;
        if (it.ssim != null) item.ssimToKeep = it.ssim;
        if (it.phashDist != null) item.phashDistToKeep = it.phashDist;
        if (it.matchPath) item.matchPath = it.matchPath;
      }
      mapped.push(item);
    });
    if (mapped.length < 2) return null;
    const keepEntry = (g.items || []).find(it => it.role === 'keep');
    const keepItem = (keepEntry && itemByFileName(keepEntry.file)) || pickKeepItem(mapped);
    return {
      id: g.id,
      type: 'similar',
      kind: g.kind || (isSuspect ? 'suspect' : 'near'),
      items: sortItemsByDate(mapped),
      keepRel: keepItem.newRel,
      paths: g.paths || [],
      minSimilarity: g.minSimilarity,
      maxSimilarity: g.maxSimilarity,
      avgSimilarity: g.avgSimilarity,
      phashDist: mapped.find(i => i.phashDistToKeep != null)?.phashDistToKeep
    };
  }

  function applySimilarIndex(index) {
    similarIndexRaw = index;
    stripItemSimilarMeta();
    const mode = similarMode;
    const groups = (index.groups || []).filter(g => {
      if (mode === 'all') return g.kind === 'near' || g.kind === 'semantic';
      return g.kind === mode;
    });
    similarSets = groups.map(g => mapIndexGroup(g, false)).filter(Boolean)
      .filter(g => !isExactOnlyGroup(g.items));
    suspectSets = (index.suspects || []).map(g => mapIndexGroup(g, true)).filter(Boolean);
    scanMeta = {
      clipStatus: index.clipStatus,
      clipError: index.clipError,
      clipModel: index.clipModel,
      generatedAt: index.generatedAt,
      algoVersion: index.algoVersion,
      imageCount: index.imageCount,
      confirmedPairs: (index.meta && index.meta.nearPairs) || 0,
      suspectPairs: (index.meta && index.meta.suspectPairs) || 0,
      nearGroups: (index.meta && index.meta.nearGroups) || 0,
      semanticGroups: (index.meta && index.meta.semanticGroups) || 0
    };
    const el = document.getElementById('similarCount');
    if (el) el.textContent = String(similarSets.length);
  }

  function similarIndexUrls() {
    const pin = repoHeadCommit || 'master';
    const bust = ASSET_VERSION + '-' + (repoHeadCommit || Date.now());
    const path = 'meta/similar-index.json';
    return [
      path + '?v=' + encodeURIComponent(bust),
      'https://cdn.jsdelivr.net/gh/PioneerSunOvO/PictureBed4PicGo@' + pin + '/' + path + '?v=' + bust,
      'https://raw.githubusercontent.com/PioneerSunOvO/PictureBed4PicGo/' + pin + '/' + path + '?v=' + bust
    ];
  }

  async function fetchSimilarIndexJson() {
    if (token()) {
      try {
        const meta = await ghFetch('/contents/meta/similar-index.json?ref=' + REPO.branch);
        if (meta && meta.content) {
          return JSON.parse(atob(meta.content.replace(/\s/g, '')));
        }
      } catch (_) { /* fallback below */ }
    }
    if (requireGalleryLogin() && !token()) {
      throw new Error('需要登录后加载相似索引');
    }
    let lastErr = null;
    for (const url of similarIndexUrls()) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(url + ' → ' + res.status);
        return await res.json();
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('similar-index.json 不可用');
  }

  async function loadSimilarIndex(force) {
    if (requireGalleryLogin() && !token()) return;
    if (similarLoading) return;
    if (similarLoaded && !force) return;
    similarLoading = true;
    similarLoaded = false;
    similarSets = [];
    suspectSets = [];
    scanMeta = null;
    collapsedGroups.clear();
    const container = document.getElementById('mediaContainer');
    if (container && category === 'similar') {
      container.innerHTML = '<div class="scan-progress"><div>加载相似索引…</div></div>';
    }
    setStatus('加载 meta/similar-index.json…');
    try {
      const index = await fetchSimilarIndexJson();
      applySimilarIndex(index);
      similarLoaded = true;
      const st = index.clipStatus === 'ok' ? 'ok' : (index.clipStatus === 'failed' ? 'err' : 'ok');
      setStatus(
        '相似索引已加载：' + similarSets.length + ' 组 · CLIP ' + (index.clipStatus || '?') +
        (index.generatedAt ? ' · ' + index.generatedAt : ''),
        st
      );
    } catch (e) {
      similarLoaded = true;
      similarSets = [];
      setStatus('相似索引加载失败: ' + e.message + ' · 可点「触发重算」跑 Actions', 'err');
    }
    similarLoading = false;
    autoSmartSelected = false;
    if (category === 'similar') void filter();
  }

  function smartSelectGroups(sets, replace) {
    if (replace) {
      sets.forEach(g => g.items.forEach(i => selected.delete(i.newRel)));
    }
    sets.forEach(g => {
      g.items.forEach(i => {
        if (i.newRel !== g.keepRel) selected.add(i.newRel);
        else selected.delete(i.newRel);
      });
    });
    updateSelUI();
  }

  function rebuildDupIndex() {
    hashGroups.clear();
    ITEMS.forEach(item => {
      if (!item.hash) return;
      if (!hashGroups.has(item.hash)) hashGroups.set(item.hash, []);
      hashGroups.get(item.hash).push(item.newRel);
    });
    ITEMS.forEach(item => {
      const g = item.hash ? hashGroups.get(item.hash) : null;
      item.dupCount = g && g.length > 1 ? g.length : 0;
    });
    buildExactSets();
    const dupFiles = ITEMS.filter(i => i.dupCount > 0).length;
    const el = document.getElementById('dupCount');
    if (el) el.textContent = String(dupFiles);
    if (similarLoaded && similarIndexRaw) applySimilarIndex(similarIndexRaw);
    return dupFiles;
  }

  function updateCategoryCounts() {
    const counts = { all: ITEMS.length, vault: 0, image: 0, video: 0, audio: 0, document: 0, text: 0, other: 0 };
    ITEMS.forEach(i => {
      if (i.isPrivate) { counts.vault++; return; }
      if (counts[i.kind] !== undefined) counts[i.kind]++;
    });
    Object.keys(counts).forEach(k => {
      const el = document.getElementById('cnt' + k.charAt(0).toUpperCase() + k.slice(1));
      if (el) el.textContent = String(counts[k]);
    });
  }

  function buildItemFromPath(fullPath, oldRel) {
    const isPrivate = isPrivateRel(fullPath);
    const prefix = isPrivate ? PRIVATE_PREFIX : PUBLIC_PREFIX;
    if (!fullPath.startsWith(prefix)) throw new Error('invalid media path: ' + fullPath);
    const name = fullPath.slice(prefix.length);
    const enc = encodePath(fullPath);
    const hash = extractHash(name);
    const kind = fileKind(name);
    const mappedOld = oldRel || OLD_MAP[fullPath] || '';
    const resolved = resolveItemDate(name, fullPath, mappedOld);
    const date = resolved ? resolved.date : null;
    const pin = repoHeadCommit || REPO.branch;
    return {
      name,
      newRel: fullPath,
      oldRel: mappedOld,
      isPrivate,
      hash,
      kind,
      ext: extOf(name),
      date,
      dateStr: formatDate(date),
      dateSource: resolved ? resolved.source : '',
      dupCount: 0,
      rev: 0,
      cdn: 'https://cdn.jsdelivr.net/gh/' + REPO.owner + '/' + REPO.repo + '@' + pin + '/' + enc,
      raw: 'https://raw.githubusercontent.com/' + REPO.owner + '/' + REPO.repo + '/' + pin + '/' + enc
    };
  }

  function buildItem(name, oldRel) {
    return buildItemFromPath(PUBLIC_PREFIX + name, oldRel);
  }

  async function enrichDatesFromGit(items) {
    const need = items.filter(i => !i.date);
    if (!need.length || !token()) return;
    let done = 0;
    for (const item of need) {
      try {
        const data = await ghFetch('/commits?path=' + encodeURIComponent(item.newRel) + '&per_page=1');
        const iso = data && data[0] && data[0].commit && data[0].commit.committer &&
          data[0].commit.committer.date;
        if (iso) {
          item.date = new Date(iso);
          item.dateStr = formatDate(item.date);
          item.dateSource = 'Git 提交';
        }
      } catch (_) { /* skip */ }
      done++;
      if (done % 5 === 0) setStatus('补全日期 ' + done + '/' + need.length + '…');
    }
  }

  async function fetchRepoHead() {
    try {
      const ref = await ghFetch('/git/ref/heads/' + REPO.branch);
      if (ref && ref.object && ref.object.sha) repoHeadCommit = ref.object.sha;
    } catch (_) { /* keep previous pin */ }
    return repoHeadCommit;
  }

  function bumpRepoHead(commitSha) {
    if (commitSha) repoHeadCommit = commitSha;
  }

  function mediaPin(item) {
    return (item && item.commitSha) || repoHeadCommit || REPO.branch;
  }

  async function ghFetch(path, opts = {}) {
    const headers = { Accept: 'application/vnd.github+json', ...(opts.headers || {}) };
    const t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    const res = await fetch(apiBase() + path, { ...opts, headers, cache: 'no-store' });
    if (!res.ok) {
      let detail = res.status + ' ' + res.statusText;
      try { const j = await res.json(); if (j.message) detail = j.message; } catch (_) { /* ignore */ }
      throw new Error(detail);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function fetchRemotePaths() {
    const prefixes = [PUBLIC_PREFIX];
    if (token()) prefixes.push(PRIVATE_PREFIX);
    const data = await ghFetch('/git/trees/' + REPO.branch + '?recursive=1');
    return (data.tree || [])
      .filter(t => t.type === 'blob' && prefixes.some(p => t.path.startsWith(p)))
      .map(t => ({ path: t.path, sha: t.sha }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async function fetchOldMapFromRemote() {
    OLD_MAP = {};
    RENAME_LINKS.clear();
    const parseCsv = (text) => {
      const lines = String(text || '').split(/\r?\n/).filter(Boolean);
      for (let i = 1; i < lines.length; i++) {
        const m = lines[i].match(/^"([^"]*)","([^"]*)"/);
        if (!m || !m[2]) continue;
        OLD_MAP[m[2]] = m[1];
        addRenameLink(m[1], m[2]);
      }
    };
    try {
      const meta = await ghFetch('/contents/rename-mapping.csv?ref=' + REPO.branch);
      if (meta && meta.content) {
        parseCsv(atob(meta.content.replace(/\s/g, '')));
        return;
      }
    } catch (_) { /* fallback */ }
    const fallbacks = [
      'https://cdn.jsdelivr.net/gh/' + REPO.owner + '/' + REPO.repo + '@' + (repoHeadCommit || REPO.branch) + '/rename-mapping.csv',
      'https://raw.githubusercontent.com/' + REPO.owner + '/' + REPO.repo + '/' + REPO.branch + '/rename-mapping.csv'
    ];
    for (const url of fallbacks) {
      try {
        const res = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) continue;
        parseCsv(await res.text());
        return;
      } catch (_) { /* next */ }
    }
  }

  async function getFileMeta(relPath) {
    return ghFetch('/contents/' + encodePath(relPath) + '?ref=' + REPO.branch + '&_=' + Date.now());
  }

  async function fileToBase64(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  /** Replace via Git Data API — always reads latest branch HEAD, avoids stale blob SHA. */
  async function putFileViaGit(relPath, contentBase64, msg) {
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const refData = await ghFetch('/git/ref/heads/' + REPO.branch);
        const baseCommitSha = refData.object.sha;
        const commitData = await ghFetch('/git/commits/' + baseCommitSha);
        const blob = await ghFetch('/git/blobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: contentBase64, encoding: 'base64' })
        });
        const tree = await ghFetch('/git/trees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            base_tree: commitData.tree.sha,
            tree: [{ path: relPath, mode: '100644', type: 'blob', sha: blob.sha }]
          })
        });
        const commit = await ghFetch('/git/commits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: msg || 'gallery: update ' + relPath,
            tree: tree.sha,
            parents: [baseCommitSha]
          })
        });
        await ghFetch('/git/refs/heads/' + REPO.branch, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sha: commit.sha })
        });
        return { content: { sha: blob.sha }, commitSha: commit.sha };
      } catch (e) {
        lastErr = e;
        const retry = /fast forward|409|422|does not match/i.test(e.message);
        if (!retry || attempt === 4) throw e;
        await sleep(600 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  async function deleteFile(relPath, sha, msg) {
    await ghFetch('/contents/' + encodePath(relPath), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg || 'gallery: delete ' + relPath, sha, branch: REPO.branch })
    });
  }

  async function putFile(relPath, contentBase64, sha, msg) {
    const body = { message: msg || 'gallery: update ' + relPath, content: contentBase64, branch: REPO.branch };
    if (sha) body.sha = sha;
    return ghFetch('/contents/' + encodePath(relPath), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  function urlsFor(item) {
    const primary = srcOf(item);
    const urls = [primary];
    if (!item.isPrivate && primary.includes('cdn.jsdelivr.net/gh/')) {
      urls.push(primary.replace('cdn.jsdelivr.net/gh/', 'raw.githubusercontent.com/').replace(/@[a-f0-9]{40}\//, '/master/'));
    }
    return urls.filter(Boolean);
  }

  async function privateBlobUrl(item) {
    const cached = privateUrlCache.get(item.newRel);
    if (cached && cached.expMs > Date.now() + 60000) return cached.url;
    const meta = await ghFetch('/contents/' + encodePath(item.newRel) + '?ref=' + REPO.branch);
    if (!meta || !meta.content) throw new Error('无法读取私有文件');
    const bin = atob(meta.content.replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: metaContentType(item.name) });
    const url = URL.createObjectURL(blob);
    privateUrlCache.set(item.newRel, { url, expMs: Date.now() + 3600000, revoke: true });
    return url;
  }

  async function ensurePrivateUrl(item) {
    if (!item || !item.isPrivate) return srcOf(item);
    const cached = privateUrlCache.get(item.newRel);
    if (cached && cached.expMs > Date.now() + 60000) return cached.url;
    const base = String(securityCfg().privateProxyBase || '').replace(/\/$/, '');
    if (base) {
      const t = token();
      if (!t) throw new Error('需要登录');
      const res = await fetch(base + '/sign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + t,
          Accept: 'application/json'
        },
        body: JSON.stringify({ path: item.newRel })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '私有资源签名失败');
      privateUrlCache.set(item.newRel, { url: data.url, expMs: (data.exp || 0) * 1000 });
      return data.url;
    }
    return privateBlobUrl(item);
  }

  async function ensurePrivateUrls(items) {
    const priv = (items || []).filter(i => i && i.isPrivate);
    if (!priv.length) return;
    await Promise.all(priv.map(i => ensurePrivateUrl(i).catch(() => '')));
  }

  function currentSourceMode() {
    const el = document.getElementById('source');
    return (el && el.value) || 'cdn';
  }

  function sourceModeLabel(mode) {
    if (mode === 'raw') return 'GitHub Raw';
    if (mode === 'local') return '本地路径';
    return 'jsDelivr CDN';
  }

  /** Preview URL inside Gallery (blob for private when no proxy). */
  function srcOf(item) {
    if (item.isPrivate) {
      const cached = privateUrlCache.get(item.newRel);
      return cached ? cached.url : '';
    }
    return shareUrlOf(item);
  }

  /**
   * Shareable URL for clipboard / other devices.
   * Follows toolbar「源」菜单：cdn | raw | local.
   * Private files: CDN/Raw 私链（公开仓路径可直链；勿当公开 Markdown 推荐用法）.
   */
  function shareUrlOf(item) {
    if (!item) return '';
    const mode = currentSourceMode();
    const enc = encodePath(item.newRel);
    const pin = mediaPin(item);
    if (mode === 'local' && !item.isPrivate) return item.newRel;
    if (mode === 'raw' || (mode === 'local' && item.isPrivate)) {
      return 'https://raw.githubusercontent.com/' + REPO.owner + '/' + REPO.repo + '/' + pin + '/' + enc;
    }
    return 'https://cdn.jsdelivr.net/gh/' + REPO.owner + '/' + REPO.repo + '@' + pin + '/' + enc;
  }

  async function copyItemLink(item) {
    if (!item) return;
    const link = shareUrlOf(item);
    if (!link) {
      setStatus('无法生成链接', 'err');
      return;
    }
    await navigator.clipboard.writeText(link);
    const mode = currentSourceMode();
    if (item.isPrivate) {
      setStatus('已复制私链（' + sourceModeLabel(mode) + '）· 可多设备打开', 'ok');
    } else {
      setStatus('已复制链接（' + sourceModeLabel(mode) + '）', 'ok');
    }
  }

  function privateBadgeHtml() {
    return '<span class="private-badge" title="私有：可复制私链到其他设备，不建议写进公开 Markdown">私有</span>';
  }

  function cardUserTagsTriggerHtml(item) {
    if (!token()) return '';
    const id = item._tagId || tagIdCache.get(item.newRel);
    const tags = (tagsUnlocked && id) ? (tagsById.get(id) || []) : [];
    const hasEncrypted = !!(id && tagsEnvelope && tagsEnvelope.entries && tagsEnvelope.entries[id]);
    let inner = '';
    if (tagsUnlocked) {
      if (tags.length) {
        inner = tags.slice(0, 4).map(t =>
          '<span class="tag-chip">' + escapeHtml(t) + '</span>'
        ).join('');
        if (tags.length > 4) inner += '<span class="tag-chip tag-more">+' + (tags.length - 4) + '</span>';
      } else {
        inner = '<span class="tag-chip tag-add-hint">+标签</span>';
      }
    } else if (hasEncrypted) {
      inner = '<span class="tag-chip tag-locked" title="点击输入口令解锁">🔒</span>';
    } else {
      inner = '<span class="tag-chip tag-add-hint">+标签</span>';
    }
    return '<button type="button" class="card-user-tags" data-action="tag-edit" title="编辑标签（不含「私有」）">' +
      inner + '</button>';
  }

  function cardBadgesHtml(item) {
    let html = '<div class="card-badges">';
    if (item.isPrivate) html += privateBadgeHtml();
    html += cardUserTagsTriggerHtml(item);
    html += '</div>';
    return html;
  }

  function cardHoverHtml(item, hasToken) {
    return '<div class="card-hover">' +
      '<button type="button" data-action="copy-url">' + (item.isPrivate ? '私链' : '链接') + '</button>' +
      '<button type="button" data-action="preview">预览</button>' +
      '<button type="button" data-action="detail">详情</button>' +
      (hasToken ? '<button type="button" class="del" data-action="delete">删除</button>' : '') +
      '</div>';
  }

  function closeTagPopover() {
    tagPopoverItem = null;
    const pop = document.getElementById('tagPopover');
    if (pop) pop.hidden = true;
  }

  async function refreshTagPopover() {
    if (!tagPopoverItem) return;
    const body = document.getElementById('tagPopoverBody');
    const title = document.getElementById('tagPopoverTitle');
    if (!body) return;
    const tags = await tagsForItem(tagPopoverItem);
    if (title) title.textContent = tagPopoverItem.name;
    body.innerHTML = buildTagEditorHtml(tagPopoverItem, tags);
  }

  async function openTagEditorForItem(item, anchorEl) {
    if (!item) return;
    if (!token()) {
      setStatus('请先登录后再打标签', 'err');
      return;
    }
    if (!tagsUnlocked) {
      await promptUnlockTags();
      if (!tagsUnlocked) return;
      void filter();
    }
    tagPopoverItem = item;
    const pop = document.getElementById('tagPopover');
    const body = document.getElementById('tagPopoverBody');
    if (!pop || !body) return;
    await refreshTagPopover();
    pop.hidden = false;
    const rect = anchorEl.getBoundingClientRect();
    const pad = 8;
    let top = rect.bottom + pad;
    let left = Math.min(rect.left, window.innerWidth - 300);
    if (top + 220 > window.innerHeight) top = Math.max(pad, rect.top - 220);
    if (left < pad) left = pad;
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
    const input = body.querySelector('#tagInput');
    if (input) {
      requestAnimationFrame(() => input.focus());
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  /** 同步勾选计数、全选框、批量按钮状态，并把当前菜单勾选写入 selectionByCat */
  function updateSelUI() {
    selectionByCat.set(category, [...selected]);
    const n = selected.size;
    const el = document.getElementById('selCount');
    if (el) el.textContent = String(n);
    ['batchDelete', 'batchRename', 'batchReplace'].forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) return;
      if (id === 'batchDelete') btn.disabled = n === 0;
      else btn.disabled = n !== 1;
    });
    const all = document.getElementById('selectAll');
    if (all && filtered.length) {
      const allSel = filtered.every(i => selected.has(i.newRel));
      all.checked = allSel;
      all.indeterminate = n > 0 && !allSel;
    }
    const manageBar = document.getElementById('manageBar');
    if (manageBar && token()) manageBar.classList.remove('hidden');
  }

  function toggleSelect(rel, on) {
    if (on) selected.add(rel);
    else selected.delete(rel);
    updateSelUI();
  }

  function thumbHtml(item, url, small) {
    const k = item.kind;
    if (k === 'image') {
      return '<img loading="lazy" alt="" src="' + escapeAttr(url) + '">';
    }
    if (k === 'video') {
      return '<video muted preload="metadata" src="' + escapeAttr(url) + '"></video>';
    }
    const icon = TYPE_ICONS[k] || TYPE_ICONS.other;
    const cls = small ? 'thumb-ext' : 'thumb-icon';
    return '<span class="' + cls + '">' + (small ? escapeHtml(item.ext) : icon) + '</span>';
  }

  function sortList(list) {
    const sorted = [...list];
    sorted.sort((a, b) => {
      if (sortBy === 'name-asc') return a.name.localeCompare(b.name);
      if (sortBy === 'name-desc') return b.name.localeCompare(a.name);
      if (sortBy === 'type') return a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);
      const da = a.date ? a.date.getTime() : 0;
      const db = b.date ? b.date.getTime() : 0;
      return sortBy === 'date-asc' ? da - db : db - da;
    });
    return sorted;
  }

  function groupByMonth(list) {
    const groups = new Map();
    list.forEach(item => {
      const key = monthKey(item.date);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    return groups;
  }

  function renderGroupCard(item, group, hasToken) {
    const url = srcOf(item);
    const sel = selected.has(item.newRel);
    const isKeep = item.newRel === group.keepRel;
    const isDup = item.dupCount > 1;
    let html = '<article class="card' + (sel ? ' selected' : '') + (isKeep ? ' keep' : '') + (isDup ? ' dup' : '') +
      (group.type === 'similar' && !isKeep ? ' sim-candidate' : '') +
      '" data-rel="' + escapeAttr(item.newRel) + '">';
    if (isKeep) html += '<span class="keep-badge">保留</span>';
    if (hasToken) {
      html += '<input type="checkbox" class="card-check"' + (sel ? ' checked' : '') + '>';
    }
    if (isDup && !isKeep) html += '<span class="badge">重复 ×' + item.dupCount + '</span>';
    html += cardBadgesHtml(item);
    if (group.type === 'similar' && !isKeep && item.simToKeep != null) {
      const label = formatSimPct(item.simToKeep);
      const pct = Math.round(Math.max(0, Math.min(1, item.simToKeep)) * 100);
      html += '<span class="sim-score" title="相对保留项相似度">' + label + '</span>';
      html += '<div class="sim-bar"><div class="sim-bar-fill" style="width:' + pct + '%"></div></div>';
    }
    if (group.type === 'similar' && !isKeep && item.matchPath) {
      html += '<span class="match-path" title="命中路径">' + escapeHtml(item.matchPath) + '</span>';
    }
    if (group.type === 'similar' && !isKeep && item.phashDistToKeep != null && item.simToKeep == null) {
      html += '<span class="match-path" title="pHash 汉明距离">pHash ' + item.phashDistToKeep + '</span>';
    }
    if (item.kind !== 'image') {
      html += '<div class="thumb-wrap">' + thumbHtml(item, url, false) +
        '<span class="type-badge">' + escapeHtml(item.ext || 'file') + '</span></div>';
    } else {
      html += '<div class="thumb-wrap">' + thumbHtml(item, url, false) + '</div>';
    }
    html += cardHoverHtml(item, hasToken);
    html += '<div class="card-meta"><div class="card-name">' + escapeHtml(item.name) + '</div>';
    if (item.dateStr) html += '<div class="card-date">' + escapeHtml(item.dateStr) + '</div>';
    html += '</div></article>';
    return html;
  }

  function renderDupGroups(sets, mode) {
    const hasToken = !!token();
    let html = '<div class="dup-workflow">';
    html += '<div class="dup-toolbar">';
    html += '<div class="hint">';
    if (mode === 'exact') {
      html += '按文件名 hash 精确分组。点击「智能选中」后才会勾选待删项。';
    } else {
      html += '<strong>相似审阅</strong> · 由 GitHub Actions 预计算（pHash + CLIP），本页只读索引。';
      if (scanMeta) {
        html += '<div class="scan-summary">';
        html += '引擎：Actions · CLIP ' + escapeHtml(String(scanMeta.clipStatus || '?'));
        if (scanMeta.clipError) html += ' · ' + escapeHtml(String(scanMeta.clipError).slice(0, 80));
        if (scanMeta.generatedAt) html += ' · ' + escapeHtml(String(scanMeta.generatedAt));
        html += ' · near ' + (scanMeta.nearGroups || 0) + ' · semantic ' + (scanMeta.semanticGroups || 0);
        html += ' · 疑似对 ' + (scanMeta.suspectPairs || 0);
        html += '</div>';
      }
    }
    html += '</div>';
    html += '<div class="dup-toolbar-actions">';
    html += '<button type="button" class="primary" data-dup-action="smart-select">智能选中待删</button>';
    html += '<button type="button" data-dup-action="clear-select">取消选中</button>';
    if (selected.size === 2) {
      html += '<button type="button" class="primary" data-dup-action="compare-selected">对比已选</button>';
    }
    if (mode === 'similar') {
      html += '<select id="similarMode" class="dup-select">';
      html += '<option value="all"' + (similarMode === 'all' ? ' selected' : '') + '>全部</option>';
      html += '<option value="near"' + (similarMode === 'near' ? ' selected' : '') + '>近重复</option>';
      html += '<option value="semantic"' + (similarMode === 'semantic' ? ' selected' : '') + '>语义相似</option>';
      html += '</select>';
      html += '<button type="button" data-dup-action="rescan">刷新索引</button>';
      html += '<a class="btn-link" href="' + ACTIONS_SIMILAR_URL + '" target="_blank" rel="noopener" data-dup-action="rebuild-link">触发重算</a>';
    }
    html += '</div></div>';

    if (!sets.length && !(mode === 'similar' && suspectSets.length)) {
      html += '<div class="empty">' + (mode === 'exact' ? '未发现 hash 重复' : '未发现相似组（可点「触发重算」跑 Actions，再「刷新索引」）') + '</div>';
      html += '</div>';
      return html;
    }

    if (mode === 'similar' && selected.size > 0) {
      html += '<div class="dup-warn">已选中 <strong>' + selected.size + '</strong> 张待删 · 删除前请再次确认</div>';
    }

    sets.forEach((group, gi) => {
      html += renderOneDupGroup(group, gi, mode, hasToken, false);
    });

    if (mode === 'similar' && suspectSets.length) {
      html += '<div class="suspect-section' + (suspectExpanded ? '' : ' collapsed') + '">';
      html += '<div class="suspect-head" data-suspect-toggle="1">';
      html += '<button type="button" class="dup-collapse-btn" aria-label="展开/折叠">' + (suspectExpanded ? '▾' : '▸') + '</button>';
      html += '<div class="suspect-title">疑似相似<span class="sub">' + suspectSets.length + ' 组 · 阈值边缘</span></div>';
      html += '</div>';
      if (suspectExpanded) {
        html += '<div class="suspect-body">';
        suspectSets.forEach((group, gi) => {
          html += renderOneDupGroup(group, gi, mode, hasToken, true);
        });
        html += '</div>';
      }
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  function renderOneDupGroup(group, gi, mode, hasToken, isSuspect) {
    const keepItem = itemByRel(group.keepRel);
    const keepDate = keepItem && keepItem.dateStr ? keepItem.dateStr : '';
    const collapsed = collapsedGroups.has(group.id);
    const selectedInGroup = group.items.filter(i => selected.has(i.newRel)).length;
    let html = '<div class="dup-group' + (collapsed ? ' collapsed' : '') + (isSuspect ? ' suspect' : '') + '" data-group-id="' + escapeAttr(group.id) + '">';
    html += '<div class="dup-group-head" data-group-toggle="' + escapeAttr(group.id) + '">';
    html += '<button type="button" class="dup-collapse-btn" aria-label="展开/折叠">' + (collapsed ? '▸' : '▾') + '</button>';
    html += '<div class="dup-group-title">' + (isSuspect ? '疑似 ' : '组 ') + (gi + 1) + ' · ' + group.items.length + ' 张';
    if (selectedInGroup) html += ' · 已选 ' + selectedInGroup;
    if (mode === 'exact') html += '<span class="sub">hash 相同</span>';
    else if (group.paths && group.paths.length) {
      html += '<span class="sub">' + escapeHtml(group.paths.join(' · ')) + '</span>';
    } else if (group.minSimilarity != null) {
      html += '<span class="sub">相似 ' + formatSimPct(group.minSimilarity) +
        '–' + formatSimPct(group.maxSimilarity || group.minSimilarity) +
        (group.avgSimilarity != null ? ' · 均 ' + formatSimPct(group.avgSimilarity) : '') + '</span>';
    } else if (group.phashDist != null) {
      html += '<span class="sub">pHash ' + group.phashDist + '</span>';
    }
    if (keepDate) html += '<span class="sub">保留 ' + escapeHtml(keepDate) + '</span>';
    html += '</div>';
    if (!isSuspect) {
      html += '<div class="dup-group-actions">';
      html += '<button type="button" data-group-action="compare" data-group-id="' + escapeAttr(group.id) + '">对比</button>';
      html += '<button type="button" data-group-action="smart" data-group-id="' + escapeAttr(group.id) + '">本组智能选中</button>';
      html += '<button type="button" data-group-action="all" data-group-id="' + escapeAttr(group.id) + '">全选本组</button>';
      html += '</div>';
    } else if (group.items.length >= 2) {
      html += '<div class="dup-group-actions">';
      html += '<button type="button" data-group-action="compare" data-group-id="' + escapeAttr(group.id) + '">对比</button>';
      html += '</div>';
    }
    html += '</div>';
    if (!collapsed) {
      html += '<div class="grid dup-group-grid">';
      group.items.forEach(item => { html += renderGroupCard(item, group, hasToken); });
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function getSetsForCategory() {
    if (category === 'dup') return exactSets;
    if (category === 'similar') return similarSets;
    return [];
  }

  function flattenSets(sets) {
    return sets.flatMap(g => g.items);
  }

  function findGroupById(id) {
    return getSetsForCategory().find(g => g.id === id) ||
      exactSets.find(g => g.id === id) ||
      similarSets.find(g => g.id === id) ||
      suspectSets.find(g => g.id === id);
  }

  function renderGrid(list) {
    const hasToken = !!token();
    const groups = groupByMonth(list);
    let html = '';
    groups.forEach((items, title) => {
      html += '<div class="date-group"><div class="date-group-title">' + escapeHtml(title) + '</div><div class="grid">';
      items.forEach((item, idx) => {
        const url = srcOf(item);
        const isDup = item.dupCount > 1;
        const sel = selected.has(item.newRel);
        html += '<article class="card' + (sel ? ' selected' : '') + (isDup ? ' dup' : '') + '" data-rel="' + escapeAttr(item.newRel) + '" style="animation-delay:' + Math.min(idx, 20) * 10 + 'ms">';
        if (hasToken) {
          html += '<input type="checkbox" class="card-check"' + (sel ? ' checked' : '') + '>';
        }
        if (isDup) html += '<span class="badge">重复 ×' + item.dupCount + '</span>';
        html += cardBadgesHtml(item);
        if (item.kind !== 'image') {
          html += '<div class="thumb-wrap">' + thumbHtml(item, url, false) +
            '<span class="type-badge">' + escapeHtml(item.ext || 'file') + '</span></div>';
        } else {
          html += '<div class="thumb-wrap">' + thumbHtml(item, url, false) + '</div>';
        }
        html += cardHoverHtml(item, hasToken);
        html += '<div class="card-meta"><div class="card-name">' + escapeHtml(item.name) + '</div>';
        if (item.dateStr) html += '<div class="card-date">' + escapeHtml(item.dateStr) + '</div>';
        html += '</div></article>';
      });
      html += '</div></div>';
    });
    return html;
  }

  function renderList(list) {
    const hasToken = !!token();
    let html = '<div class="list">';
    list.forEach(item => {
      const url = srcOf(item);
      const sel = selected.has(item.newRel);
      html += '<div class="list-row' + (sel ? ' selected' : '') + '" data-rel="' + escapeAttr(item.newRel) + '">';
      html += '<div class="list-thumb">' + thumbHtml(item, url, true) + '</div>';
      html += '<div class="list-info"><div class="name">' + escapeHtml(item.name);
      if (item.isPrivate) html += ' ' + privateBadgeHtml();
      if (token()) html += ' ' + cardUserTagsTriggerHtml(item);
      html += '</div>';
      html += '<div class="sub">' + escapeHtml(item.kind) + (item.dateStr ? ' · ' + item.dateStr : '') + '</div></div>';
      html += '<div class="list-actions">';
      html += '<button type="button" data-action="copy-url">' + (item.isPrivate ? '私链' : '链接') + '</button>';
      html += '<button type="button" data-action="preview">预览</button>';
      html += '<button type="button" data-action="detail">详情</button>';
      if (hasToken) html += '<button type="button" data-action="delete">删除</button>';
      html += '</div>';
      if (hasToken) {
        html += '<input type="checkbox"' + (sel ? ' checked' : '') + ' style="accent-color:var(--accent)">';
      }
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  async function render(list) {
    const container = document.getElementById('mediaContainer');
    const stats = document.getElementById('stats');
    if (!container) return;

    rebuildDupIndex();
    updateCategoryCounts();

    if (category === 'dup' || category === 'similar') {
      const mode = category;
      const sets = mode === 'dup' ? exactSets : similarSets;

      if (mode === 'similar' && !similarLoaded && !similarLoading) {
        container.innerHTML = '<div class="scan-progress"><div>加载相似索引…</div></div>';
        void loadSimilarIndex(false);
        return;
      }
      if (mode === 'similar' && similarLoading) return;

      filtered = flattenSets(sets);
      if (mode === 'similar' && suspectSets.length) {
        filtered = filtered.concat(flattenSets(suspectSets));
      }
      if (stats) {
        const setLabel = mode === 'dup' ? '重复组' : '相似组';
        let statHtml = setLabel + ' <strong>' + sets.length + '</strong> · 共 <strong>' + filtered.length + '</strong> 张';
        if (mode === 'similar' && suspectSets.length) {
          statHtml += ' · 疑似 <strong>' + suspectSets.length + '</strong>';
        }
        stats.innerHTML = statHtml;
      }

      await ensurePrivateUrls(filtered);
      await ensureTagIds(filtered);
      container.innerHTML = renderDupGroups(sets, mode);

      updateSelUI();
      return;
    }

    filtered = list;
    if (stats) {
      stats.innerHTML = '显示 <strong>' + list.length + '</strong> / ' + ITEMS.length + ' 个文件';
    }

    if (!list.length) {
      container.innerHTML = '<div class="empty">' +
        (category === 'vault' ? '暂无私有文件 · 将敏感图放入仓库 private/ 目录' : '没有匹配结果') +
        '</div>';
      updateSelUI();
      return;
    }

    const priv = list.filter(i => i.isPrivate);
    if (priv.length) {
      container.innerHTML = '<div class="scan-progress"><div>加载私密资源…</div></div>';
      await ensurePrivateUrls(priv);
    }

    await ensureTagIds(list);
    container.innerHTML = viewMode === 'list' ? renderList(list) : renderGrid(list);
    updateSelUI();
  }

  /**
   * 主列表筛选入口：按 category / 关键词过滤 ITEMS → render()。
   * dup/similar 走专用 renderDupGroups 分支。
   */
  async function filter() {
    updateLoginGate();
    if (requireGalleryLogin() && !token()) {
      renderLoginGate();
      return;
    }
    const kw = (document.getElementById('q').value || '').trim().toLowerCase();
    let list = ITEMS;
    if (category === 'dup' || category === 'similar') {
      await render([]);
      return;
    }
    if (category === 'vault') {
      list = list.filter(i => i.isPrivate);
    } else if (category !== 'all') {
      list = list.filter(i => !i.isPrivate && i.kind === category);
    }
    if (kw) {
      list = list.filter(i =>
        i.name.toLowerCase().includes(kw) ||
        (i.oldRel && i.oldRel.toLowerCase().includes(kw)) ||
        (i.hash && i.hash.includes(kw)) ||
        i.newRel.toLowerCase().includes(kw) ||
        i.kind.includes(kw) ||
        i.ext.includes(kw)
      );
    }
    await render(sortList(list));
  }

  function itemByRel(rel) {
    return ITEMS.find(i => i.newRel === rel);
  }

  function formatBytes(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  const KIND_LABELS = {
    image: '图片', video: '视频', audio: '音频',
    document: '文档', text: '文本', other: '其他'
  };

  function kindLabel(kind) {
    return KIND_LABELS[kind] || kind || '未知';
  }

  function metaRowHtml(label, value, desc) {
    if (value == null || value === '') return '';
    return '<div class="meta-row">' +
      '<div class="meta-label">' + escapeHtml(label) + '</div>' +
      (desc ? '<div class="meta-desc">' + escapeHtml(desc) + '</div>' : '') +
      '<div class="meta-value">' + escapeHtml(String(value)) + '</div>' +
      '</div>';
  }

  function metaSectionHtml(title, rows) {
    const body = (rows || []).filter(Boolean).join('');
    if (!body) return '';
    return '<div class="detail-section"><h3>' + escapeHtml(title) + '</h3>' + body + '</div>';
  }

  function buildDetailMetaHtml(item) {
    const basic = [
      metaRowHtml('文件名', item.name, '仓库中的显示名称'),
      metaRowHtml(
        '类型',
        kindLabel(item.kind) + (item.ext ? ' · .' + item.ext : ''),
        '按扩展名识别的媒体类别'
      ),
      metaRowHtml(
        '可见性',
        item.isPrivate ? '私有' : '公开',
        item.isPrivate
          ? '登录 Gallery 可管理；可复制私链到其他设备（勿当公开 Markdown 推荐）'
          : '可通过 CDN / Raw 直链引用，适合写在 Markdown 中'
      ),
      metaRowHtml(
        '仓库路径',
        item.newRel,
        item.isPrivate ? '位于 private/ 私有目录' : '位于 images/ 公开图床目录'
      ),
      metaRowHtml(
        '文件大小',
        item.size ? formatBytes(item.size) : '—',
        item.size ? '最近一次同步或替换时记录的体积' : '尚未获取大小（替换或刷新后可能出现）'
      ),
      metaRowHtml(
        '拍摄 / 文件时间',
        item.dateStr || '未知',
        item.dateSource
          ? '来源：' + item.dateSource
          : '未能从文件名、旧路径或 Git 提交解析出时间'
      )
    ];

    const access = [];
    const mode = currentSourceMode();
    const share = shareUrlOf(item);
    access.push(metaRowHtml(
      '当前可复制链接（' + sourceModeLabel(mode) + '）',
      share,
      '随工具栏「源」菜单切换：CDN / Raw' + (item.isPrivate ? ' · 私链可多设备打开，不建议写进公开 Markdown' : ' · 适合 Markdown 与跨设备分享')
    ));
    if (item.isPrivate) {
      const viaProxy = !!securityCfg().privateProxyBase;
      access.push(metaRowHtml(
        'Gallery 预览',
        viaProxy ? '私有代理签名 URL' : '登录后 GitHub API Blob',
        '图库内缩略图/灯箱用此方式加载；复制给其他设备请用上方私链'
      ));
      access.push(metaRowHtml(
        '私链 · CDN',
        item.cdn,
        'jsDelivr 加速，公开仓下知道路径即可访问'
      ));
      access.push(metaRowHtml(
        '私链 · Raw',
        item.raw,
        'GitHub 原始地址，公开仓下知道路径即可访问'
      ));
    } else {
      access.push(metaRowHtml(
        'CDN 链接（jsDelivr）',
        item.cdn || '—',
        '推荐用于 Markdown 与站点引用，有缓存加速'
      ));
      access.push(metaRowHtml(
        'Raw 链接（GitHub）',
        item.raw || '—',
        'GitHub 原始文件地址，可作为 CDN 备选'
      ));
    }

    const tech = [];
    if (item.oldRel) {
      tech.push(metaRowHtml(
        '旧路径',
        item.oldRel,
        'rename-mapping 中记录的重命名前路径，用于日期回溯'
      ));
    }
    if (item.hash) {
      tech.push(metaRowHtml(
        '内容 Hash',
        item.hash,
        '从文件名解析的 32 位十六进制指纹，用于重复检测'
      ));
    }
    if (item.blobSha) {
      tech.push(metaRowHtml(
        'Git Blob SHA',
        item.blobSha,
        'GitHub 上该文件 blob 的完整 SHA'
      ));
    }
    if (item.commitSha) {
      tech.push(metaRowHtml(
        '最近提交',
        item.commitSha,
        '替换或写入后记录的 commit SHA'
      ));
    }
    if (item.dupCount > 1) {
      tech.push(metaRowHtml(
        '重复情况',
        '同 Hash 共 ' + item.dupCount + ' 个文件',
        '可在侧栏「重复」中查看同组并智能选中待删项'
      ));
    }
    if (item.rev) {
      tech.push(metaRowHtml(
        '本地修订标记',
        String(item.rev),
        '本会话内替换后用于刷新缓存的时间戳'
      ));
    }

    return metaSectionHtml('基础信息', basic) +
      metaSectionHtml('访问与链接', access) +
      metaSectionHtml('技术标识', tech);
  }

  async function openDetail(item) {
    const openingNew = !document.getElementById('appShell').classList.contains('detail-open') ||
      !detailItem || detailItem.newRel !== item.newRel;
    if (item.isPrivate) await ensurePrivateUrl(item);
    detailItem = item;
    document.getElementById('appShell').classList.add('detail-open');
    const url = srcOf(item);
    const preview = document.getElementById('detailPreview');
    const body = document.getElementById('detailBody');
    const actions = document.getElementById('detailActions');

    preview.innerHTML = '';
    if (item.kind === 'image') {
      const img = document.createElement('img');
      img.alt = item.name;
      img.src = url;
      preview.appendChild(img);
    } else {
      await fillNonImage(preview, item, url);
    }

    const tags = await tagsForItem(item);
    body.innerHTML = buildDetailMetaHtml(item) + buildTagEditorHtml(item, tags);

    const hasToken = !!token();
    const share = shareUrlOf(item);
    actions.innerHTML =
      '<button type="button" class="primary" data-action="copy-url">' +
      (item.isPrivate ? '复制私链' : '复制链接') + '</button>' +
      '<button type="button" data-action="copy-name">复制文件名</button>' +
      '<button type="button" data-action="fullscreen">全屏预览</button>' +
      '<a href="' + escapeAttr(share || url) + '" target="_blank" rel="noopener">新窗口</a>' +
      (hasToken
        ? '<button type="button" data-action="rename">重命名</button>' +
          '<button type="button" data-action="replace">替换</button>' +
          '<button type="button" class="danger" data-action="delete">删除</button>'
        : '');
    syncAppRoute(openingNew ? 'push' : 'replace');
  }

  function closeDetail(opts) {
    const had = !!detailItem;
    detailItem = null;
    document.getElementById('appShell').classList.remove('detail-open');
    if (had && (!opts || opts.sync !== false)) syncAppRoute((opts && opts.mode) || 'push');
  }

  function findGroupContaining(item) {
    if (!item) return null;
    const pools = [];
    if (category === 'dup') pools.push(...exactSets);
    else if (category === 'similar') {
      pools.push(...similarSets);
      pools.push(...suspectSets);
    } else {
      pools.push(...exactSets, ...similarSets, ...suspectSets);
    }
    return pools.find(g => g.items && g.items.some(i => i.newRel === item.newRel)) || null;
  }

  /** 灯箱左右键导航用的列表：优先 lbNavPool（同组），否则 filtered */
  function lightboxNavList() {
    if (lbNavPool && lbNavPool.length) return lbNavPool;
    return filtered;
  }

  function currentLightboxItem() {
    if (lbMode === 'compare') return lbCompareLeft;
    const list = lightboxNavList();
    return list[lightboxIdx] || null;
  }

  function closeLbInfo(opts) {
    const was = lbInfoOpen;
    lbInfoOpen = false;
    const panel = document.getElementById('lightboxInfo');
    const lb = document.getElementById('lightbox');
    if (panel) panel.hidden = true;
    if (lb) lb.classList.remove('info-open');
    if (was && (!opts || opts.sync !== false)) syncAppRoute('replace');
  }

  async function renderLbInfo(item) {
    const body = document.getElementById('lightboxInfoBody');
    const actions = document.getElementById('lightboxInfoActions');
    const title = document.getElementById('lightboxInfoTitle');
    if (!body || !actions) return;
    if (!item) {
      if (title) title.textContent = '详情';
      body.innerHTML = '<div class="lb-info-empty">暂无选中文件</div>';
      actions.innerHTML = '';
      return;
    }
    if (item.isPrivate) await ensurePrivateUrl(item);
    if (title) title.textContent = item.name;
    const tags = await tagsForItem(item);
    body.innerHTML = buildDetailMetaHtml(item) + buildTagEditorHtml(item, tags);
    const hasToken = !!token();
    const share = shareUrlOf(item);
    actions.innerHTML =
      '<button type="button" class="primary" data-lb-info-action="copy-url">' +
      (item.isPrivate ? '复制私链' : '复制链接') + '</button>' +
      '<button type="button" data-lb-info-action="copy-name">复制文件名</button>' +
      '<a href="' + escapeAttr(share) + '" target="_blank" rel="noopener">新窗口</a>' +
      (hasToken
        ? '<button type="button" data-lb-info-action="rename">重命名</button>' +
          '<button type="button" data-lb-info-action="replace">替换</button>' +
          '<button type="button" class="danger" data-lb-info-action="delete">删除</button>'
        : '');
  }

  async function openLbInfo(item) {
    const target = item || currentLightboxItem();
    if (!target) return;
    lbInfoOpen = true;
    const panel = document.getElementById('lightboxInfo');
    const lb = document.getElementById('lightbox');
    if (panel) panel.hidden = false;
    if (lb) lb.classList.add('info-open');
    await renderLbInfo(target);
    syncAppRoute('replace');
  }

  async function toggleLbInfo() {
    if (lbInfoOpen) closeLbInfo();
    else await openLbInfo();
  }

  async function syncLbInfoIfOpen() {
    if (!lbInfoOpen) return;
    await renderLbInfo(currentLightboxItem());
  }

  function destroyLbZoom() {
    lbZoomControllers.forEach(c => c.destroy && c.destroy());
    lbZoomControllers = [];
  }

  function attachZoomPane(wrap, mediaEl) {
    let scale = 1;
    let tx = 0;
    let ty = 0;
    let dragging = false;
    let didPan = false;
    let suppressClick = false;
    let lastX = 0;
    let lastY = 0;
    let startX = 0;
    let startY = 0;
    let activePointerId = null;

    function apply() {
      mediaEl.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
      wrap.classList.toggle('dragging', dragging);
      wrap.style.cursor = scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'default';
    }

    function reset() {
      scale = 1;
      tx = 0;
      ty = 0;
      apply();
    }

    function onWheel(e) {
      if (mediaEl.tagName !== 'IMG') return;
      e.preventDefault();
      e.stopPropagation();
      const rect = wrap.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const next = Math.min(8, Math.max(1, scale * factor));
      if (next === scale) return;
      const ox = (mx - rect.width / 2 - tx) / scale;
      const oy = (my - rect.height / 2 - ty) / scale;
      scale = next;
      if (scale <= 1.001) {
        scale = 1;
        tx = 0;
        ty = 0;
      } else {
        tx = mx - rect.width / 2 - ox * scale;
        ty = my - rect.height / 2 - oy * scale;
      }
      apply();
    }

    function onPointerDown(e) {
      if (mediaEl.tagName !== 'IMG' || scale <= 1) return;
      if (e.button != null && e.button !== 0) return;
      // Only start pan when gesture begins on the media, not empty padding.
      if (e.target !== mediaEl && !mediaEl.contains(e.target)) return;
      dragging = true;
      didPan = false;
      activePointerId = e.pointerId;
      startX = lastX = e.clientX;
      startY = lastY = e.clientY;
      apply();
    }

    function onPointerMove(e) {
      if (!dragging) return;
      if (activePointerId != null && e.pointerId !== activePointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!didPan && (dx * dx + dy * dy) > 9) {
        didPan = true;
        suppressClick = true;
        try { wrap.setPointerCapture && wrap.setPointerCapture(e.pointerId); } catch (_) {}
      }
      if (!didPan) return;
      tx += e.clientX - lastX;
      ty += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      apply();
    }

    function onPointerUp(e) {
      if (!dragging) return;
      if (activePointerId != null && e.pointerId !== activePointerId) return;
      dragging = false;
      activePointerId = null;
      if (didPan) suppressClick = true;
      try { wrap.releasePointerCapture && wrap.releasePointerCapture(e.pointerId); } catch (_) {}
      apply();
    }

    function onDblClick(e) {
      if (mediaEl.tagName !== 'IMG') return;
      e.preventDefault();
      if (scale > 1) reset();
      else {
        const rect = wrap.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        scale = 2.5;
        const ox = (mx - rect.width / 2) / 1;
        const oy = (my - rect.height / 2) / 1;
        tx = mx - rect.width / 2 - ox * scale;
        ty = my - rect.height / 2 - oy * scale;
        apply();
      }
    }

    function onClick(e) {
      // After pan, browser often fires click on .lb-zoom (not <img>) because of
      // pointer capture — swallow that one click so lightbox does not close.
      if (suppressClick) {
        e.stopPropagation();
        e.preventDefault();
        suppressClick = false;
        didPan = false;
        return;
      }
      // Clicking the media itself must not close; empty .lb-zoom padding may close.
      if (e.target === mediaEl || mediaEl.contains(e.target)) {
        e.stopPropagation();
      }
    }

    wrap.addEventListener('wheel', onWheel, { passive: false });
    wrap.addEventListener('pointerdown', onPointerDown);
    wrap.addEventListener('pointermove', onPointerMove);
    wrap.addEventListener('pointerup', onPointerUp);
    wrap.addEventListener('pointercancel', onPointerUp);
    wrap.addEventListener('dblclick', onDblClick);
    wrap.addEventListener('click', onClick);
    apply();

    const ctrl = {
      reset,
      destroy() {
        wrap.removeEventListener('wheel', onWheel);
        wrap.removeEventListener('pointerdown', onPointerDown);
        wrap.removeEventListener('pointermove', onPointerMove);
        wrap.removeEventListener('pointerup', onPointerUp);
        wrap.removeEventListener('pointercancel', onPointerUp);
        wrap.removeEventListener('dblclick', onDblClick);
        wrap.removeEventListener('click', onClick);
      }
    };
    lbZoomControllers.push(ctrl);
    return ctrl;
  }

  /**
   * 非图片类预览渲染（灯箱 .lb-zoom 与侧栏 #detailPreview 共用）。
   * video/audio/document/text 各走对应 DOM；other 显示友好降级面板。
   */
  async function fillNonImage(container, item, url) {
    const openUrl = shareUrlOf(item) || url;
    if (item.kind === 'video') {
      const v = document.createElement('video');
      v.src = url;
      v.controls = true;
      v.playsInline = true;
      v.autoplay = true;
      container.appendChild(v);
      return;
    }
    if (item.kind === 'audio') {
      const wrap = document.createElement('div');
      wrap.className = 'media-audio-wrap';
      wrap.innerHTML = '<div class="media-audio-icon">' + TYPE_ICONS.audio + '</div>';
      const a = document.createElement('audio');
      a.src = url;
      a.controls = true;
      a.autoplay = true;
      a.style.width = 'min(92vw, 480px)';
      wrap.appendChild(a);
      container.appendChild(wrap);
      return;
    }
    if (item.kind === 'document') {
      const iframe = document.createElement('iframe');
      iframe.src = url;
      iframe.className = 'lightbox-media-fallback';
      iframe.title = item.name;
      container.appendChild(iframe);
      return;
    }
    if (item.kind === 'text') {
      const isMd = item.ext === 'md' || item.ext === 'markdown';
      const wrap = document.createElement('div');
      wrap.className = isMd ? 'lightbox-text lightbox-md' : 'lightbox-text';
      wrap.textContent = '加载中…';
      container.appendChild(wrap);
      try {
        const fetchUrl = textFetchUrl(item, url);
        const res = await fetch(fetchUrl);
        if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
        const text = await res.text();
        const clipped = text.length > 50000 ? text.slice(0, 50000) + '\n\n…(已截断)' : text;
        if (isMd) {
          wrap.innerHTML = renderSimpleMarkdown(clipped);
        } else {
          wrap.textContent = clipped;
        }
      } catch (e) {
        wrap.textContent = '无法加载文本: ' + e.message;
      }
      return;
    }
    const div = document.createElement('div');
    div.className = 'lightbox-text media-fallback-wrap';
    const extLabel = item.ext ? ('.' + item.ext) : '无扩展名';
    const kindLabel = item.kind === 'other' ? '暂不支持在线预览' : (item.kind || '文件');
    div.innerHTML =
      '<div class="media-fallback-icon">' + (TYPE_ICONS[item.kind] || TYPE_ICONS.other) + '</div>' +
      '<div class="media-fallback-title">' + escapeHtml(item.name) + '</div>' +
      '<div class="media-fallback-sub">当前格式（' + escapeHtml(extLabel) + '）无法在浏览器内直接预览。<br>' +
      escapeHtml(kindLabel) + ' · 可下载后用本地软件打开，或点下方在新窗口尝试打开。</div>' +
      '<div class="media-fallback-actions">' +
      '<a class="primary" href="' + escapeAttr(openUrl) + '" target="_blank" rel="noopener">新窗口打开</a>' +
      '<a href="' + escapeAttr(openUrl) + '" download="' + escapeAttr(item.name) + '">下载文件</a>' +
      '</div>';
    container.appendChild(div);
  }

  function buildLbPane(item, label) {
    const pane = document.createElement('div');
    pane.className = 'lb-pane';
    if (label) {
      const lab = document.createElement('div');
      lab.className = 'lb-pane-label';
      lab.textContent = label;
      pane.appendChild(lab);
    }
    const zoom = document.createElement('div');
    zoom.className = 'lb-zoom';
    pane.appendChild(zoom);
    const url = srcOf(item);
    if (item.kind === 'image') {
      const img = document.createElement('img');
      img.src = url;
      img.alt = item.name;
      zoom.appendChild(img);
      attachZoomPane(zoom, img);
    } else {
      fillNonImage(zoom, item, url);
    }
    return pane;
  }

  function renderLbToolbar() {
    const caption = document.getElementById('lightboxCaption');
    const actions = document.getElementById('lightboxActions');
    const toolbar = document.querySelector('.lightbox-toolbar');
    if (toolbar) toolbar.style.display = lbFullscreen ? 'none' : '';
    if (!caption || !actions) return;
    if (lbFullscreen) {
      actions.innerHTML = '';
      caption.textContent = '';
      return;
    }
    actions.innerHTML = '';

    if (lbMode === 'compare' && lbCompareLeft && lbCompareRight) {
      caption.textContent = lbCompareLeft.name + '  ↔  ' + lbCompareRight.name;
    } else {
      const cur = lightboxNavList()[lightboxIdx];
      caption.textContent = cur ? cur.name : '';
    }

    function addBtn(text, cls, fn) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      if (cls) b.className = cls;
      b.onclick = e => { e.stopPropagation(); fn(); };
      actions.appendChild(b);
      return b;
    }

    const active = lbMode === 'compare'
      ? lbCompareLeft
      : (lightboxNavList()[lightboxIdx] || null);
    const previewUrl = active ? srcOf(active) : '';
    const shareUrl = active ? shareUrlOf(active) : '';
    const hasToken = !!token();

    addBtn('关闭', '', closeLightbox);

    if (lbMode === 'single' && active && supportsLbFullscreen(active)) {
      addBtn('全屏', 'primary', () => {
        closeLbInfo({ sync: false });
        lbFullscreen = true;
        renderLightboxStage();
        syncAppRoute('replace');
      });
    }

    if (active && active.kind === 'image') {
      addBtn('复位缩放', '', () => lbZoomControllers.forEach(c => c.reset && c.reset()));
    }

    if (active) {
      if (!lbInfoOpen) {
        addBtn(active.isPrivate ? '复制私链' : '复制链接', 'primary', () => {
          void copyItemLink(active);
        });
        if (!active.isPrivate) {
          addBtn('复制 Markdown', '', () => {
            navigator.clipboard.writeText('![' + active.name + '](' + shareUrl + ')');
            setStatus('已复制 Markdown（' + sourceModeLabel(currentSourceMode()) + '）', 'ok');
          });
        }
        addBtn('复制文件名', '', () => {
          navigator.clipboard.writeText(active.name);
          setStatus('已复制文件名', 'ok');
        });
        addBtn('新窗口', '', () => {
          const openUrl = shareUrl || previewUrl;
          if (!openUrl) { setStatus('链接未就绪', 'err'); return; }
          window.open(openUrl, '_blank', 'noopener');
        });
      }
      addBtn(lbInfoOpen ? '收起详情' : '详情', lbInfoOpen ? 'primary' : '', () => {
        void toggleLbInfo().then(() => renderLbToolbar());
      });
      if (!lbInfoOpen && hasToken && lbMode === 'single') {
        addBtn('重命名', '', () => {
          handleAction('rename', active.newRel);
        });
        addBtn('替换', '', () => {
          handleAction('replace', active.newRel);
        });
      }
      if (!lbInfoOpen && hasToken) {
        addBtn('删除', 'danger', () => {
          deleteOne(active.newRel)
            .then(() => {
              if (lbMode === 'compare') closeLightbox();
              else {
                const list = lightboxNavList().filter(i => i.newRel !== active.newRel);
                if (lbNavPool) lbNavPool = list;
                void filter().then(() => {
                  if (!list.length) {
                    closeLightbox();
                    return;
                  }
                  lightboxIdx = Math.min(lightboxIdx, list.length - 1);
                  void renderLightboxStage();
                });
              }
            })
            .catch(err => setStatus('删除失败: ' + err.message, 'err'));
        });
      }
    }

    if (lbMode === 'compare') {
      addBtn('退出对比', 'primary', () => {
        const keep = lbCompareLeft;
        lbMode = 'single';
        lbCompareLeft = null;
        lbCompareRight = null;
        lbComparePool = [];
        if (keep) openLightbox(keep);
        else closeLightbox();
      });
    }
  }

  function renderCompareThumbs(pane) {
    if (lbComparePool.length <= 2) return;
    const row = document.createElement('div');
    row.className = 'lb-thumbs';
    lbComparePool.forEach(it => {
      if (it.newRel === lbCompareLeft.newRel) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lb-thumb' + (it.newRel === lbCompareRight.newRel ? ' active' : '');
      const img = document.createElement('img');
      img.src = srcOf(it);
      img.alt = it.name;
      btn.appendChild(img);
      btn.title = it.name;
      btn.onclick = e => {
        e.stopPropagation();
        lbCompareRight = it;
        renderLightboxStage();
      };
      row.appendChild(btn);
    });
    pane.appendChild(row);
  }

  async function renderLightboxStage() {
    const lb = document.getElementById('lightbox');
    const view = document.getElementById('lightboxView');
    const exitBtn = document.getElementById('lightboxExit');
    if (!lb || !view) return;
    destroyLbZoom();
    view.innerHTML = '';
    view.classList.toggle('compare', lbMode === 'compare');
    lb.classList.toggle('compare-mode', lbMode === 'compare');
    lb.classList.toggle('fullscreen-mode', lbFullscreen);
    const compareNavable = lbMode === 'compare' &&
      lbComparePool.filter(i => !lbCompareLeft || i.newRel !== lbCompareLeft.newRel).length > 1;
    lb.classList.toggle('compare-navable', compareNavable);
    if (exitBtn) exitBtn.hidden = !lbFullscreen;

    if (lbMode === 'compare') {
      lbFullscreen = false;
      lb.classList.remove('fullscreen-mode');
      if (exitBtn) exitBtn.hidden = true;
    }

    if (lbMode === 'compare' && lbCompareLeft && lbCompareRight) {
      await ensurePrivateUrls([lbCompareLeft, lbCompareRight]);
      const leftPane = buildLbPane(lbCompareLeft, '左');
      const rightPane = buildLbPane(lbCompareRight, '右');
      renderCompareThumbs(rightPane);
      view.appendChild(leftPane);
      view.appendChild(rightPane);
    } else {
      const list = lightboxNavList();
      const item = list[lightboxIdx];
      if (!item) {
        closeLightbox();
        return;
      }
      if (item.isPrivate) await ensurePrivateUrl(item);
      view.appendChild(buildLbPane(item, null));
    }
    renderLbToolbar();
    void syncLbInfoIfOpen();
  }

  /**
   * 打开单图灯箱。若来自相似/重复组则设置 lbNavPool 使 ←/→ 只在组内切换。
   * @param {object} pool 可选，显式指定导航列表（对比模式传入组内 items）
   */
  function openLightbox(item, fullscreen, pool) {
    closeDetail({ sync: false });
    lbMode = 'single';
    lbFullscreen = !!fullscreen;
    lbCompareLeft = null;
    lbCompareRight = null;
    lbComparePool = [];
    const group = (!pool || !pool.length) ? findGroupContaining(item) : null;
    if (pool && pool.length) {
      lbNavPool = pool.slice();
    } else if (group && group.items && group.items.length > 1) {
      lbNavPool = group.items.slice();
    } else {
      lbNavPool = null;
    }
    const list = lightboxNavList();
    lightboxIdx = list.findIndex(i => i.newRel === item.newRel);
    if (lightboxIdx < 0) {
      lbNavPool = [item];
      lightboxIdx = 0;
    }
    document.getElementById('lightbox').classList.add('open');
    void renderLightboxStage();
    syncAppRoute('push');
  }

  function openLightboxFullscreen(item) {
    openLightbox(item, true);
  }

  function openCompare(left, right, pool) {
    if (!left || !right) return;
    closeDetail({ sync: false });
    lbMode = 'compare';
    lbFullscreen = false;
    lbCompareLeft = left;
    lbCompareRight = right;
    lbComparePool = (pool && pool.length ? pool : [left, right]).slice();
    lbNavPool = lbComparePool.slice();
    lightboxIdx = lbNavPool.findIndex(i => i.newRel === left.newRel);
    document.getElementById('lightbox').classList.add('open');
    renderLightboxStage();
    syncAppRoute('push');
  }

  function openGroupCompare(group) {
    if (!group || !group.items || group.items.length < 2) return;
    const keep = itemByRel(group.keepRel) || group.items[group.items.length - 1];
    const other = group.items.find(i => i.newRel !== keep.newRel) || group.items[0];
    openCompare(keep, other, group.items);
  }

  function openSelectedCompare() {
    const rels = [...selected];
    if (rels.length !== 2) {
      setStatus('请恰好选中 2 张图再对比', 'err');
      return;
    }
    const a = itemByRel(rels[0]);
    const b = itemByRel(rels[1]);
    if (!a || !b) return;
    openCompare(a, b, [a, b]);
  }

  /** 关闭灯箱并 syncAppRoute，回到当前菜单列表 hash */
  function closeLightbox(opts) {
    destroyLbZoom();
    closeLbInfo({ sync: false });
    const lb = document.getElementById('lightbox');
    lb.classList.remove('open');
    lb.classList.remove('compare-mode');
    lb.classList.remove('fullscreen-mode');
    lb.classList.remove('info-open');
    const exitBtn = document.getElementById('lightboxExit');
    if (exitBtn) exitBtn.hidden = true;
    const view = document.getElementById('lightboxView');
    if (view) {
      view.innerHTML = '';
      view.classList.remove('compare');
    }
    const cap = document.getElementById('lightboxCaption');
    if (cap) cap.textContent = '';
    const actions = document.getElementById('lightboxActions');
    if (actions) actions.innerHTML = '';
    lightboxIdx = -1;
    lbMode = 'single';
    lbFullscreen = false;
    lbCompareLeft = null;
    lbCompareRight = null;
    lbComparePool = [];
    lbNavPool = null;
    if (!opts || opts.sync !== false) syncAppRoute((opts && opts.mode) || 'push');
  }

  /**
   * 灯箱 ←/→：单图模式在 lightboxNavList 内循环；对比模式切换右侧候选图。
   */
  function lightboxNav(dir) {
    if (lbMode === 'compare') {
      const pool = lbComparePool.filter(i => i.newRel !== lbCompareLeft.newRel);
      if (pool.length < 2) return;
      const idx = pool.findIndex(i => i.newRel === lbCompareRight.newRel);
      const next = pool[(Math.max(0, idx) + dir + pool.length) % pool.length];
      if (!next) return;
      lbCompareRight = next;
      void renderLightboxStage();
      syncAppRoute('replace');
      return;
    }
    const list = lightboxNavList();
    if (!list.length) return;
    lightboxIdx = (lightboxIdx + dir + list.length) % list.length;
    void renderLightboxStage();
    syncAppRoute('replace');
  }

  function handleAction(action, rel) {
    const item = itemByRel(rel);
    if (!item) return;

    if (action === 'copy-url') {
      void copyItemLink(item);
    } else if (action === 'copy-name') {
      navigator.clipboard.writeText(item.name);
      setStatus('已复制文件名', 'ok');
    } else if (action === 'preview') {
      openLightbox(item, false);
    } else if (action === 'detail') {
      void openDetail(item);
    } else if (action === 'fullscreen') {
      openLightboxFullscreen(item);
    } else if (action === 'delete') {
      deleteOne(rel).catch(err => setStatus('删除失败: ' + err.message, 'err'));
    } else if (action === 'rename') {
      const prefix = relPrefix(rel);
      const cur = rel.slice(prefix.length);
      const newName = prompt('新文件名（' + prefix + ' 下）', cur);
      if (!newName || newName === cur) return;
      setStatus('重命名中…');
      const wasOpen = document.getElementById('lightbox')?.classList.contains('open');
      renameFile(rel, newName)
        .then(() => {
          void filter();
          setStatus('重命名成功', 'ok');
          if (wasOpen) {
            const next = itemByRel(prefix + newName.replace(/^(images|private)\//, ''));
            if (next) openLightbox(next, lbFullscreen);
            else closeLightbox();
          }
        })
        .catch(err => setStatus('重命名失败: ' + err.message, 'err'));
    } else if (action === 'replace') {
      const input = document.getElementById('replaceInput');
      input.dataset.target = rel;
      input.dataset.fromLightbox = document.getElementById('lightbox')?.classList.contains('open') ? '1' : '';
      input.click();
    }
  }

  async function refreshFromGitHub(silent) {
    if (requireGalleryLogin() && !token()) {
      ITEMS = [];
      updateCategoryCounts();
      void filter();
      if (!silent) setStatus('请先登录以同步图库', 'err');
      return;
    }
    const prev = ITEMS.length;
    if (!silent) setStatus('正在从 GitHub 同步…');
    try {
      await fetchRepoHead();
      await fetchOldMapFromRemote();
      const paths = await fetchRemotePaths();
      const prevMeta = new Map(ITEMS.map(i => [i.newRel, i]));
      ITEMS = paths.map(p => {
        const item = buildItemFromPath(p.path, OLD_MAP[p.path]);
        item.blobSha = p.sha;
        const old = prevMeta.get(item.newRel);
        if (old && old.rev) item.rev = old.rev;
        if (old && old.embedding && old.blobSha === p.sha) {
          item.embedding = old.embedding;
          item.embeddingKey = old.embeddingKey;
        }
        if (old && old.phash && old.blobSha === p.sha) {
          item.phash = old.phash;
        }
        return item;
      });
      await enrichDatesFromGit(ITEMS);
      similarLoaded = false;
      similarSets = [];
      suspectSets = [];
      scanMeta = null;
      similarIndexRaw = null;
      autoSmartSelected = false;
      rebuildDupIndex();
      updateCategoryCounts();
      clearAllSelections();
      if (token()) {
        try { await loadTagsEnvelope(); } catch (_) { /* ignore */ }
        await ensureTagIds(ITEMS);
      }
      await filter();
      if (routeReady) await applyRouteFromHash();
      if (!silent) setStatus('已同步 ' + ITEMS.length + ' 个文件', 'ok');
      else if (prev !== ITEMS.length) setStatus('已自动同步 ' + ITEMS.length + ' 个文件', 'ok');
      else setStatus('');
    } catch (e) {
      rebuildDupIndex();
      updateCategoryCounts();
      await filter();
      if (ITEMS.length) setStatus('在线同步失败，显示缓存 ' + ITEMS.length + ' 个', 'err');
      else setStatus('加载失败: ' + e.message, 'err');
    }
  }

  async function renameFile(oldRel, newName) {
    const prefix = relPrefix(oldRel);
    newName = newName.trim().replace(/^(images|private)\//, '').replace(/\\/g, '/');
    if (!newName || newName.includes('/')) throw new Error('新文件名无效');
    const newRel = prefix + newName;
    if (newRel === oldRel) return;
    const meta = await getFileMeta(oldRel);
    await putFile(newRel, meta.content, null, 'gallery: rename to ' + newRel);
    await deleteFile(oldRel, meta.sha, 'gallery: remove old after rename ' + oldRel);
    if (OLD_MAP[oldRel]) {
      OLD_MAP[newRel] = OLD_MAP[oldRel];
      delete OLD_MAP[oldRel];
    } else {
      OLD_MAP[newRel] = oldRel;
    }
    addRenameLink(oldRel, newRel);
    const prev = ITEMS.find(i => i.newRel === oldRel);
    const idx = ITEMS.findIndex(i => i.newRel === oldRel);
    if (idx >= 0) {
      ITEMS[idx] = buildItemFromPath(newRel, OLD_MAP[newRel]);
      if (!ITEMS[idx].date && prev && prev.date) {
        ITEMS[idx].date = prev.date;
        ITEMS[idx].dateStr = prev.dateStr;
        ITEMS[idx].dateSource = (prev.dateSource || '文件名') + ' · 重命名继承';
      }
    }
    migrateSelectionRel(oldRel, newRel);
    if (detailItem && detailItem.newRel === oldRel) detailItem = ITEMS[idx];
    rebuildDupIndex();
    try {
      if (tagsUnlocked) await migrateItemTags(oldRel, newRel);
      tagIdCache.delete(oldRel);
      await ensureTagIds([ITEMS[idx]].filter(Boolean));
    } catch (_) { /* tag migrate best-effort */ }
  }

  async function replaceFile(rel, file) {
    const content = await fileToBase64(file);
    const result = await putFileViaGit(rel, content, 'gallery: replace ' + rel);

    const newSha = result && result.content && result.content.sha;
    const commitSha = result && result.commitSha;
    bumpRepoHead(commitSha);
    const name = rel.slice(relPrefix(rel).length);
    const idx = ITEMS.findIndex(i => i.newRel === rel);
    if (idx >= 0) {
      const oldRel = ITEMS[idx].oldRel;
      ITEMS[idx] = buildItemFromPath(rel, oldRel);
      ITEMS[idx].blobSha = newSha;
      ITEMS[idx].commitSha = commitSha;
      ITEMS[idx].rev = Date.now();
      ITEMS[idx].size = file.size;
    }
    rebuildDupIndex();
    return ITEMS[idx];
  }

  async function deleteOne(rel) {
    if (!token()) throw new Error('请先 GitHub 登录');
    if (!confirm('确认删除？\n' + rel + '\n此操作不可恢复。')) return false;
    setStatus('删除中…');
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const meta = await getFileMeta(rel);
        await deleteFile(rel, meta.sha);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (!/does not match|409/i.test(e.message) || attempt === 4) throw e;
        await sleep(400 * (attempt + 1));
      }
    }
    if (lastErr) throw lastErr;
    ITEMS = ITEMS.filter(x => x.newRel !== rel);
    pruneSelectionMemory(rel);
    if (detailItem && detailItem.newRel === rel) closeDetail();
    rebuildDupIndex();
    void filter();
    setStatus('已删除 ' + rel.slice(relPrefix(rel).length), 'ok');
    return true;
  }

  async function batchDelete() {
    const rels = [...selected];
    if (!rels.length) return;
    const preview = rels.slice(0, 8).map(r => '· ' + r.slice(7)).join('\n');
    const extra = rels.length > 8 ? '\n…等共 ' + rels.length + ' 个文件' : '';
    const warn = (category === 'similar' || category === 'dup')
      ? '\n\n⚠ 来自重复/相似分组，请确认保留项无误。'
      : '';
    if (!confirm('确认删除 ' + rels.length + ' 个文件？此操作不可恢复。' + warn + '\n\n' + preview + extra)) return;
    setStatus('删除中 0/' + rels.length + '…');
    let ok = 0;
    for (let i = 0; i < rels.length; i++) {
      const rel = rels[i];
      try {
        const meta = await getFileMeta(rel);
        await deleteFile(rel, meta.sha);
        ITEMS = ITEMS.filter(x => x.newRel !== rel);
        pruneSelectionMemory(rel);
        ok++;
        setStatus('删除中 ' + ok + '/' + rels.length + '…');
      } catch (e) {
        setStatus('删除失败 ' + rel + ': ' + e.message, 'err');
        break;
      }
    }
    rebuildDupIndex();
    void filter();
    setStatus(ok === rels.length ? '已删除 ' + ok + ' 个文件' : '部分完成 ' + ok + '/' + rels.length,
      ok === rels.length ? 'ok' : 'err');
  }

  function showAuthUI() {
    const loggedIn = !!token();
    const user = sessionStorage.getItem(AUTH_USER_KEY);
    const avatar = sessionStorage.getItem(AUTH_AVATAR_KEY);
    const manageBar = document.getElementById('manageBar');
    const loginRow = document.getElementById('loginRow');
    const loggedRow = document.getElementById('loggedRow');
    const patRow = document.getElementById('patRow');
    const st = document.getElementById('patStatus');
    const userLabel = document.getElementById('authUser');
    const authAvatar = document.getElementById('authAvatar');

    if (loggedIn) {
      if (manageBar) { manageBar.classList.remove('hidden'); manageBar.style.display = 'flex'; }
      if (loginRow) loginRow.classList.add('hidden');
      if (loggedRow) loggedRow.classList.remove('hidden');
      if (userLabel) userLabel.textContent = user ? '@' + user : '已授权';
      if (authAvatar) authAvatar.src = avatar || SITE_APPLE_ICON;
      updateSiteBranding(avatar, user || REPO.owner);
      if (st) st.textContent = '';
      if (patRow) patRow.classList.add('hidden');
    } else {
      if (manageBar) manageBar.classList.add('hidden');
      if (loginRow) loginRow.classList.remove('hidden');
      if (loggedRow) loggedRow.classList.add('hidden');
      updateSiteBranding(null, REPO.owner);
      if (st) {
        st.textContent = requireGalleryLogin()
          ? '登录后查看图库列表与私有文件'
          : (oauthClientId() ? '已登录 GitHub 时一键授权' : '登录后可删除、重命名与替换');
      }
    }
    updateLoginGate();
  }

  /** 注册 DOM 事件：搜索/排序/菜单/卡片点击/灯箱/标签编辑/popstate 路由等 */
  function bindEvents() {
    let searchRouteTimer = null;
    document.getElementById('q').oninput = () => {
      void filter();
      clearTimeout(searchRouteTimer);
      searchRouteTimer = setTimeout(() => syncAppRoute('replace'), 250);
    };
    document.getElementById('source').onchange = () => {
      void filter();
      if (detailItem) void openDetail(detailItem);
      const lb = document.getElementById('lightbox');
      if (lb && lb.classList.contains('open')) {
        renderLbToolbar();
        void syncLbInfoIfOpen();
      }
    };
    document.getElementById('sort').onchange = e => {
      sortBy = e.target.value;
      void filter().then(() => syncAppRoute('replace'));
    };

    if (location.protocol !== 'file:') {
      const localOpt = document.querySelector('#source option[value="local"]');
      if (localOpt) localOpt.remove();
    }

    document.querySelectorAll('.nav-item[data-cat]').forEach(btn => {
      btn.onclick = () => switchCategory(btn.dataset.cat, 'push');
    });

    document.getElementById('viewGrid').onclick = () => {
      setViewModeUI('grid');
      void filter().then(() => syncAppRoute('replace'));
    };
    document.getElementById('viewList').onclick = () => {
      setViewModeUI('list');
      void filter().then(() => syncAppRoute('replace'));
    };

    window.addEventListener('popstate', () => {
      if (!routeReady) return;
      void applyRouteFromHash();
    });
    window.addEventListener('hashchange', () => {
      if (!routeReady || routeQuiet) return;
      void applyRouteFromHash();
    });

    document.getElementById('mediaContainer').addEventListener('click', e => {
      const dupBtn = e.target.closest('[data-dup-action]');
      if (dupBtn) {
        e.stopPropagation();
        const action = dupBtn.dataset.dupAction;
        const sets = getSetsForCategory();
        if (action === 'smart-select') {
          const sets = getSetsForCategory();
          const count = sets.reduce((n, g) => n + g.items.filter(i => i.newRel !== g.keepRel).length, 0);
          if (count && !confirm('将智能选中 ' + count + ' 张较旧副本（每组保留最新一张）。确认？')) return;
          smartSelectGroups(sets, true);
          void filter();
        } else if (action === 'clear-select') {
          sets.forEach(g => g.items.forEach(i => selected.delete(i.newRel)));
          updateSelUI();
          void filter();
        } else if (action === 'rescan') {
          autoSmartSelected = false;
          loadSimilarIndex(true);
        } else if (action === 'compare-selected') {
          openSelectedCompare();
        }
        return;
      }

      const suspectHead = e.target.closest('[data-suspect-toggle]');
      if (suspectHead) {
        e.stopPropagation();
        suspectExpanded = !suspectExpanded;
        void filter();
        return;
      }

      const toggleHead = e.target.closest('[data-group-toggle]');
      if (toggleHead && !e.target.closest('[data-group-action]')) {
        const gid = toggleHead.dataset.groupToggle;
        if (collapsedGroups.has(gid)) collapsedGroups.delete(gid);
        else collapsedGroups.add(gid);
        void filter();
        return;
      }

      const groupBtn = e.target.closest('[data-group-action]');
      if (groupBtn) {
        e.stopPropagation();
        const g = findGroupById(groupBtn.dataset.groupId);
        if (!g) return;
        if (groupBtn.dataset.groupAction === 'compare') {
          openGroupCompare(g);
          return;
        }
        if (groupBtn.dataset.groupAction === 'smart') {
          g.items.forEach(i => selected.delete(i.newRel));
          g.items.forEach(i => {
            if (i.newRel !== g.keepRel) selected.add(i.newRel);
          });
          updateSelUI();
        } else if (groupBtn.dataset.groupAction === 'all') {
          g.items.forEach(i => selected.add(i.newRel));
          updateSelUI();
        }
        void filter();
        return;
      }

      const actionBtn = e.target.closest('[data-action]');
      const tagEditBtn = e.target.closest('[data-action="tag-edit"]');
      const card = e.target.closest('[data-rel]');
      if (!card) return;
      const rel = card.dataset.rel;
      const item = itemByRel(rel);

      if (tagEditBtn) {
        e.stopPropagation();
        if (item) void openTagEditorForItem(item, tagEditBtn);
        return;
      }

      if (actionBtn) {
        e.stopPropagation();
        handleAction(actionBtn.dataset.action, rel);
        return;
      }

      const cb = e.target.closest('input[type=checkbox]');
      if (cb) {
        e.stopPropagation();
        toggleSelect(rel, cb.checked);
        if (category === 'dup' || category === 'similar') void filter();
        else card.classList.toggle('selected', cb.checked);
        return;
      }

      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        toggleSelect(rel, !selected.has(rel));
        void filter();
        return;
      }

      if (e.detail >= 2 && item) {
        focused = item.name;
        void openDetail(item);
        return;
      }

      if (item && canLightboxPreview(item)) {
        openLightbox(item, false);
        return;
      }

      focused = item.name;
      void openDetail(item);
    });

    document.getElementById('detailClose').onclick = closeDetail;

    document.getElementById('detailActions').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn || !detailItem) return;
      handleAction(btn.dataset.action, detailItem.newRel);
    });

    const detailBody = document.getElementById('detailBody');
    if (detailBody) {
      detailBody.addEventListener('click', e => {
        if (!detailItem) return;
        void handleTagEditorEvent(e, detailItem);
      });
      detailBody.addEventListener('keydown', e => {
        if (!detailItem) return;
        void handleTagEditorEvent(e, detailItem);
      });
    }

    const tagsUnlockBtn = document.getElementById('tagsUnlockBtn');
    if (tagsUnlockBtn) tagsUnlockBtn.remove();

    const tagPopover = document.getElementById('tagPopover');
    if (tagPopover) {
      tagPopover.addEventListener('click', e => {
        e.stopPropagation();
        if (!tagPopoverItem) return;
        void handleTagEditorEvent(e, tagPopoverItem);
      });
      tagPopover.addEventListener('keydown', e => {
        if (!tagPopoverItem) return;
        void handleTagEditorEvent(e, tagPopoverItem);
      });
      const tagPopoverClose = document.getElementById('tagPopoverClose');
      if (tagPopoverClose) tagPopoverClose.onclick = e => {
        e.stopPropagation();
        closeTagPopover();
      };
    }
    document.addEventListener('click', e => {
      const pop = document.getElementById('tagPopover');
      if (!pop || pop.hidden) return;
      if (e.target.closest('#tagPopover') || e.target.closest('[data-action="tag-edit"]')) return;
      closeTagPopover();
    });

    document.getElementById('lightbox').onclick = e => {
      // Close on backdrop / toolbar empty area; keep media, actions & info panel interactive.
      if (e.target.closest('.lb-zoom img, .lb-zoom video, img, video, audio, iframe, .lightbox-text, .media-audio-wrap')) return;
      if (e.target.closest('button, a, input, .lightbox-actions, .lightbox-info, .lb-thumbs, .lb-pane-label')) return;
      closeLightbox();
    };
    document.getElementById('lightboxExit').onclick = e => {
      e.stopPropagation();
      closeLightbox();
    };
    document.getElementById('lightboxPrev').onclick = e => { e.stopPropagation(); lightboxNav(-1); };
    document.getElementById('lightboxNext').onclick = e => { e.stopPropagation(); lightboxNav(1); };
    document.getElementById('lightboxActions').addEventListener('click', e => e.stopPropagation());

    const lbInfoClose = document.getElementById('lightboxInfoClose');
    if (lbInfoClose) {
      lbInfoClose.onclick = e => {
        e.stopPropagation();
        closeLbInfo();
        renderLbToolbar();
      };
    }
    const lbInfoActions = document.getElementById('lightboxInfoActions');
    if (lbInfoActions) {
      lbInfoActions.addEventListener('click', e => {
        e.stopPropagation();
        const btn = e.target.closest('[data-lb-info-action]');
        if (!btn) return;
        const item = currentLightboxItem();
        if (!item) return;
        handleAction(btn.dataset.lbInfoAction, item.newRel);
      });
    }
    const lbInfoBody = document.getElementById('lightboxInfoBody');
    if (lbInfoBody) {
      lbInfoBody.addEventListener('click', e => {
        e.stopPropagation();
        const item = currentLightboxItem();
        if (!item) return;
        void handleTagEditorEvent(e, item);
      });
      lbInfoBody.addEventListener('keydown', e => {
        e.stopPropagation();
        const item = currentLightboxItem();
        if (!item) return;
        void handleTagEditorEvent(e, item);
      });
    }
    const lbInfoPanel = document.getElementById('lightboxInfo');
    if (lbInfoPanel) {
      lbInfoPanel.addEventListener('click', e => e.stopPropagation());
    }

    document.addEventListener('keydown', e => {
      const lb = document.getElementById('lightbox');
      if (!lb.classList.contains('open')) return;
      if (e.key === 'Escape') {
        if (lbInfoOpen) {
          closeLbInfo();
          renderLbToolbar();
        } else {
          closeLightbox();
        }
        return;
      }
      if (lbMode === 'compare') {
        if (e.key === 'ArrowLeft') lightboxNav(-1);
        if (e.key === 'ArrowRight') lightboxNav(1);
        return;
      }
      if (e.key === 'ArrowLeft') lightboxNav(-1);
      if (e.key === 'ArrowRight') lightboxNav(1);
    });

    document.getElementById('githubLogin').onclick = () => loginGithub();
    document.getElementById('githubLogout').onclick = () => logout();
    document.getElementById('savePat').onclick = () => {
      const v = (document.getElementById('pat').value || '').trim();
      if (!v) return alert('请输入 PAT');
      saveToken(v).then(() => setStatus('PAT 已保存', 'ok')).catch(e => setStatus(e.message, 'err'));
    };
    document.getElementById('clearPat').onclick = () => logout();
    document.getElementById('refreshList').onclick = () => refreshFromGitHub(false);
    document.getElementById('refreshListLogged').onclick = () => refreshFromGitHub(false);

    document.getElementById('selectAll').onchange = e => {
      const on = e.target.checked;
      filtered.forEach(i => { if (on) selected.add(i.newRel); else selected.delete(i.newRel); });
      void filter();
    };

    document.getElementById('batchDelete').onclick = () => batchDelete();
    document.getElementById('batchRename').onclick = () => {
      if (selected.size !== 1) return;
      handleAction('rename', [...selected][0]);
    };
    document.getElementById('batchReplace').onclick = () => {
      if (selected.size !== 1) return;
      handleAction('replace', [...selected][0]);
    };

    document.getElementById('patToggle').onclick = () => {
      document.getElementById('patRow').classList.toggle('hidden');
    };

    document.getElementById('mediaContainer').addEventListener('change', e => {
      if (e.target.id === 'similarMode') {
        similarMode = e.target.value;
        autoSmartSelected = false;
        if (similarIndexRaw) {
          applySimilarIndex(similarIndexRaw);
          void filter().then(() => syncAppRoute('replace'));
        } else {
          loadSimilarIndex(true);
          syncAppRoute('replace');
        }
      }
    });

    document.getElementById('replaceInput').onchange = async () => {
      const input = document.getElementById('replaceInput');
      const file = input.files && input.files[0];
      const rel = input.dataset.target;
      const fromLightbox = input.dataset.fromLightbox === '1';
      input.value = '';
      input.dataset.fromLightbox = '';
      if (!file || !rel) return;
      setStatus('替换上传中…');
      try {
        const updated = await replaceFile(rel, file);
        bumpRepoHead(updated && updated.commitSha);
        void filter();
        if (updated) {
          detailItem = itemByRel(rel) || updated;
          if (fromLightbox) openLightbox(detailItem, lbFullscreen);
          else void openDetail(detailItem);
        }
        setStatus('替换成功 · ' + formatBytes(file.size), 'ok');
      } catch (e) {
        setStatus('替换失败: ' + e.message, 'err');
      }
    };
  }

  async function handleCallbackOnInit() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (!code) return;
    if (params.get('state')) { await handleOAuthReturn(); return; }
    const manifest = await handleManifestReturn();
    if (manifest) await startOAuthRedirect();
  }

  /**
   * 应用启动：加载初始 ITEMS → 绑定事件 → OAuth 回调 → 同步 GitHub →
   * routeReady=true 后 applyRouteFromHash() 恢复 URL 深链状态。
   */
  async function init(opts) {
    ITEMS = (opts.items || []).map(i => {
      if (i.kind !== undefined) return i;
      if (i.newRel) return buildItemFromPath(i.newRel, i.oldRel);
      return buildItem(i.name, i.oldRel);
    });
    OLD_MAP = opts.oldMap || {};
    rebuildDupIndex();
    updateCategoryCounts();
    bindEvents();
    showAuthUI();

    try { await handleCallbackOnInit(); } catch (e) {
      setStatus('GitHub 登录失败: ' + e.message, 'err');
    }

    if (token() && !sessionStorage.getItem(AUTH_USER_KEY)) {
      try { await saveToken(token()); } catch (_) { /* ignore */ }
    } else if (token()) {
      if (!(await verifyGalleryAccess())) {
        logout();
        setStatus('此 GitHub 账号无权访问图库', 'err');
      } else {
        refreshUserProfile();
      }
    } else {
      updateSiteBranding(null, REPO.owner);
    }

    updateLoginGate();
    const initialRoute = parseAppHash();
    if (initialRoute.category && ROUTE_CATS.has(initialRoute.category)) {
      category = initialRoute.category;
      setNavActive(category);
      if (initialRoute.sort) {
        sortBy = initialRoute.sort;
        const sortEl = document.getElementById('sort');
        if (sortEl) sortEl.value = sortBy;
      }
      if (initialRoute.view) setViewModeUI(initialRoute.view);
      if (initialRoute.sim) similarMode = initialRoute.sim;
      const qEl = document.getElementById('q');
      if (qEl && initialRoute.q) qEl.value = initialRoute.q;
    }
    await filter();
    if (location.protocol !== 'file:') await refreshFromGitHub(true);
    else setStatus('本地 file 打开：请用 GitHub Pages 以自动同步');
    routeReady = true;
    await applyRouteFromHash();
  }

  global.GalleryApp = { init, refreshFromGitHub };
})(window);
