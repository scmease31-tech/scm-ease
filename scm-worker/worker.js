// SCM Ease Admin Worker — Cloudflare Workers
// Env vars needed: ADMIN_ID, ADMIN_PASS, ADMIN_EMAIL, GITHUB_TOKEN, JWT_SECRET, RESEND_API_KEY (optional)
const GITHUB_REPO = 'sohildobariya31-blip/scm-ease';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

// ── JWT helpers (HMAC-SHA256) ──────────────────────────────────────────
async function signToken(payload, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=+$/, '');
  const body = btoa(JSON.stringify(payload)).replace(/=+$/, '');
  const data = `${header}.${body}`;
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${data}.${sigB64}`;
}

async function verifyToken(token, secret) {
  try {
    const [header, body, sig] = token.split('.');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(`${header}.${body}`));
    if (!valid) return null;
    const payload = JSON.parse(atob(body));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// ── GitHub helpers ─────────────────────────────────────────────────────
async function ghGet(path, token) {
  const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'SCM-Worker' },
  });
  if (!r.ok) throw new Error(`GitHub GET ${path}: ${r.status}`);
  return r.json();
}

async function ghPut(path, content, sha, message, token) {
  const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'SCM-Worker', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content, sha }),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`GitHub PUT ${path}: ${r.status} ${t}`); }
  return r.json();
}

// safe base64 encode/decode for unicode
function b64Encode(str) { return btoa(String.fromCharCode(...new TextEncoder().encode(str))); }
function b64Decode(b64) { return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))); }

// ── Handlers ──────────────────────────────────────────────────────────
async function handleLogin(body, env) {
  const { id, password } = body;
  if (!id || !password) return jsonResp({ error: 'Missing credentials' }, 400);
  if (String(id) !== env.ADMIN_ID || password !== env.ADMIN_PASS)
    return jsonResp({ error: 'Invalid credentials' }, 401);
  const token = await signToken({ sub: 'admin', exp: Math.floor(Date.now() / 1000) + 86400 }, env.JWT_SECRET);
  return jsonResp({ token });
}

async function handleSave(body, env, authHeader) {
  // validate JWT
  const token = (authHeader || '').replace('Bearer ', '');
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload) return jsonResp({ error: 'Unauthorized' }, 401);

  const { baseModules: newModules } = body;
  if (!newModules) return jsonResp({ error: 'Missing baseModules' }, 400);

  // fetch current index.html from GitHub
  const file = await ghGet('index.html', env.GITHUB_TOKEN);
  const html = b64Decode(file.content.replace(/\n/g, ''));

  // replace baseModules line
  const newVersion = Date.now();
  const modulesJson = JSON.stringify(newModules);
  let updated = html.replace(
    /^const baseModules = \[.*\];$/m,
    `const baseModules = ${modulesJson};`
  );
  // replace _BASE_VERSION line
  updated = updated.replace(
    /^const _BASE_VERSION = .*?;$/m,
    `const _BASE_VERSION = ${newVersion};`
  );

  // commit back
  const encoded = b64Encode(updated);
  await ghPut('index.html', encoded, file.sha, `Admin update: modules & version ${newVersion}`, env.GITHUB_TOKEN);

  return jsonResp({ ok: true, version: newVersion });
}

async function handleForgot(body, env) {
  const { email } = body;
  if (!email || email !== env.ADMIN_EMAIL) return jsonResp({ error: 'Email not recognized' }, 400);
  if (!env.RESEND_API_KEY) return jsonResp({ error: 'Email service not configured' }, 500);

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SCM Ease Admin <onboarding@resend.dev>',
      to: [email],
      subject: 'SCM Ease — Your Admin Credentials',
      html: `<h2>SCM Ease Admin Credentials</h2><p><b>ID:</b> ${env.ADMIN_ID}</p><p><b>Password:</b> ${env.ADMIN_PASS}</p><p>Keep these safe.</p>`,
    }),
  });
  if (!r.ok) return jsonResp({ error: 'Failed to send email' }, 500);
  return jsonResp({ ok: true, message: 'Credentials sent to your email' });
}

// ── Main ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method !== 'POST') return jsonResp({ error: 'Method not allowed' }, 405);

    try {
      const body = await request.json();
      if (path === '/api/login') return handleLogin(body, env);
      if (path === '/api/save') return handleSave(body, env, request.headers.get('Authorization'));
      if (path === '/api/forgot') return handleForgot(body, env);
      return jsonResp({ error: 'Not found' }, 404);
    } catch (e) {
      return jsonResp({ error: e.message || 'Internal error' }, 500);
    }
  },
};
