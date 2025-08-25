'use strict';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';

// Persistent secret file (survives restarts). If AUTH_SECRET env provided, that overrides file.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SECRET_FILE = path.join(__dirname, 'auth-secret.key');
function loadSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const v = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (v) return v;
    }
  } catch {}
  const secret = crypto.randomBytes(48).toString('hex');
  try { fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 }); } catch {}
  return secret;
}
const SECRET = loadSecret();

// Optional credentials file: first line = username, second line = password
const CRED_FILE = process.env.ADMIN_CRED_FILE || '/root/vpn-admin.txt';
function readFileCreds() {
  try {
    const raw = fs.readFileSync(CRED_FILE, 'utf8');
    const lines = raw.split(/\r?\n/).map(l=>l.trim()).filter(l=>l.length>0);
    if (lines.length >= 1) {
      return { adminUser: lines[0], adminPass: lines[1] || '' };
    }
  } catch {}
  return null;
}
let _cachedCreds = null;
function loadCreds() {
  const fileCreds = readFileCreds();
  if (fileCreds) { _cachedCreds = fileCreds; return; }
  _cachedCreds = { adminUser: process.env.ADMIN_USER || 'admin', adminPass: process.env.ADMIN_PASS || 'admin' };
}
loadCreds();

// Hot-reload: watch the credential file for changes / creation / deletion
try {
  fs.watch(path.dirname(CRED_FILE), { persistent: false }, (evt, fname) => {
    if (!fname) return;
    if (path.join(path.dirname(CRED_FILE), fname) !== CRED_FILE) return;
    // Delay a tick to allow file write complete
    setTimeout(() => {
      const before = _cachedCreds?.adminUser + ':' + (_cachedCreds?.adminPass||'');
      loadCreds();
      const after = _cachedCreds?.adminUser + ':' + (_cachedCreds?.adminPass||'');
      if (before !== after) console.log('[AUTH] Credentials hot-reloaded');
    }, 50);
  });
} catch {}

const DEFAULT_TTL_SECONDS = Number(process.env.AUTH_TOKEN_TTL || 21600); // 6h

function constantTimeEquals(a='', b='') {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function getAuthConfig() {
  return _cachedCreds;
}

function issueJwt(user) {
  const exp = Math.floor(Date.now()/1000) + DEFAULT_TTL_SECONDS;
  const token = jwt.sign({ sub: user, iat: Math.floor(Date.now()/1000), exp }, SECRET, { algorithm: 'HS256' });
  return { token, exp: exp * 1000 };
}

function registerAuth(app) {
  console.log('[AUTH] Registering auth routes (/api/login, /api/refresh, /api/logout)');
  // Login
  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const { adminUser, adminPass } = getAuthConfig();
    if (!constantTimeEquals(username || '', adminUser) || !constantTimeEquals(password || '', adminPass)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const { token, exp } = issueJwt(username);
    res.json({ token, expiresIn: Math.floor((exp - Date.now())/1000) });
  });

  // Refresh (requires valid token)
  app.post('/api/refresh', (req, res) => {
    const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i,'');
    try {
      const decoded = jwt.verify(raw, SECRET, { algorithms: ['HS256'] });
      const { token, exp } = issueJwt(decoded.sub);
      return res.json({ token, expiresIn: Math.floor((exp - Date.now())/1000) });
    } catch {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  });

  // Logout (stateless JWT → client discard)
  app.post('/api/logout', (_req, res) => {
    res.json({ ok: true });
  });

  // Diagnostic helper (GET) – returns 200 if auth routes are mounted (no auth required)
  app.get('/api/login-info', (_req, res) => {
    res.json({ loginRoute: true, method: 'POST', expects: 'username,password JSON', file: 'auth.js' });
  });
}

function requireAuth(req, res, next) {
  if (req.path === '/login') return next();
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i,'');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    req.user = decoded.sub;
    return next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

export default { registerAuth, requireAuth };