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
  // Log the login event
  await appendLog(env, { type: 'login', user: String(id), ts: new Date().toISOString() });
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

  // Log the deploy event
  await appendLog(env, { type: 'deploy', user: 'admin', ts: new Date().toISOString(), detail: `Deployed ${newModules.length} modules, version ${newVersion}` });

  return jsonResp({ ok: true, version: newVersion });
}

async function handleForgot(body, env) {
  const { email } = body;
  const adminEmail = env.ADMIN_EMAIL || 'sohildobariya31@gmail.com';
  if (!email || (email !== adminEmail && email !== 'sohildobariya31@gmail.com')) return jsonResp({ error: 'Email not recognized' }, 400);
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

// ── Forgot-request (name + selfie → email to admin) ──────────────────
async function handleForgotRequest(body, env) {
  const { name, selfie, fileName } = body;
  if (!name) return jsonResp({ error: 'Name is required' }, 400);
  if (!selfie) return jsonResp({ error: 'Selfie is required' }, 400);
  if (!env.RESEND_API_KEY) return jsonResp({ error: 'Email service not configured' }, 500);

  // selfie arrives as data:image/...;base64,XXXX
  const parts = selfie.split(',');
  const mimeMatch = (parts[0] || '').match(/data:(.*?);/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const b64Data = parts[1] || '';
  const ext = (fileName || 'selfie.jpg').split('.').pop();

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SCM Ease <onboarding@resend.dev>',
      to: ['sohildobariya31@gmail.com'],
      subject: `SCM Ease — Credential Request from ${name}`,
      html: `<h2>Credential Request</h2><p><b>Name:</b> ${name}</p><p>This user is asking for their ID and password. Their selfie is attached.</p><p>Please reply to them with their credentials.</p>`,
      attachments: [{ filename: `selfie_${name.replace(/\s+/g,'_')}.${ext}`, content: b64Data, type: mimeType }],
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    return jsonResp({ error: 'Failed to send email' }, 500);
  }
  return jsonResp({ ok: true, message: 'Request sent successfully' });
}

// ── Activity Log helpers ──────────────────────────────────────────────
const LOG_KEY = 'activity_log';
const MAX_LOGS = 500;
const USERS_KEY = 'app_users';
const PERMISSIONS_KEY = 'user_permissions';
const DEFAULT_USERS = [
  {name:'Nikita',password:'nikita'},{name:'Akshay',password:'akshay'},
  {name:'Megha',password:'megha'},{name:'Piyush',password:'piyush'},
  {name:'Purvi',password:'purvi'},{name:'Khushi',password:'khushi'},
  {name:'Rajesh',password:'rajesh'}
];
const DEFAULT_PERMS = { calc: true, calc_changes: false, plan: true, plan_edit: true, plan_changes: false, cell: true, vendor: true, vendor_edit: true, explorer: true };
const ALLOWED_PERM_KEYS = ['calc', 'calc_changes', 'plan', 'plan_edit', 'plan_changes', 'cell', 'vendor', 'vendor_edit', 'explorer'];
const CONSUMPTION_DEFAULTS_KEY = 'consumption_defaults';
const PLANNING_CONFIG_KEY = 'planning_config';

async function getUsers(env) {
  const raw = await env.LOGS.get(USERS_KEY);
  if (!raw) { await env.LOGS.put(USERS_KEY, JSON.stringify(DEFAULT_USERS)); return [...DEFAULT_USERS]; }
  return JSON.parse(raw);
}
async function saveUsers(env, users) { await env.LOGS.put(USERS_KEY, JSON.stringify(users)); }

async function getAllPermissions(env) {
  const raw = await env.LOGS.get(PERMISSIONS_KEY);
  if (!raw) return {};
  return JSON.parse(raw);
}
async function saveAllPermissions(env, perms) { await env.LOGS.put(PERMISSIONS_KEY, JSON.stringify(perms)); }

// Check if a user has a specific permission
async function userHasPermission(env, userName, permKey) {
  if (!userName || !permKey) return false;
  const allPerms = await getAllPermissions(env);
  const userPerms = allPerms[userName.toLowerCase()] || { ...DEFAULT_PERMS };
  return !!userPerms[permKey];
}

// Verify user credentials and return name if valid
async function verifyUserCredentials(env, userName, password) {
  if (!userName || !password) return null;
  const users = await getUsers(env);
  const match = users.find(u => u.name.toLowerCase() === userName.toLowerCase() && u.password === password);
  return match ? match.name : null;
}

// Verify a vendor user credential
async function handleVerifyUser(body, env) {
  const { id, password } = body;
  if (!id || !password) return jsonResp({ error: 'Missing credentials' }, 400);
  const users = await getUsers(env);
  const match = users.find(u => u.name.toLowerCase() === id.toLowerCase() && u.password === password);
  if (!match) return jsonResp({ error: 'Invalid credentials' }, 401);
  return jsonResp({ ok: true, user: match.name });
}

// List all users (admin only)
async function handleListUsers(env, authHeader) {
  const token = (authHeader || '').replace('Bearer ', '');
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload) return jsonResp({ error: 'Unauthorized' }, 401);
  const users = await getUsers(env);
  return jsonResp({ users: users.map(u => ({ name: u.name, password: u.password })) });
}

