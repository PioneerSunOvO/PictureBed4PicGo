/**
 * PictureBed4PicGo — private/ media proxy (C1)
 *
 * Routes:
 *   POST /sign  — verify GitHub user token, return short-lived signed /img URL
 *   GET  /img   — serve private/ file when signature valid
 */

const UA = 'pb4pg-private-proxy/1';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    const url = new URL(request.url);
    try {
      if (url.pathname === '/sign' && request.method === 'POST') {
        return await handleSign(request, env, cors, url);
      }
      if (url.pathname === '/img' && request.method === 'GET') {
        return await handleImg(url, env, cors);
      }
      return json({ error: 'Not Found' }, 404, cors);
    } catch (e) {
      return json({ error: e.message || 'Internal Error' }, 500, cors);
    }
  }
};

function corsHeaders(env, request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  let allowOrigin = '*';
  if (allowed.length) {
    allowOrigin = allowed.includes(origin) ? origin : allowed[0];
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Max-Age': '86400'
  };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

async function hmacSign(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyGithubToken(token, env) {
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'User-Agent': UA
  };
  const userRes = await fetch('https://api.github.com/user', { headers });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  if (env.ALLOWED_LOGINS) {
    const allowed = env.ALLOWED_LOGINS.split(',').map(s => s.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(user.login)) return null;
  }
  const repo = env.REPO_OWNER + '/' + env.REPO_NAME;
  const repoRes = await fetch('https://api.github.com/repos/' + repo, { headers });
  if (!repoRes.ok) return null;
  return user;
}

function isValidPrivatePath(path) {
  return typeof path === 'string' &&
    path.startsWith('private/') &&
    !path.includes('..') &&
    path.length > 'private/'.length;
}

async function handleSign(request, env, cors, url) {
  if (!env.PROXY_SECRET) return json({ error: 'PROXY_SECRET not configured' }, 500, cors);
  const ghToken = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!ghToken) return json({ error: 'Unauthorized' }, 401, cors);
  const user = await verifyGithubToken(ghToken, env);
  if (!user) return json({ error: 'Forbidden' }, 403, cors);

  const body = await request.json().catch(() => ({}));
  const path = body.path;
  if (!isValidPrivatePath(path)) return json({ error: 'Invalid path' }, 400, cors);

  const ttl = parseInt(env.SIGN_TTL_SECONDS || '3600', 10);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = await hmacSign(env.PROXY_SECRET, path + '|' + exp);
  const imgUrl = new URL('/img', url.origin);
  imgUrl.searchParams.set('path', path);
  imgUrl.searchParams.set('exp', String(exp));
  imgUrl.searchParams.set('sig', sig);

  return json({ url: imgUrl.toString(), exp }, 200, cors);
}

function contentTypeForPath(path) {
  const ext = path.split('.').pop().toLowerCase();
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', pdf: 'application/pdf'
  };
  return map[ext] || 'application/octet-stream';
}

async function handleImg(url, env, cors) {
  if (!env.PROXY_SECRET || !env.GITHUB_PAT) {
    return new Response('Proxy not configured', { status: 500, headers: cors });
  }
  const path = url.searchParams.get('path');
  const exp = parseInt(url.searchParams.get('exp') || '0', 10);
  const sig = url.searchParams.get('sig') || '';
  if (!isValidPrivatePath(path)) return new Response('Bad Request', { status: 400, headers: cors });
  if (!exp || Math.floor(Date.now() / 1000) > exp) {
    return new Response('Expired', { status: 410, headers: cors });
  }
  const expected = await hmacSign(env.PROXY_SECRET, path + '|' + exp);
  if (sig !== expected) return new Response('Forbidden', { status: 403, headers: cors });

  const branch = env.REPO_BRANCH || 'master';
  const enc = path.split('/').map(encodeURIComponent).join('/');
  const apiUrl = 'https://api.github.com/repos/' + env.REPO_OWNER + '/' + env.REPO_NAME +
    '/contents/' + enc + '?ref=' + encodeURIComponent(branch);
  const res = await fetch(apiUrl, {
    headers: {
      Authorization: 'Bearer ' + env.GITHUB_PAT,
      Accept: 'application/vnd.github+json',
      'User-Agent': UA
    }
  });
  if (!res.ok) return new Response('Not Found', { status: 404, headers: cors });
  const meta = await res.json();
  if (!meta.content) return new Response('Not Found', { status: 404, headers: cors });
  const bin = atob(meta.content.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, {
    headers: {
      ...cors,
      'Content-Type': contentTypeForPath(path),
      'Cache-Control': 'private, max-age=300'
    }
  });
}
