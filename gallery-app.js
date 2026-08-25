/* PictureBed4PicGo gallery — Immich layout + multi-type preview */
(function (global) {
  'use strict';

  const TOKEN_KEY = 'pb4pg_pat';
  const AUTH_USER_KEY = 'pb4pg_user';
  const AUTH_AVATAR_KEY = 'pb4pg_avatar';
  const SITE_OG_IMAGE = 'https://pioneersunovo.github.io/PictureBed4PicGo/assets/og-image.png';
  const SITE_FAVICON = 'assets/favicon.png';
  const SITE_APPLE_ICON = 'assets/apple-touch-icon.png';
  const OAUTH_STATE_KEY = 'pb4pg_oauth_state';
  const OAUTH_VERIFIER_KEY = 'pb4pg_code_verifier';
  const OAUTH_SECRET_KEY = 'pb4pg_oauth_secret';
  const HASH_RE = /([a-f0-9]{32})(?:-\d+)?\.[^.]+$/i;

  const EXT_MAP = {
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic', 'heif'],
    video: ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'ogv'],
    audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'],
    document: ['pdf'],
    text: ['txt', 'md', 'json', 'csv', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'yaml', 'yml', 'log', 'sql', 'sh', 'bat', 'ps1']
  };

  const TYPE_ICONS = {
    image: '🖼', video: '▶', audio: '♫', document: '📄', text: '⌨', other: '📦'
  };

  let ITEMS = [];
  let OLD_MAP = {};
  /** Bidirectional rename links for date recovery after manual rename. */
  const RENAME_LINKS = new Map();
  let filtered = [];
  const selected = new Set();
  let focused = null;
  let detailItem = null;
  let lightboxIdx = -1;
  let category = 'all';
  let viewMode = 'grid';
  let sortBy = 'date-desc';
  let devicePollAbort = null;
  const hashGroups = new Map();
  let exactSets = [];
  let similarSets = [];
  let clipModule = null;
  let similarScanned = false;
  let similarScanning = false;
  let autoSmartSelected = false;
  let similarThreshold = 0.98;
  let similarMode = 'near';
  const collapsedGroups = new Set();
  const CLIP_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
  /** Latest master commit — pin CDN/Raw URLs to avoid @master cache lag. */
  let repoHeadCommit = null;

  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
  }

  function fileKind(name) {
    const ext = extOf(name);
    for (const [kind, exts] of Object.entries(EXT_MAP)) {
      if (exts.includes(ext)) return kind;
    }
    return 'other';
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
    filter();
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
    selected.clear();
    detailItem = null;
    closeDetail();
    const pat = document.getElementById('pat');
    if (pat) pat.value = '';
    updateSiteBranding(null, REPO.owner);
    showAuthUI();
    filter();
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

  function canClipEmbed(item) {
    return item.kind === 'image' && CLIP_EXTS.has(item.ext);
  }

  async function getClipModule() {
    if (!clipModule) clipModule = await import('./clip-embed.js');
    return clipModule;
  }

  function stripItemEmbeddings() {
    ITEMS.forEach(item => {
      delete item.embedding;
      delete item.embeddingKey;
      delete item.simToKeep;
      delete item.ssimToKeep;
    });
  }

  async function clearClipCache() {
    if (!confirm('清除本机全部 CLIP 向量缓存？下次相似扫描需重新计算。')) return;
    try {
      const clip = await getClipModule();
      const { cleared } = await clip.clearAllCache();
      stripItemEmbeddings();
      similarScanned = false;
      similarSets = [];
      autoSmartSelected = false;
      const el = document.getElementById('similarCount');
      if (el) el.textContent = '0';
      setStatus('已清除 ' + cleared + ' 条向量缓存', 'ok');
      if (category === 'similar') scanSimilarImages(true);
      else filter();
    } catch (e) {
      setStatus('清除缓存失败: ' + e.message, 'err');
    }
  }

  async function purgeStaleClipCache() {
    try {
      const clip = await getClipModule();
      const { removed } = await clip.purgeStaleCache();
      if (removed > 0) setStatus('已清理 ' + removed + ' 条过期向量缓存', 'ok');
    } catch (_) { /* ignore */ }
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

  function cosineSimilarity(a, b) {
    if (!clipModule) return 0;
    return clipModule.cosineSimilarity(a, b);
  }

  function formatSimPct(sim) {
    if (clipModule) return clipModule.formatSimilarity(sim);
    return Math.round(Math.max(0, Math.min(1, sim)) * 1000) / 10 + '%';
  }

  async function buildSimilarSetsAsync() {
    const clip = await getClipModule();
    const modeCfg = clip.getSimilarModeConfig(similarMode);
    const images = ITEMS.filter(canClipEmbed).filter(i => i.embedding);
    let clusters = clip.clusterCompleteLinkage(images, similarThreshold);
    const refined = [];
    for (const items of clusters) {
      const sorted = sortItemsByDate(items);
      const keep = sorted[sorted.length - 1];
      let group = sorted;
      if (modeCfg.ssim > 0) {
        const after = await clip.refineGroupBySsim(
          sorted,
          keep.newRel,
          (item) => srcOf(item),
          modeCfg.ssim
        );
        if (after && after.length >= 2) group = sortItemsByDate(after);
        else continue;
      }
      if (isExactOnlyGroup(group)) continue;
      const stats = clip.groupStats(group, keep.newRel);
      refined.push({
        id: 'sim-' + keep.newRel.slice(7, 20),
        type: 'similar',
        items: group,
        keepRel: keep.newRel,
        avgSimilarity: stats.avg,
        minSimilarity: stats.min,
        maxSimilarity: stats.max
      });
    }
    similarSets = refined.sort((a, b) => b.items.length - a.items.length);
    const el = document.getElementById('similarCount');
    if (el) el.textContent = String(similarSets.length);
  }

  function buildSimilarSets() {
    if (!clipModule) return;
    const modeCfg = clipModule.getSimilarModeConfig(similarMode);
    const images = ITEMS.filter(canClipEmbed).filter(i => i.embedding);
    const clusters = clipModule.clusterCompleteLinkage(images, similarThreshold);
    similarSets = clusters
      .filter(g => !isExactOnlyGroup(g))
      .map((items) => {
        const sorted = sortItemsByDate(items);
        const keep = sorted[sorted.length - 1];
        const stats = clipModule.groupStats(sorted, keep.newRel);
        return {
          id: 'sim-' + keep.newRel.slice(7, 20),
          type: 'similar',
          items: sorted,
          keepRel: keep.newRel,
          avgSimilarity: stats.avg,
          minSimilarity: stats.min,
          maxSimilarity: stats.max
        };
      })
      .sort((a, b) => b.items.length - a.items.length);
    const el = document.getElementById('similarCount');
    if (el) el.textContent = String(similarSets.length);
  }

  async function scanSimilarImages(force) {
    if (similarScanning) return;
    if (similarScanned && !force) return;
    similarScanning = true;
    similarScanned = false;
    similarSets = [];
    collapsedGroups.clear();
    const targets = ITEMS.filter(canClipEmbed);
    const total = targets.length;
    if (!total) {
      similarScanning = false;
      similarScanned = true;
      setStatus('没有可分析的图片格式', 'err');
      filter();
      return;
    }
    const renderProgress = (p) => {
      const pct = p.phase === 'model' ? 5 : p.phase === 'cluster' ? 95 : Math.round(10 + (p.done / p.total) * 80);
      const container = document.getElementById('mediaContainer');
      if (container && category === 'similar') {
        container.innerHTML =
          '<div class="scan-progress similar-scan">' +
          '<div class="scan-steps">' +
          '<span class="' + (p.phase === 'model' ? 'active' : (pct > 10 ? 'done' : '')) + '">① 模型</span>' +
          '<span class="' + (p.phase === 'encode' ? 'active' : (p.phase === 'cluster' ? 'done' : '')) + '">② 向量</span>' +
          '<span class="' + (p.phase === 'cluster' ? 'active' : '') + '">③ 聚类</span>' +
          '</div>' +
          '<div>' + escapeHtml(p.label || '') + '</div>' +
          '<div class="bar"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
          '<div class="scan-meta">' + p.done + ' / ' + p.total + ' · 缓存命中 ' + (p.cacheHits || 0) + '</div>' +
          '</div>';
      }
      if (p.phase === 'encode') setStatus('CLIP 分析 ' + p.done + '/' + p.total + '…');
    };
    renderProgress({ phase: 'model', done: 0, total, cacheHits: 0, label: '正在启动 Worker…' });
    try {
      const clip = await getClipModule();
      const modeCfg = clip.getSimilarModeConfig(similarMode);
      similarThreshold = modeCfg.threshold;
      const { cacheHits } = await clip.scanEmbeddings({
        items: targets,
        repoHead: repoHeadCommit,
        urlFor: (item) => srcOf(item),
        onProgress: renderProgress
      });
      await buildSimilarSetsAsync();
      setStatus(
        '相似分析完成：' + similarSets.length + ' 组（缓存 ' + cacheHits + '/' + total + '）',
        'ok'
      );
    } catch (e) {
      setStatus('CLIP 分析失败: ' + e.message, 'err');
    }
    similarScanning = false;
    similarScanned = true;
    autoSmartSelected = false;
    filter();
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
    if (similarScanned) buildSimilarSets();
    return dupFiles;
  }

  function updateCategoryCounts() {
    const counts = { all: ITEMS.length, image: 0, video: 0, audio: 0, document: 0, text: 0, other: 0 };
    ITEMS.forEach(i => { if (counts[i.kind] !== undefined) counts[i.kind]++; });
    Object.keys(counts).forEach(k => {
      const el = document.getElementById('cnt' + k.charAt(0).toUpperCase() + k.slice(1));
      if (el) el.textContent = String(counts[k]);
    });
  }

  function buildItem(name, oldRel) {
    const rel = 'images/' + name;
    const enc = encodePath(rel);
    const hash = extractHash(name);
    const kind = fileKind(name);
    const mappedOld = oldRel || OLD_MAP[rel] || '';
    const resolved = resolveItemDate(name, rel, mappedOld);
    const date = resolved ? resolved.date : null;
    const pin = repoHeadCommit || REPO.branch;
    return {
      name,
      newRel: rel,
      oldRel: mappedOld,
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
    const data = await ghFetch('/git/trees/' + REPO.branch + '?recursive=1');
    return (data.tree || [])
      .filter(t => t.type === 'blob' && t.path.startsWith('images/'))
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

  function srcOf(item) {
    const source = document.getElementById('source');
    const enc = encodePath(item.newRel);
    const pin = mediaPin(item);
    let url;
    if (source.value === 'raw') {
      url = 'https://raw.githubusercontent.com/' + REPO.owner + '/' + REPO.repo + '/' + pin + '/' + enc;
    } else if (source.value === 'local') {
      url = 'images/' + item.name;
    } else {
      url = 'https://cdn.jsdelivr.net/gh/' + REPO.owner + '/' + REPO.repo + '@' + pin + '/' + enc;
    }
    const bust = item.rev || (item.blobSha ? item.blobSha.slice(0, 8) : '');
    if (bust) url += (url.includes('?') ? '&' : '?') + 'v=' + bust;
    return url;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  function updateSelUI() {
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
    if (group.type === 'similar' && !isKeep && item.simToKeep != null) {
      const label = formatSimPct(item.simToKeep);
      const pct = Math.round(Math.max(0, Math.min(1, item.simToKeep)) * 100);
      html += '<span class="sim-score" title="相对保留项相似度">' + label + '</span>';
      html += '<div class="sim-bar"><div class="sim-bar-fill" style="width:' + pct + '%"></div></div>';
    }
    if (item.kind !== 'image') html += '<span class="type-badge">' + escapeHtml(item.ext) + '</span>';
    html += '<div class="thumb-wrap">' + thumbHtml(item, url, false) + '</div>';
    html += '<div class="card-hover">';
    html += '<button type="button" data-action="copy-url">链接</button>';
    html += '<button type="button" data-action="preview">预览</button>';
    if (hasToken) html += '<button type="button" class="del" data-action="delete">删除</button>';
    html += '</div>';
    html += '<div class="card-meta"><div class="card-name">' + escapeHtml(item.name) + '</div>';
    if (item.dateStr) html += '<div class="card-date">' + escapeHtml(item.dateStr) + '</div>';
    html += '</div></article>';
    return html;
  }

  function renderDupGroups(sets, mode) {
    const hasToken = !!token();
    const modeCfg = clipModule ? clipModule.getSimilarModeConfig(similarMode) : null;
    let html = '<div class="dup-workflow">';
    html += '<div class="dup-toolbar">';
    html += '<div class="hint">';
    if (mode === 'exact') {
      html += '按文件名 hash 精确分组。点击「智能选中」后才会勾选待删项。';
    } else {
      html += '<strong>相似审阅</strong> · 完全链接聚类 + SSIM 复核。请逐组确认后再删除。';
    }
    html += '</div>';
    html += '<div class="dup-toolbar-actions">';
    html += '<button type="button" class="primary" data-dup-action="smart-select">智能选中待删</button>';
    html += '<button type="button" data-dup-action="clear-select">取消选中</button>';
    if (mode === 'similar') {
      html += '<select id="similarMode" class="dup-select">';
      html += '<option value="near"' + (similarMode === 'near' ? ' selected' : '') + '>近重复 (98%)</option>';
      html += '<option value="semantic"' + (similarMode === 'semantic' ? ' selected' : '') + '>语义相似 (92%)</option>';
      html += '</select>';
      const minPct = modeCfg ? Math.round(modeCfg.min * 100) : 85;
      const maxPct = modeCfg ? Math.round(modeCfg.max * 100) : 99;
      const curPct = Math.round(similarThreshold * 100);
      html += '<label class="thresh-label">阈值 <input type="range" id="similarThreshold" min="' + minPct + '" max="' + maxPct + '" value="' + curPct + '"> <span id="thresholdVal">' + curPct + '</span>%</label>';
      html += '<button type="button" data-dup-action="rescan">重新扫描</button>';
      html += '<button type="button" data-dup-action="clear-cache" title="清除本机 IndexedDB 中的 CLIP 向量缓存">清除向量缓存</button>';
    }
    html += '</div></div>';

    if (!sets.length) {
      html += '<div class="empty">' + (mode === 'exact' ? '未发现 hash 重复' : '未发现视觉相似组（可调模式或阈值后重新扫描）') + '</div>';
      html += '</div>';
      return html;
    }

    if (mode === 'similar' && selected.size > 0) {
      html += '<div class="dup-warn">已选中 <strong>' + selected.size + '</strong> 张待删 · 删除前请再次确认</div>';
    }

    sets.forEach((group, gi) => {
      const keepItem = itemByRel(group.keepRel);
      const keepDate = keepItem && keepItem.dateStr ? keepItem.dateStr : '';
      const collapsed = collapsedGroups.has(group.id);
      const selectedInGroup = group.items.filter(i => selected.has(i.newRel)).length;
      html += '<div class="dup-group' + (collapsed ? ' collapsed' : '') + '" data-group-id="' + escapeAttr(group.id) + '">';
      html += '<div class="dup-group-head" data-group-toggle="' + escapeAttr(group.id) + '">';
      html += '<button type="button" class="dup-collapse-btn" aria-label="展开/折叠">' + (collapsed ? '▸' : '▾') + '</button>';
      html += '<div class="dup-group-title">组 ' + (gi + 1) + ' · ' + group.items.length + ' 张';
      if (selectedInGroup) html += ' · 已选 ' + selectedInGroup;
      if (mode === 'exact') html += '<span class="sub">hash 相同</span>';
      else {
        html += '<span class="sub">相似 ' + formatSimPct(group.minSimilarity || group.avgSimilarity) +
          '–' + formatSimPct(group.maxSimilarity || group.avgSimilarity) +
          ' · 均 ' + formatSimPct(group.avgSimilarity) + '</span>';
      }
      if (keepDate) html += '<span class="sub">保留 ' + escapeHtml(keepDate) + '</span>';
      html += '</div>';
      html += '<div class="dup-group-actions">';
      html += '<button type="button" data-group-action="smart" data-group-id="' + escapeAttr(group.id) + '">本组智能选中</button>';
      html += '<button type="button" data-group-action="all" data-group-id="' + escapeAttr(group.id) + '">全选本组</button>';
      html += '</div></div>';
      if (!collapsed) {
        html += '<div class="grid dup-group-grid">';
        group.items.forEach(item => { html += renderGroupCard(item, group, hasToken); });
        html += '</div>';
      }
      html += '</div>';
    });
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
      similarSets.find(g => g.id === id);
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
        if (item.kind !== 'image') html += '<span class="type-badge">' + escapeHtml(item.ext) + '</span>';
        html += '<div class="thumb-wrap">' + thumbHtml(item, url, false) + '</div>';
        html += '<div class="card-hover">';
        html += '<button type="button" data-action="copy-url">链接</button>';
        html += '<button type="button" data-action="preview">预览</button>';
        if (hasToken) html += '<button type="button" class="del" data-action="delete">删除</button>';
        html += '</div>';
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
      html += '<div class="list-info"><div class="name">' + escapeHtml(item.name) + '</div>';
      html += '<div class="sub">' + escapeHtml(item.kind) + (item.dateStr ? ' · ' + item.dateStr : '') + '</div></div>';
      html += '<div class="list-actions">';
      html += '<button type="button" data-action="copy-url">链接</button>';
      html += '<button type="button" data-action="preview">预览</button>';
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

  function render(list) {
    const container = document.getElementById('mediaContainer');
    const stats = document.getElementById('stats');
    if (!container) return;

    rebuildDupIndex();
    updateCategoryCounts();

    if (category === 'dup' || category === 'similar') {
      const mode = category;
      const sets = mode === 'dup' ? exactSets : similarSets;

      if (mode === 'similar' && !similarScanned && !similarScanning) {
        container.innerHTML = '<div class="scan-progress"><div>进入相似检测…</div></div>';
        scanSimilarImages(false);
        return;
      }
      if (mode === 'similar' && similarScanning) return;

      filtered = flattenSets(sets);
      if (stats) {
        const setLabel = mode === 'dup' ? '重复组' : '相似组';
        stats.innerHTML = setLabel + ' <strong>' + sets.length + '</strong> · 共 <strong>' + filtered.length + '</strong> 张';
      }

      container.innerHTML = renderDupGroups(sets, mode);

      updateSelUI();
      return;
    }

    filtered = list;
    if (stats) {
      stats.innerHTML = '显示 <strong>' + list.length + '</strong> / ' + ITEMS.length + ' 个文件';
    }

    if (!list.length) {
      container.innerHTML = '<div class="empty">没有匹配结果</div>';
      updateSelUI();
      return;
    }

    container.innerHTML = viewMode === 'list' ? renderList(list) : renderGrid(list);
    updateSelUI();
  }

  function filter() {
    const kw = (document.getElementById('q').value || '').trim().toLowerCase();
    let list = ITEMS;
    if (category === 'dup' || category === 'similar') {
      render([]);
      return;
    }
    if (category !== 'all') list = list.filter(i => i.kind === category);
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
    render(sortList(list));
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

  function openDetail(item) {
    detailItem = item;
    document.getElementById('appShell').classList.add('detail-open');
    const url = srcOf(item);
    const preview = document.getElementById('detailPreview');
    const body = document.getElementById('detailBody');
    const actions = document.getElementById('detailActions');

    if (item.kind === 'image') {
      const img = document.createElement('img');
      img.alt = item.name;
      img.src = url;
      preview.innerHTML = '';
      preview.appendChild(img);
    } else if (item.kind === 'video') {
      preview.innerHTML = '<video controls src="' + escapeAttr(url) + '"></video>';
    } else if (item.kind === 'audio') {
      preview.innerHTML = '<audio controls src="' + escapeAttr(url) + '" style="width:90%"></audio>';
    } else {
      preview.innerHTML = '<span class="thumb-icon" style="font-size:3rem">' + TYPE_ICONS[item.kind] + '</span>';
    }

    const rows = [
      ['文件名', item.name],
      ['类型', item.kind + ' (.' + item.ext + ')'],
      ['路径', item.newRel],
      ['CDN', item.cdn],
      ['Raw', item.raw]
    ];
    if (item.oldRel) rows.push(['旧路径', item.oldRel]);
    if (item.hash) rows.push(['Hash', item.hash]);
    if (item.blobSha) rows.push(['Blob', item.blobSha]);
    if (item.size) rows.push(['大小', formatBytes(item.size)]);
    if (item.commitSha) rows.push(['Commit', item.commitSha.slice(0, 12) + '…']);
    if (item.dateStr) rows.push(['时间', item.dateStr + (item.dateSource ? ' (' + item.dateSource + ')' : '')]);
    if (item.dupCount > 1) rows.push(['重复', '同 hash 共 ' + item.dupCount + ' 个']);

    body.innerHTML = '<div class="detail-section"><h3>元数据</h3>' +
      rows.map(([l, v]) =>
        '<div class="meta-row"><div class="meta-label">' + escapeHtml(l) +
        '</div><div class="meta-value">' + escapeHtml(v) + '</div></div>'
      ).join('') + '</div>';

    const hasToken = !!token();
    actions.innerHTML =
      '<button type="button" class="primary" data-action="copy-url">复制链接</button>' +
      '<button type="button" data-action="copy-name">复制文件名</button>' +
      '<button type="button" data-action="preview">全屏预览</button>' +
      '<a href="' + escapeAttr(url) + '" target="_blank" rel="noopener">新窗口</a>' +
      (hasToken
        ? '<button type="button" data-action="rename">重命名</button>' +
          '<button type="button" data-action="replace">替换</button>' +
          '<button type="button" class="danger" data-action="delete">删除</button>'
        : '');
  }

  function closeDetail() {
    detailItem = null;
    document.getElementById('appShell').classList.remove('detail-open');
  }

  async function renderLightbox(item) {
    const url = srcOf(item);
    const content = document.getElementById('lightboxContent');
    const caption = document.getElementById('lightboxCaption');
    content.innerHTML = '';
    caption.textContent = item.name;

    if (item.kind === 'image') {
      const img = document.createElement('img');
      img.src = url;
      img.alt = item.name;
      content.appendChild(img);
    } else if (item.kind === 'video') {
      const v = document.createElement('video');
      v.src = url;
      v.controls = true;
      v.autoplay = true;
      content.appendChild(v);
    } else if (item.kind === 'audio') {
      const a = document.createElement('audio');
      a.src = url;
      a.controls = true;
      a.autoplay = true;
      content.appendChild(a);
    } else if (item.kind === 'document') {
      const iframe = document.createElement('iframe');
      iframe.src = url;
      iframe.style.width = 'min(92vw, 900px)';
      iframe.style.height = '75vh';
      iframe.style.border = 'none';
      iframe.style.borderRadius = '8px';
      content.appendChild(iframe);
    } else if (item.kind === 'text') {
      const pre = document.createElement('pre');
      pre.className = 'lightbox-text';
      pre.textContent = '加载中…';
      content.appendChild(pre);
      try {
        const res = await fetch(url);
        const text = await res.text();
        pre.textContent = text.length > 50000 ? text.slice(0, 50000) + '\n\n…(已截断)' : text;
      } catch (e) {
        pre.textContent = '无法加载文本: ' + e.message;
      }
    } else {
      const div = document.createElement('div');
      div.className = 'lightbox-text';
      div.style.textAlign = 'center';
      div.innerHTML = '<div style="font-size:4rem;margin-bottom:16px">' + TYPE_ICONS.other +
        '</div><div>.' + escapeHtml(item.ext) + ' 文件暂不支持预览</div>' +
        '<div style="margin-top:12px;opacity:.7"><a href="' + escapeAttr(url) +
        '" target="_blank" rel="noopener" style="color:#93c5fd">下载 / 打开</a></div>';
      content.appendChild(div);
    }
  }

  function openLightbox(item) {
    lightboxIdx = filtered.findIndex(i => i.newRel === item.newRel);
    document.getElementById('lightbox').classList.add('open');
    renderLightbox(item);
  }

  function closeLightbox() {
    document.getElementById('lightbox').classList.remove('open');
    document.getElementById('lightboxContent').innerHTML = '';
    const cap = document.getElementById('lightboxCaption');
    if (cap) cap.textContent = '';
    lightboxIdx = -1;
  }

  function lightboxNav(dir) {
    if (!filtered.length) return;
    lightboxIdx = (lightboxIdx + dir + filtered.length) % filtered.length;
    renderLightbox(filtered[lightboxIdx]);
  }

  function handleAction(action, rel) {
    const item = itemByRel(rel);
    if (!item) return;
    const url = srcOf(item);

    if (action === 'copy-url') {
      navigator.clipboard.writeText(url);
      setStatus('已复制链接', 'ok');
    } else if (action === 'copy-name') {
      navigator.clipboard.writeText(item.name);
      setStatus('已复制文件名', 'ok');
    } else if (action === 'preview') {
      openLightbox(item);
    } else if (action === 'delete') {
      deleteOne(rel).catch(err => setStatus('删除失败: ' + err.message, 'err'));
    } else if (action === 'rename') {
      const cur = rel.slice(7);
      const newName = prompt('新文件名（images/ 下）', cur);
      if (!newName || newName === cur) return;
      setStatus('重命名中…');
      renameFile(rel, newName)
        .then(() => { filter(); setStatus('重命名成功', 'ok'); })
        .catch(err => setStatus('重命名失败: ' + err.message, 'err'));
    } else if (action === 'replace') {
      const input = document.getElementById('replaceInput');
      input.dataset.target = rel;
      input.click();
    }
  }

  async function refreshFromGitHub(silent) {
    const prev = ITEMS.length;
    if (!silent) setStatus('正在从 GitHub 同步…');
    try {
      await fetchRepoHead();
      await fetchOldMapFromRemote();
      const paths = await fetchRemotePaths();
      const prevMeta = new Map(ITEMS.map(i => [i.newRel, i]));
      ITEMS = paths.map(p => {
        const item = buildItem(p.path.slice(7), OLD_MAP[p.path]);
        item.blobSha = p.sha;
        const old = prevMeta.get(item.newRel);
        if (old && old.rev) item.rev = old.rev;
        if (old && old.embedding && old.blobSha === p.sha) {
          item.embedding = old.embedding;
          item.embeddingKey = old.embeddingKey;
        }
        return item;
      });
      await enrichDatesFromGit(ITEMS);
      if (clipModule) clipModule.clearMemCache();
      similarScanned = false;
      autoSmartSelected = false;
      rebuildDupIndex();
      updateCategoryCounts();
      selected.clear();
      filter();
      if (!silent) setStatus('已同步 ' + ITEMS.length + ' 个文件', 'ok');
      else if (prev !== ITEMS.length) setStatus('已自动同步 ' + ITEMS.length + ' 个文件', 'ok');
      else setStatus('');
    } catch (e) {
      rebuildDupIndex();
      updateCategoryCounts();
      filter();
      if (ITEMS.length) setStatus('在线同步失败，显示缓存 ' + ITEMS.length + ' 个', 'err');
      else setStatus('加载失败: ' + e.message, 'err');
    }
  }

  async function renameFile(oldRel, newName) {
    newName = newName.trim().replace(/^images\//, '').replace(/\\/g, '/');
    if (!newName || newName.includes('/')) throw new Error('新文件名无效');
    const newRel = 'images/' + newName;
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
      ITEMS[idx] = buildItem(newName, OLD_MAP[newRel]);
      if (!ITEMS[idx].date && prev && prev.date) {
        ITEMS[idx].date = prev.date;
        ITEMS[idx].dateStr = prev.dateStr;
        ITEMS[idx].dateSource = (prev.dateSource || '文件名') + ' · 重命名继承';
      }
    }
    selected.delete(oldRel);
    if (detailItem && detailItem.newRel === oldRel) detailItem = ITEMS[idx];
    rebuildDupIndex();
  }

  async function replaceFile(rel, file) {
    const content = await fileToBase64(file);
    const result = await putFileViaGit(rel, content, 'gallery: replace ' + rel);

    const newSha = result && result.content && result.content.sha;
    const commitSha = result && result.commitSha;
    bumpRepoHead(commitSha);
    const name = rel.slice(7);
    const idx = ITEMS.findIndex(i => i.newRel === rel);
    if (idx >= 0) {
      const oldRel = ITEMS[idx].oldRel;
      const oldKey = ITEMS[idx].embeddingKey;
      ITEMS[idx] = buildItem(name, oldRel);
      ITEMS[idx].blobSha = newSha;
      ITEMS[idx].commitSha = commitSha;
      ITEMS[idx].rev = Date.now();
      ITEMS[idx].size = file.size;
      if (oldKey) getClipModule().then(m => m.invalidateCache(oldKey)).catch(() => {});
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
    selected.delete(rel);
    if (detailItem && detailItem.newRel === rel) closeDetail();
    rebuildDupIndex();
    filter();
    setStatus('已删除 ' + rel.slice(7), 'ok');
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
        selected.delete(rel);
        ok++;
        setStatus('删除中 ' + ok + '/' + rels.length + '…');
      } catch (e) {
        setStatus('删除失败 ' + rel + ': ' + e.message, 'err');
        break;
      }
    }
    rebuildDupIndex();
    filter();
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
        st.textContent = oauthClientId()
          ? '已登录 GitHub 时一键授权'
          : '登录后可删除、重命名与替换';
      }
    }
  }

  function bindEvents() {
    document.getElementById('q').oninput = filter;
    document.getElementById('source').onchange = () => { filter(); if (detailItem) openDetail(detailItem); };
    document.getElementById('sort').onchange = e => { sortBy = e.target.value; filter(); };

    if (location.protocol !== 'file:') {
      const localOpt = document.querySelector('#source option[value="local"]');
      if (localOpt) localOpt.remove();
    }

    document.querySelectorAll('.nav-item[data-cat]').forEach(btn => {
      btn.onclick = () => {
        const next = btn.dataset.cat;
        if (next !== category) autoSmartSelected = false;
        category = next;
        document.querySelectorAll('.nav-item[data-cat]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        filter();
      };
    });

    document.getElementById('viewGrid').onclick = () => {
      viewMode = 'grid';
      document.getElementById('viewGrid').classList.add('active');
      document.getElementById('viewList').classList.remove('active');
      filter();
    };
    document.getElementById('viewList').onclick = () => {
      viewMode = 'list';
      document.getElementById('viewList').classList.add('active');
      document.getElementById('viewGrid').classList.remove('active');
      filter();
    };

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
          filter();
        } else if (action === 'clear-select') {
          sets.forEach(g => g.items.forEach(i => selected.delete(i.newRel)));
          updateSelUI();
          filter();
        } else if (action === 'rescan') {
          similarScanned = false;
          autoSmartSelected = false;
          scanSimilarImages(true);
        } else if (action === 'clear-cache') {
          clearClipCache();
        }
        return;
      }

      const toggleHead = e.target.closest('[data-group-toggle]');
      if (toggleHead && !e.target.closest('[data-group-action]')) {
        const gid = toggleHead.dataset.groupToggle;
        if (collapsedGroups.has(gid)) collapsedGroups.delete(gid);
        else collapsedGroups.add(gid);
        filter();
        return;
      }

      const groupBtn = e.target.closest('[data-group-action]');
      if (groupBtn) {
        e.stopPropagation();
        const g = findGroupById(groupBtn.dataset.groupId);
        if (!g) return;
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
        filter();
        return;
      }

      const actionBtn = e.target.closest('[data-action]');
      const card = e.target.closest('[data-rel]');
      if (!card) return;
      const rel = card.dataset.rel;
      const item = itemByRel(rel);

      if (actionBtn) {
        e.stopPropagation();
        handleAction(actionBtn.dataset.action, rel);
        return;
      }

      const cb = e.target.closest('input[type=checkbox]');
      if (cb) {
        e.stopPropagation();
        toggleSelect(rel, cb.checked);
        card.classList.toggle('selected', cb.checked);
        return;
      }

      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        toggleSelect(rel, !selected.has(rel));
        filter();
        return;
      }

      focused = item.name;
      openDetail(item);
    });

    document.getElementById('detailClose').onclick = closeDetail;

    document.getElementById('detailActions').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn || !detailItem) return;
      handleAction(btn.dataset.action, detailItem.newRel);
    });

    document.getElementById('lightboxClose').onclick = closeLightbox;
    document.getElementById('lightbox').onclick = e => {
      if (e.target.id === 'lightbox') closeLightbox();
    };
    document.getElementById('lightboxPrev').onclick = e => { e.stopPropagation(); lightboxNav(-1); };
    document.getElementById('lightboxNext').onclick = e => { e.stopPropagation(); lightboxNav(1); };

    document.addEventListener('keydown', e => {
      const lb = document.getElementById('lightbox');
      if (!lb.classList.contains('open')) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') lightboxNav(-1);
      if (e.key === 'ArrowRight') lightboxNav(1);
    });

    document.getElementById('githubLogin').onclick = () => loginGithub();
    document.getElementById('githubLogout').onclick = () => logout();
    document.getElementById('savePat').onclick = () => {
      const v = (document.getElementById('pat').value || '').trim();
      if (!v) return alert('请输入 PAT');
      saveToken(v).then(() => setStatus('PAT 已保存', 'ok'));
    };
    document.getElementById('clearPat').onclick = () => logout();
    document.getElementById('refreshList').onclick = () => refreshFromGitHub(false);
    document.getElementById('refreshListLogged').onclick = () => refreshFromGitHub(false);

    document.getElementById('selectAll').onchange = e => {
      const on = e.target.checked;
      filtered.forEach(i => { if (on) selected.add(i.newRel); else selected.delete(i.newRel); });
      filter();
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

    document.getElementById('mediaContainer').addEventListener('input', e => {
      if (e.target.id !== 'similarThreshold') return;
      similarThreshold = +e.target.value / 100;
      const val = document.getElementById('thresholdVal');
      if (val) val.textContent = String(+e.target.value);
    });

    document.getElementById('mediaContainer').addEventListener('change', async e => {
      if (e.target.id === 'similarMode') {
        similarMode = e.target.value;
        const clip = await getClipModule();
        similarThreshold = clip.getSimilarModeConfig(similarMode).threshold;
        autoSmartSelected = false;
        if (ITEMS.some(i => i.embedding)) {
          await buildSimilarSetsAsync();
          filter();
        } else {
          similarScanned = false;
          scanSimilarImages(true);
        }
        return;
      }
      if (e.target.id !== 'similarThreshold') return;
      similarThreshold = +e.target.value / 100;
      autoSmartSelected = false;
      if (ITEMS.some(i => i.embedding)) {
        await buildSimilarSetsAsync();
        filter();
      } else {
        similarScanned = false;
        scanSimilarImages(true);
      }
    });

    document.getElementById('replaceInput').onchange = async () => {
      const input = document.getElementById('replaceInput');
      const file = input.files && input.files[0];
      const rel = input.dataset.target;
      input.value = '';
      if (!file || !rel) return;
      setStatus('替换上传中…');
      try {
        const updated = await replaceFile(rel, file);
        bumpRepoHead(updated && updated.commitSha);
        filter();
        if (updated) {
          detailItem = itemByRel(rel) || updated;
          openDetail(detailItem);
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

  async function init(opts) {
    ITEMS = (opts.items || []).map(i => {
      if (i.kind !== undefined) return i;
      return buildItem(i.name, i.oldRel);
    });
    OLD_MAP = opts.oldMap || {};
    rebuildDupIndex();
    updateCategoryCounts();
    bindEvents();
    showAuthUI();
    purgeStaleClipCache();

    try { await handleCallbackOnInit(); } catch (e) {
      setStatus('GitHub 登录失败: ' + e.message, 'err');
    }

    if (token() && !sessionStorage.getItem(AUTH_USER_KEY)) {
      try { await saveToken(token()); } catch (_) { /* ignore */ }
    } else if (token()) {
      refreshUserProfile();
    } else {
      updateSiteBranding(null, REPO.owner);
    }

    filter();
    if (location.protocol !== 'file:') refreshFromGitHub(true);
    else setStatus('本地 file 打开：请用 GitHub Pages 以自动同步');
  }

  global.GalleryApp = { init, refreshFromGitHub };
})(window);