// Add user (admin only)
async function handleAddUser(body, env, authHeader) {
  const token = (authHeader || '').replace('Bearer ', '');
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload) return jsonResp({ error: 'Unauthorized' }, 401);
  const { name, password } = body;
  if (!name || !password) return jsonResp({ error: 'Name and password required' }, 400);
  if (name.length > 30 || password.length > 50) return jsonResp({ error: 'Name/password too long' }, 400);
  const users = await getUsers(env);
  if (users.find(u => u.name.toLowerCase() === name.toLowerCase())) return jsonResp({ error: 'User already exists' }, 409);
  users.push({ name: name.trim(), password: password.trim() });
  await saveUsers(env, users);
  await appendLog(env, { type: 'user-mgmt', user: 'admin', ts: new Date().toISOString(), detail: `Added user: ${name}` });
  return jsonResp({ ok: true });
}

// Update user password (admin only)
async function handleUpdateUser(body, env, authHeader) {
  const token = (authHeader || '').replace('Bearer ', '');
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload) return jsonResp({ error: 'Unauthorized' }, 401);
  const { name, password } = body;
  if (!name || !password) return jsonResp({ error: 'Name and password required' }, 400);
  const users = await getUsers(env);
  const idx = users.findIndex(u => u.name.toLowerCase() === name.toLowerCase());
  if (idx === -1) return jsonResp({ error: 'User not found' }, 404);
  users[idx].password = password.trim();
  await saveUsers(env, users);
  await appendLog(env, { type: 'user-mgmt', user: 'admin', ts: new Date().toISOString(), detail: `Changed password for: ${name}` });
  return jsonResp({ ok: true });
}

// Delete user (admin only)
async function handleDeleteUser(body, env, authHeader) {
  const token = (authHeader || '').replace('Bearer ', '');
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload) return jsonResp({ error: 'Unauthorized' }, 401);
  const { name } = body;
  if (!name) return jsonResp({ error: 'Name required' }, 400);
  const users = await getUsers(env);
  const idx = users.findIndex(u => u.name.toLowerCase() === name.toLowerCase());
  if (idx === -1) return jsonResp({ error: 'User not found' }, 404);
  users.splice(idx, 1);
  await saveUsers(env, users);
  // Also remove permissions for deleted user
  const perms = await getAllPermissions(env);
  delete perms[name.toLowerCase()];
  await saveAllPermissions(env, perms);
  await appendLog(env, { type: 'user-mgmt', user: 'admin', ts: new Date().toISOString(), detail: `Deleted user: ${name}` });
  return jsonResp({ ok: true });
}

// Get all user permissions (admin only)
async function handleGetPermissions(env, authHeader) {
  const token = (authHeader || '').replace('Bearer ', '');
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload) return jsonResp({ error: 'Unauthorized' }, 401);
  const perms = await getAllPermissions(env);
  return jsonResp({ permissions: perms, defaults: DEFAULT_PERMS });
}

// Update a user's permissions (admin only)
async function handleUpdatePermissions(body, env, authHeader) {
  const token = (authHeader || '').replace('Bearer ', '');
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload) return jsonResp({ error: 'Unauthorized' }, 401);
  const { name, permissions } = body;
  if (!name || !permissions || typeof permissions !== 'object') return jsonResp({ error: 'Name and permissions required' }, 400);
  if (name.length > 50) return jsonResp({ error: 'Name too long' }, 400);
  const clean = {};
  for (const k of ALLOWED_PERM_KEYS) { clean[k] = !!permissions[k]; }
  const allPerms = await getAllPermissions(env);
  allPerms[name.toLowerCase()] = clean;
  await saveAllPermissions(env, allPerms);
  await appendLog(env, { type: 'permission', user: 'admin', ts: new Date().toISOString(), detail: `Updated permissions for: ${name}` });
  return jsonResp({ ok: true });
}

