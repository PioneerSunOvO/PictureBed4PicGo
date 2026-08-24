/* PictureBed4PicGo gallery — sync / dup mark / manage */
(function (global) {
  'use strict';

  const TOKEN_KEY = 'pb4pg_pat';
  const AUTH_USER_KEY = 'pb4pg_user';
  const OAUTH_STATE_KEY = 'pb4pg_oauth_state';
  const OAUTH_VERIFIER_KEY = 'pb4pg_code_verifier';
  const OAUTH_SECRET_KEY = 'pb4pg_oauth_secret';
  const HASH_RE = /([a-f0-9]{32})(?:-\d+)?\.[^.]+$/i;

  let ITEMS = [];
  let OLD_MAP = {};
  let filtered = [];
  const selected = new Set();
  let focused = null;
  let dupOnly = false;
  let devicePollAbort = null;
  const hashGroups = new Map();

  function apiBase() {
    return 'https://api.github.com/repos/' + REPO.owner + '/' + REPO.repo;
  }

  function oauthCfg() {
    return global.OAUTH || {};
  }

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
    if (!redirect) {
      setStatus('请通过 GitHub Pages 打开本页', 'err');
      return;
    }
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
    if (!res.ok) {
      throw new Error(data.message || 'GitHub App 注册失败');
    }
    if (data.client_id) {
      sessionStorage.setItem('pb4pg_oauth_client_id', data.client_id);
    }
    if (data.client_secret) {
      sessionStorage.setItem(OAUTH_SECRET_KEY, data.client_secret);
    }
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

  function token() {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  }

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

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

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
      } else {
        sessionStorage.removeItem(AUTH_USER_KEY);
      }
    } catch (_) {
      sessionStorage.removeItem(AUTH_USER_KEY);
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
    if (!clientId) {
      setStatus('OAuth 未配置 Client ID', 'err');
      return;
    }
    if (!redirectUri) {
      setStatus('请通过 GitHub Pages 打开本页以使用 GitHub 登录', 'err');
      return;
    }

    const state = randomString(24);
    sessionStorage.setItem(OAUTH_STATE_KEY, state);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state
    });
    if (!oauthClientSecret()) {
      params.set('scope', oauthCfg().scope || 'repo');
    }

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
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      });
      const data = await oauthTokenExchange(body);
      if (data.error === 'authorization_pending') continue;
      if (data.error === 'slow_down') {
        wait += 5;
        continue;
      }
      if (data.error) {
        throw new Error(data.error_description || data.error);
      }
      if (data.access_token) {
        devicePollAbort = null;
        return data.access_token;
      }
    }
    devicePollAbort = null;
    throw new Error('授权超时，请重试');
  }

  async function startDeviceLogin() {
    const clientId = oauthClientId();
    if (!clientId) {
      setStatus('OAuth 未配置 Client ID', 'err');
      return;
    }
    if (oauthClientSecret()) {
      setStatus('请使用 GitHub 登录按钮（浏览器授权）', 'err');
      return;
    }

    setStatus('正在连接 GitHub…');
    const res = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: clientId,
        scope: oauthCfg().scope || 'repo'
      })
    });
    const data = await res.json();
    if (data.error || data.message) {
      throw new Error(data.error_description || data.message || data.error || '设备码请求失败');
    }

    const verifyUrl = data.verification_uri +
      '?user_code=' + encodeURIComponent(data.user_code);
    window.open(verifyUrl, 'pb4pg_github_auth', 'noopener,width=520,height=720');
    setStatus('已在 GitHub 打开授权页（已登录则直接点 Authorize）…');

    const accessToken = await pollDeviceToken(data.device_code, data.interval);
    await saveToken(accessToken);
    setStatus('GitHub 登录成功', 'ok');
  }

  async function loginGithub() {
    try {
      const redirect = oauthRedirectUri();
      if (!redirect) {
        setStatus('请通过 GitHub Pages 打开本页以登录', 'err');
        return;
      }
      if (!oauthClientId()) {
        setStatus('首次使用：正在跳转 GitHub 注册应用…');
        registerGithubApp();
        return;
      }
      if (oauthRedirectUri()) {
        await startOAuthRedirect();
      } else {
        await startDeviceLogin();
      }
    } catch (e) {
      setStatus('登录失败: ' + e.message, 'err');
    }
  }

  function logout() {
    if (devicePollAbort) devicePollAbort.aborted = true;
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(AUTH_USER_KEY);
    sessionStorage.removeItem(OAUTH_STATE_KEY);
    sessionStorage.removeItem(OAUTH_VERIFIER_KEY);
    selected.clear();
    const pat = document.getElementById('pat');
    if (pat) pat.value = '';
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
    const dupFiles = ITEMS.filter(i => i.dupCount > 0).length;
    const dupSets = [...hashGroups.values()].filter(g => g.length > 1).length;
    const el = document.getElementById('dupCount');
    if (el) el.textContent = String(dupFiles);
    return { dupFiles, dupSets };
  }

  function buildItem(name, oldRel) {
    const rel = 'images/' + name;
    const enc = encodePath(rel);
    const hash = extractHash(name);
    return {
      name,
      newRel: rel,
      oldRel: oldRel || OLD_MAP[rel] || '',
      hash,
      dupCount: 0,
      cdn: 'https://cdn.jsdelivr.net/gh/' + REPO.owner + '/' + REPO.repo + '@' + REPO.branch + '/' + enc,
      raw: 'https://raw.githubusercontent.com/' + REPO.owner + '/' + REPO.repo + '/' + REPO.branch + '/' + enc
    };
  }

  async function ghFetch(path, opts = {}) {
    const headers = { Accept: 'application/vnd.github+json', ...(opts.headers || {}) };
    const t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    const res = await fetch(apiBase() + path, { ...opts, headers });
    if (!res.ok) {
      let detail = res.status + ' ' + res.statusText;
      try {
        const j = await res.json();
        if (j.message) detail = j.message;
      } catch (_) { /* ignore */ }
      throw new Error(detail);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function fetchRemotePaths() {
    const data = await ghFetch('/git/trees/' + REPO.branch + '?recursive=1');
    return (data.tree || [])
      .filter(t => t.type === 'blob' && t.path.startsWith('images/'))
      .map(t => t.path)
      .sort();
  }

  async function fetchOldMapFromRemote() {
    const url =
      'https://raw.githubusercontent.com/' +
      REPO.owner + '/' + REPO.repo + '/' + REPO.branch + '/rename-mapping.csv';
    const res = await fetch(url);
    if (!res.ok) return;
    const text = await res.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let i = 1; i < lines.length; i++) {
      const m = lines[i].match(/^"([^"]*)","([^"]*)"/);
      if (m && m[2]) OLD_MAP[m[2]] = m[1];
    }
  }

  async function getFileMeta(relPath) {
    return ghFetch('/contents/' + encodePath(relPath) + '?ref=' + REPO.branch);
  }

  async function deleteFile(relPath, sha, msg) {
    await ghFetch('/contents/' + encodePath(relPath), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: msg || 'gallery: delete ' + relPath,
        sha,
        branch: REPO.branch
      })
    });
  }

  async function putFile(relPath, contentBase64, sha, msg) {
    const body = {
      message: msg || 'gallery: update ' + relPath,
      content: contentBase64,
      branch: REPO.branch
    };
    if (sha) body.sha = sha;
    return ghFetch('/contents/' + encodePath(relPath), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  function srcOf(item) {
    const source = document.getElementById('source');
    if (source.value === 'raw') return item.raw;
    if (source.value === 'local') return 'images/' + item.name;
    return item.cdn;
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
    if (el) el.textContent = '已选 ' + n;
    const del = document.getElementById('batchDelete');
    const ren = document.getElementById('batchRename');
    const rep = document.getElementById('batchReplace');
    if (del) del.disabled = n === 0;
    if (ren) ren.disabled = n !== 1;
    if (rep) rep.disabled = n !== 1;
    const all = document.getElementById('selectAll');
    if (all && filtered.length) {
      const allSel = filtered.every(i => selected.has(i.newRel));
      all.checked = allSel;
      all.indeterminate = n > 0 && !allSel;
    }
  }

  function toggleSelect(rel, on) {
    if (on) selected.add(rel);
    else selected.delete(rel);
    updateSelUI();
  }

  function render(list) {
    filtered = list;
    const grid = document.getElementById('grid');
    const stats = document.getElementById('stats');
    if (!grid) return;
    grid.innerHTML = '';

    const dupInfo = rebuildDupIndex();
    if (stats) {
      stats.innerHTML =
        '显示 <strong>' + list.length + '</strong> / ' + ITEMS.length +
        ' · 重复集 <strong>' + dupInfo.dupSets + '</strong>' +
        ' · 重复文件 <strong>' + dupInfo.dupFiles + '</strong>';
    }

    if (!list.length) {
      grid.innerHTML = '<div class="empty">没有匹配结果</div>';
      updateSelUI();
      return;
    }

    const hasToken = !!token();
    list.forEach((item, idx) => {
      const card = document.createElement('article');
      const isDup = item.dupCount > 1;
      card.className = 'card' +
        (selected.has(item.newRel) ? ' selected' : '') +
        (isDup ? ' dup' : '');
      card.style.animationDelay = Math.min(idx, 24) * 12 + 'ms';
      card.dataset.rel = item.newRel;

      const url = srcOf(item);
      const checkHtml = hasToken
        ? '<input type="checkbox" class="card-check" data-rel="' + escapeAttr(item.newRel) + '"' +
          (selected.has(item.newRel) ? ' checked' : '') + '>'
        : '';
      const badgeHtml = isDup
        ? '<span class="badge" title="同 hash 共 ' + item.dupCount + ' 张">重复 ×' + item.dupCount + '</span>'
        : '';

      card.innerHTML =
        checkHtml + badgeHtml +
        '<div class="thumb-wrap"><img loading="lazy" alt="" src="' + escapeAttr(url) + '"></div>' +
        '<div class="meta">' +
        '<div class="name">' + escapeHtml(item.name) + '</div>' +
        (item.hash ? '<div class="hash-tag">' + escapeHtml(item.hash.slice(0, 12)) + '…</div>' : '') +
        (item.oldRel ? '<div class="old">旧: ' + escapeHtml(item.oldRel) + '</div>' : '') +
        '<div class="actions">' +
        '<button type="button" data-copy="' + escapeAttr(item.name) + '">文件名</button>' +
        '<button type="button" data-copy="' + escapeAttr(url) + '">链接</button>' +
        '<a href="' + escapeAttr(url) + '" target="_blank" rel="noopener">打开</a>' +
        (hasToken
          ? '<button type="button" data-rename="' + escapeAttr(item.newRel) + '">重命名</button>' +
            '<button type="button" data-replace="' + escapeAttr(item.newRel) + '">替换</button>' +
            '<button type="button" class="del" data-delete="' + escapeAttr(item.newRel) + '">删除</button>'
          : '<button type="button" class="del" disabled title="请先 GitHub 登录">删除</button>') +
        '</div></div>';

      card.querySelector('.thumb-wrap').onclick = () => {
        document.getElementById('modalImg').src = url;
        document.getElementById('modal').classList.add('open');
      };

      const cb = card.querySelector('.card-check');
      if (cb) {
        cb.onclick = e => {
          e.stopPropagation();
          toggleSelect(item.newRel, cb.checked);
          card.classList.toggle('selected', cb.checked);
        };
      }

      card.onclick = e => {
        if (e.target.closest('button, a, input')) return;
        focused = item.name;
      };

      grid.appendChild(card);
    });
    updateSelUI();
  }

  function filter() {
    const kw = (document.getElementById('q').value || '').trim().toLowerCase();
    let list = ITEMS;
    if (dupOnly) list = list.filter(i => i.dupCount > 1);
    if (kw) {
      list = list.filter(i =>
        i.name.toLowerCase().includes(kw) ||
        (i.oldRel && i.oldRel.toLowerCase().includes(kw)) ||
        (i.hash && i.hash.includes(kw)) ||
        i.newRel.toLowerCase().includes(kw)
      );
    }
    render(list);
  }

  async function refreshFromGitHub(silent) {
    const prev = ITEMS.length;
    if (!silent) setStatus('正在从 GitHub 同步…');
    try {
      await fetchOldMapFromRemote();
      const paths = await fetchRemotePaths();
      ITEMS = paths.map(p => buildItem(p.slice(7), OLD_MAP[p]));
      rebuildDupIndex();
      selected.clear();
      filter();
      if (!silent) {
        setStatus('已同步 ' + ITEMS.length + ' 张', 'ok');
      } else if (prev !== ITEMS.length) {
        setStatus('已自动同步 ' + ITEMS.length + ' 张', 'ok');
      } else {
        setStatus('');
      }
    } catch (e) {
      rebuildDupIndex();
      filter();
      if (ITEMS.length) {
        setStatus('在线同步失败，显示缓存 ' + ITEMS.length + ' 张', 'err');
      } else {
        setStatus('加载失败: ' + e.message, 'err');
      }
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
    }
    const idx = ITEMS.findIndex(i => i.newRel === oldRel);
    if (idx >= 0) ITEMS[idx] = buildItem(newName, OLD_MAP[newRel]);
    selected.delete(oldRel);
    rebuildDupIndex();
  }

  async function replaceFile(rel, file) {
    const meta = await getFileMeta(rel);
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    const content = btoa(binary);
    await putFile(rel, content, meta.sha, 'gallery: replace ' + rel);
    const name = rel.slice(7);
    const idx = ITEMS.findIndex(i => i.newRel === rel);
    if (idx >= 0) ITEMS[idx] = buildItem(name, ITEMS[idx].oldRel);
    rebuildDupIndex();
  }

  async function deleteOne(rel) {
    if (!token()) throw new Error('请先 GitHub 登录');
    if (!confirm('确认删除？\n' + rel + '\n此操作不可恢复。')) return false;
    setStatus('删除中…');
    const meta = await getFileMeta(rel);
    await deleteFile(rel, meta.sha);
    ITEMS = ITEMS.filter(x => x.newRel !== rel);
    selected.delete(rel);
    rebuildDupIndex();
    filter();
    setStatus('已删除 ' + rel.slice(7), 'ok');
    return true;
  }

  async function batchDelete() {
    const rels = [...selected];
    if (!rels.length) return;
    if (!confirm('确认删除 ' + rels.length + ' 个文件？此操作不可恢复。')) return;
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
    setStatus(
      ok === rels.length ? '已删除 ' + ok + ' 个文件' : '部分完成，成功 ' + ok + '/' + rels.length,
      ok === rels.length ? 'ok' : 'err'
    );
  }

  function showAuthUI() {
    const loggedIn = !!token();
    const user = sessionStorage.getItem(AUTH_USER_KEY);
    const manageBar = document.getElementById('manageBar');
    const loginRow = document.getElementById('loginRow');
    const loggedRow = document.getElementById('loggedRow');
    const patRow = document.getElementById('patRow');
    const st = document.getElementById('patStatus');
    const userLabel = document.getElementById('authUser');

    if (loggedIn) {
      if (manageBar) manageBar.classList.remove('hidden');
      if (loginRow) loginRow.classList.add('hidden');
      if (loggedRow) loggedRow.classList.remove('hidden');
      if (userLabel) userLabel.textContent = user ? '@' + user : '已授权';
      if (st) st.textContent = '';
    } else {
      if (manageBar) manageBar.classList.add('hidden');
      if (loginRow) loginRow.classList.remove('hidden');
      if (loggedRow) loggedRow.classList.add('hidden');
      if (st) st.textContent = oauthClientId()
        ? '已登录 GitHub 浏览器时，点登录后一键授权即可'
        : '首次登录将自动注册 Gallery 应用（仅需一次）';
    }
    if (patRow) {
      if (loggedIn) patRow.classList.add('hidden');
    }
  }

  function bindEvents() {
    const q = document.getElementById('q');
    const source = document.getElementById('source');
    if (q) q.oninput = filter;
    if (source) source.onchange = filter;

    if (location.protocol !== 'file:') {
      const localOpt = source && source.querySelector('option[value="local"]');
      if (localOpt) localOpt.remove();
    }

    const dupChip = document.getElementById('dupFilterChip');
    const dupCb = document.getElementById('dupOnly');
    if (dupCb) {
      dupCb.onchange = () => {
        dupOnly = dupCb.checked;
        if (dupChip) dupChip.classList.toggle('on', dupOnly);
        filter();
      };
    }

    document.getElementById('grid').addEventListener('click', e => {
      const copyBtn = e.target.closest('[data-copy]');
      if (copyBtn) {
        navigator.clipboard.writeText(copyBtn.dataset.copy);
        const old = copyBtn.textContent;
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = old; }, 1000);
        return;
      }

      const del = e.target.closest('[data-delete]');
      if (del) {
        deleteOne(del.dataset.delete).catch(err => setStatus('删除失败: ' + err.message, 'err'));
        return;
      }

      const ren = e.target.closest('[data-rename]');
      if (ren) {
        const rel = ren.dataset.rename;
        const cur = rel.slice(7);
        const newName = prompt('新文件名（images/ 下）', cur);
        if (!newName || newName === cur) return;
        setStatus('重命名中…');
        renameFile(rel, newName)
          .then(() => { filter(); setStatus('重命名成功', 'ok'); })
          .catch(err => setStatus('重命名失败: ' + err.message, 'err'));
        return;
      }

      const rep = e.target.closest('[data-replace]');
      if (rep) {
        const input = document.getElementById('replaceInput');
        input.dataset.target = rep.dataset.replace;
        input.click();
      }
    });

    const replaceInput = document.getElementById('replaceInput');
    if (replaceInput) {
      replaceInput.onchange = async () => {
        const file = replaceInput.files && replaceInput.files[0];
        const rel = replaceInput.dataset.target;
        replaceInput.value = '';
        if (!file || !rel) return;
        setStatus('替换上传中…');
        try {
          await replaceFile(rel, file);
          filter();
          setStatus('替换成功', 'ok');
        } catch (e) {
          setStatus('替换失败: ' + e.message, 'err');
        }
      };
    }

    document.getElementById('copyName').onclick = () => {
      if (!focused) return alert('先点一张图选中');
      navigator.clipboard.writeText(focused);
    };

    document.getElementById('closeModal').onclick = () =>
      document.getElementById('modal').classList.remove('open');
    document.getElementById('modal').onclick = e => {
      if (e.target.id === 'modal') document.getElementById('modal').classList.remove('open');
    };

    const loginBtn = document.getElementById('githubLogin');
    if (loginBtn) loginBtn.onclick = () => loginGithub();

    const logoutBtn = document.getElementById('githubLogout');
    if (logoutBtn) logoutBtn.onclick = () => logout();

    document.getElementById('savePat').onclick = () => {
      const v = (document.getElementById('pat').value || '').trim();
      if (!v) return alert('请输入 PAT');
      saveToken(v).then(() => setStatus('PAT 已保存（仅本标签页）', 'ok'));
    };

    document.getElementById('clearPat').onclick = () => logout();

    document.getElementById('refreshList').onclick = () => refreshFromGitHub(false);

    const refreshLogged = document.getElementById('refreshListLogged');
    if (refreshLogged) refreshLogged.onclick = () => refreshFromGitHub(false);

    document.getElementById('selectAll').onchange = e => {
      const on = e.target.checked;
      filtered.forEach(i => {
        if (on) selected.add(i.newRel);
        else selected.delete(i.newRel);
      });
      filter();
    };

    document.getElementById('batchDelete').onclick = () => batchDelete();

    document.getElementById('batchRename').onclick = () => {
      if (selected.size !== 1) return;
      const rel = [...selected][0];
      const cur = rel.slice(7);
      const newName = prompt('新文件名', cur);
      if (!newName || newName === cur) return;
      setStatus('重命名中…');
      renameFile(rel, newName)
        .then(() => { filter(); setStatus('重命名成功', 'ok'); })
        .catch(err => setStatus('重命名失败: ' + err.message, 'err'));
    };

    document.getElementById('batchReplace').onclick = () => {
      if (selected.size !== 1) return;
      const input = document.getElementById('replaceInput');
      input.dataset.target = [...selected][0];
      input.click();
    };

    const patToggle = document.getElementById('patToggle');
    if (patToggle) {
      patToggle.onclick = () => {
        const row = document.getElementById('patRow');
        if (row) row.classList.toggle('hidden');
      };
    }
  }

  async function handleCallbackOnInit() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (!code) return;

    if (params.get('state')) {
      await handleOAuthReturn();
      return;
    }

    const manifest = await handleManifestReturn();
    if (manifest) await startOAuthRedirect();
  }

  async function init(opts) {
    ITEMS = (opts.items || []).map(i => {
      if (i.hash !== undefined) return i;
      return buildItem(i.name, i.oldRel);
    });
    OLD_MAP = opts.oldMap || {};
    rebuildDupIndex();
    bindEvents();
    showAuthUI();

    try {
      await handleCallbackOnInit();
    } catch (e) {
      setStatus('GitHub 登录失败: ' + e.message, 'err');
    }

    if (token() && !sessionStorage.getItem(AUTH_USER_KEY)) {
      try { await saveToken(token()); } catch (_) { /* ignore */ }
    }

    filter();
    if (location.protocol !== 'file:') {
      refreshFromGitHub(true);
    } else {
      setStatus('本地 file 打开：请用 GitHub Pages 以自动同步');
    }
  }

  global.GalleryApp = { init, refreshFromGitHub };
})(window);