// Get permissions for a specific user (called after gate login)
async function handleGetUserPermissions(body, env) {
  const { name } = body;
  if (!name || typeof name !== 'string') return jsonResp({ error: 'Name required' }, 400);
  const allPerms = await getAllPermissions(env);
  const userPerms = allPerms[name.toLowerCase()] || { ...DEFAULT_PERMS };
  return jsonResp({ permissions: userPerms });
}

// ── Consumption Defaults ──────────────────────────────────────────────
async function handleSaveConsumptionDefaults(body, env, authHeader) {
  // Admin JWT auth
  const token = (authHeader || '').replace('Bearer ', '');
  const payload = await verifyToken(token, env.JWT_SECRET);
  let actingUser = 'admin';
  // If no admin token, check user permission
  if (!payload) {
    const { userName, userPassword } = body;
    const verified = await verifyUserCredentials(env, userName, userPassword);
    if (!verified) return jsonResp({ error: 'Unauthorized' }, 401);
    const hasPerm = await userHasPermission(env, verified, 'calc_changes');
    if (!hasPerm) return jsonResp({ error: 'No calc_changes permission' }, 403);
    actingUser = verified;
  }
  const { modules } = body;
  if (!modules || !Array.isArray(modules)) return jsonResp({ error: 'Modules array required' }, 400);
  const data = JSON.stringify(modules);
  if (data.length > 2 * 1024 * 1024) return jsonResp({ error: 'Data too large' }, 413);
  await env.LOGS.put(CONSUMPTION_DEFAULTS_KEY, data);
  await appendLog(env, { type: 'config', user: actingUser, ts: new Date().toISOString(), detail: 'Saved consumption defaults' });
  return jsonResp({ ok: true });
}

async function handleGetConsumptionDefaults(env) {
  const raw = await env.LOGS.get(CONSUMPTION_DEFAULTS_KEY);
  if (!raw) return jsonResp({ defaults: null });
  try { return jsonResp({ defaults: JSON.parse(raw) }); }
  catch { return jsonResp({ defaults: null }); }
}

// ── Planning Config (customer module overrides, shared across all users) ──
async function handleSavePlanningConfig(body, env) {
  // Check permission: admin token or user with plan_changes
  const { userName, userPassword, customerModuleOverrides } = body;
  if (userName && userPassword) {
    const verified = await verifyUserCredentials(env, userName, userPassword);
    if (!verified) return jsonResp({ error: 'Unauthorized' }, 401);
    const hasPerm = await userHasPermission(env, verified, 'plan_changes');
    if (!hasPerm) return jsonResp({ error: 'No plan_changes permission' }, 403);
  }
  if (!customerModuleOverrides || typeof customerModuleOverrides !== 'object')
    return jsonResp({ error: 'customerModuleOverrides object required' }, 400);
  const data = JSON.stringify({ customerModuleOverrides, _ts: Date.now() });
  if (data.length > 2 * 1024 * 1024) return jsonResp({ error: 'Data too large' }, 413);
  await env.LOGS.put(PLANNING_CONFIG_KEY, data);
  return jsonResp({ ok: true });
}

async function handleGetPlanningConfig(env) {
  const raw = await env.LOGS.get(PLANNING_CONFIG_KEY);
  if (!raw) return jsonResp({ customerModuleOverrides: {} });
  try { return jsonResp(JSON.parse(raw)); }
  catch { return jsonResp({ customerModuleOverrides: {} }); }
}

async function appendLog(env, entry) {
  try {
    const raw = await env.LOGS.get(LOG_KEY);
    const logs = raw ? JSON.parse(raw) : [];
    logs.unshift(entry);
    if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
    await env.LOGS.put(LOG_KEY, JSON.stringify(logs));
  } catch { /* silent fail for logging */ }
}

async function handleGetLogs(env, authHeader) {
  const token = (authHeader || '').replace('Bearer ', '');
  if (!token) return jsonResp({ error: 'Unauthorized' }, 401);
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload) return jsonResp({ error: 'Unauthorized' }, 401);
  const raw = await env.LOGS.get(LOG_KEY);
  const logs = raw ? JSON.parse(raw) : [];
  return jsonResp({ logs });
}

async function handleGateLogin(body, env) {
  const { user } = body;
  if (!user || typeof user !== 'string' || user.length > 50) return jsonResp({ error: 'Invalid user' }, 400);
  await appendLog(env, { type: 'login', user, ts: new Date().toISOString() });
  return jsonResp({ ok: true });
}

async function handleAddLog(body, env, authHeader) {
  const token = (authHeader || '').replace('Bearer ', '');
  if (!token) return jsonResp({ error: 'Unauthorized' }, 401);
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload) return jsonResp({ error: 'Unauthorized' }, 401);
  const { type, detail } = body;
  if (!type) return jsonResp({ error: 'Missing type' }, 400);
  const safeType = String(type).slice(0, 50);
  const safeDetail = String(detail || '').slice(0, 500);
  await appendLog(env, { type: safeType, user: 'admin', ts: new Date().toISOString(), detail: safeDetail });
  return jsonResp({ ok: true });
}

// ── Customer Data persistence (KV) ────────────────────────────────────
const CUSTOMER_DATA_KEY = 'customer_mappings_data';

async function handleSaveCustomerData(body, env) {
  // Check permission: admin or user with plan_changes
  const { customerStockMappings, customerVariantSelections, _ts, userName, userPassword } = body;
  if (userName && userPassword) {
    const verified = await verifyUserCredentials(env, userName, userPassword);
    if (!verified) return jsonResp({ error: 'Unauthorized' }, 401);
    const hasPerm = await userHasPermission(env, verified, 'plan_changes');
    if (!hasPerm) return jsonResp({ error: 'No plan_changes permission' }, 403);
  }
  if (!customerStockMappings && !customerVariantSelections) return jsonResp({ error: 'No data provided' }, 400);
  const data = JSON.stringify({ customerStockMappings: customerStockMappings || {}, customerVariantSelections: customerVariantSelections || {}, _ts: _ts || Date.now() });
  if (data.length > 5 * 1024 * 1024) return jsonResp({ error: 'Data too large' }, 413);
  await env.LOGS.put(CUSTOMER_DATA_KEY, data);
  return jsonResp({ ok: true });
}

async function handleGetCustomerData(env) {
  const raw = await env.LOGS.get(CUSTOMER_DATA_KEY);
  if (!raw) return jsonResp({ customerStockMappings: {}, customerVariantSelections: {} });
  try {
    return jsonResp(JSON.parse(raw));
  } catch { return jsonResp({ customerStockMappings: {}, customerVariantSelections: {} }); }
}

// ── Main ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    // Allow GET for logs, users, and customer data
    if (request.method === 'GET' && path === '/api/logs') {
      return handleGetLogs(env, request.headers.get('Authorization'));
    }
    if (request.method === 'GET' && path === '/api/users') {
      return handleListUsers(env, request.headers.get('Authorization'));
    }
    if (request.method === 'GET' && path === '/api/permissions') {
      return handleGetPermissions(env, request.headers.get('Authorization'));
    }
    if (request.method === 'GET' && path === '/api/customer-data') {
      return handleGetCustomerData(env);
    }
    if (request.method === 'GET' && path === '/api/consumption-defaults') {
      return handleGetConsumptionDefaults(env);
    }
    if (request.method === 'GET' && path === '/api/planning-config') {
      return handleGetPlanningConfig(env);
    }

    if (request.method !== 'POST') return jsonResp({ error: 'Method not allowed' }, 405);

    try {
      const body = await request.json();
      if (path === '/api/login') return handleLogin(body, env);
      if (path === '/api/save') return handleSave(body, env, request.headers.get('Authorization'));
      if (path === '/api/forgot') return handleForgot(body, env);
      if (path === '/api/forgot-request') return handleForgotRequest(body, env);
      if (path === '/api/log') return handleAddLog(body, env, request.headers.get('Authorization'));
      if (path === '/api/gate-login') return handleGateLogin(body, env);
      if (path === '/api/verify-user') return handleVerifyUser(body, env);
      if (path === '/api/users/add') return handleAddUser(body, env, request.headers.get('Authorization'));
      if (path === '/api/users/update') return handleUpdateUser(body, env, request.headers.get('Authorization'));
      if (path === '/api/users/delete') return handleDeleteUser(body, env, request.headers.get('Authorization'));
      if (path === '/api/permissions/update') return handleUpdatePermissions(body, env, request.headers.get('Authorization'));
      if (path === '/api/user-permissions') return handleGetUserPermissions(body, env);
      if (path === '/api/consumption-defaults') return handleSaveConsumptionDefaults(body, env, request.headers.get('Authorization'));
      if (path === '/api/customer-data') return handleSaveCustomerData(body, env);
      if (path === '/api/planning-config') return handleSavePlanningConfig(body, env);
      return jsonResp({ error: 'Not found' }, 404);
    } catch (e) {
      return jsonResp({ error: e.message || 'Internal error' }, 500);
    }
  },
};
