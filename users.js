'use strict';
import path from 'path';

/**
 * User management routes:
 * - GET /api/users
 * - POST /api/users
 * - DELETE /api/users/:username
 * - POST /api/users/:username/reset-quota
 *
 * Features:
 * - List/add/remove VPN users
 * - View user connection stats (bandwidth usage from Xray)
 * - Set user limits (bandwidth quota in GB, max connections value, expiry date)
 * - Reset quota for specific users (usage reset only)
 * - Auto-disable users if over bandwidth quota, expired, or over connection limit (heuristic)
 * - vless:// URL generation
 *
 * Notes:
 * - Bandwidth usage is read live from Xray API (uplink+downlink), converted to GB with 2 decimals.
 * - Connection limit is enforced heuristically via recent access.log entries per UUID.
 * - After any change to Xray client list, the service is reloaded automatically.
 *
 * @param {import('express').Express} app
 * @param {*} utils - shared utilities (see utils.js)
 */
function registerUserRoutes(app, utils) {
  const {
    USERS_FILE,
    CONFIG_FILE,
    readJson,
    writeJson,
    bytesToGB,
  getUserTraffic,
  getUserTrafficMulti,
  resetUserTrafficCounters,
  reloadXray,
  getRecentUuidCounts,
  } = utils;

  /**
   * Build desired VLESS clients array (id=uuid, email=username) from users list (enabled only).
   * @param {Array} users
   */
  function buildDesiredClients(users) {
    return users
      .filter(u => u.enabled !== false)
      .map(u => ({ id: u.uuid, email: u.username, level: 0 }));
  }

  // ---- Background usage aggregation cache (new fast path) ----
  let _cachedEnriched = [];
  let _cacheStamp = 0;
  let _isAggregating = false;
  const AGG_INTERVAL_MS = 5000;
  
  // Persist only enabled flag changes (avoid rewriting whole usage stats each poll)
  function persistEnabledFlags(enriched) {
    try {
      const orig = baseLoadUsers();
      let changed = false;
      const byId = new Map(enriched.map(u=>[u.id,u.enabled]));
      for (const u of orig) {
        const newEnabled = byId.get(u.id);
        if (typeof newEnabled === 'boolean' && newEnabled !== u.enabled) { u.enabled = newEnabled; changed = true; }
      }
      if (changed) writeJson(USERS_FILE, orig);
    } catch(e) { /* silent */ }
  }

  // Lightweight accumulateUsage used by mutation endpoints just to fold current cached usage-store values.
  function accumulateUsage(users) {
    try {
      const dir = path.dirname(USERS_FILE);
      const USAGE_FILE = path.join(dir, 'usage-store.json');
      let store = {}; try { store = utils.readJson(USAGE_FILE); } catch {}
      for (const u of users) {
        const rec = store[u.uuid];
        if (rec) { u.usageAccumBytes = rec.accumBytes; u.lastRawBytes = rec.lastRawBytes; }
      }
    } catch { /* ignore */ }
  }

  // Sync desired VLESS clients into Xray config file; return true if config changed.
  function syncVlessClients(users) {
    try {
      const desired = buildDesiredClients(users);
      const cfg = utils.readJson(CONFIG_FILE);
      if (!Array.isArray(cfg.inbounds)) return false;
      // Find first vless inbound with settings.clients
      let changed = false;
      for (const inbound of cfg.inbounds) {
        if (inbound?.protocol === 'vless' && inbound?.settings && Array.isArray(inbound.settings.clients)) {
          const prev = inbound.settings.clients;
          // Cheap diff compare (stringify sorted by id)
          const norm = a => JSON.stringify(a.map(c=>({id:c.id,email:c.email,level:c.level})).sort((a,b)=>a.id.localeCompare(b.id)));
          if (norm(prev) !== norm(desired)) {
            inbound.settings.clients = desired;
            changed = true;
          }
          break;
        }
      }
      if (changed) {
        writeJson(CONFIG_FILE, cfg);
        utils.reloadXray?.();
      }
      return changed;
    } catch(e) {
      console.warn('[SYNC_VLESS] failed', e.message);
      return false;
    }
  }
  // Async stats helper (non-blocking) for background aggregation
  async function accumulateUsageAsync(users) {
    const dir = path.dirname(USERS_FILE);
    const USAGE_FILE = path.join(dir, 'usage-store.json');
    let store = {};
    try { store = utils.readJson(USAGE_FILE); } catch { store = {}; }
    let storeChanged = false;
    const concurrency = 6;
    let idx = 0;
    async function worker() {
      while (idx < users.length) {
        const i = idx++;
        const u = users[i];
        const key = u.uuid;
        const statKey = u.statKey || u.displayName || u.username || u.uuid;
        let rawBytes = 0;
        try {
          const { stdout } = await utils.runCmd(`timeout 0.5s ${utils.XRAY_BIN} api statsquery --server=127.0.0.1:${utils.XRAY_API_PORT} --pattern \"user>>>${statKey}\"`).catch(()=>({stdout:''}));
          if (stdout.includes('stat')) {
            try {
              const j = JSON.parse(stdout);
              for (const s of j.stat || []) {
                if (s?.name && s.name.startsWith(`user>>>${statKey}>>>traffic>>>`) && typeof s.value === 'number') rawBytes += s.value;
              }
            } catch {}
          }
        } catch {}
        const prev = store[key] || { accumBytes: 0, lastRawBytes: rawBytes };
        if (!store[key]) { prev.accumBytes = rawBytes; prev.lastRawBytes = rawBytes; storeChanged = true; }
        else if (rawBytes >= prev.lastRawBytes) {
          if (rawBytes > prev.lastRawBytes) { prev.accumBytes += (rawBytes - prev.lastRawBytes); prev.lastRawBytes = rawBytes; storeChanged = true; }
        } else { prev.accumBytes += rawBytes; prev.lastRawBytes = rawBytes; storeChanged = true; }
        store[key] = prev;
        u.usageAccumBytes = prev.accumBytes;
        u.lastRawBytes = prev.lastRawBytes;
      }
    }
    await Promise.all(Array.from({length: Math.min(concurrency, users.length)}, () => worker()));
    if (storeChanged) try { writeJson(USAGE_FILE, store); } catch {}
  }
  function baseLoadUsers() {
    let users = readJson(USERS_FILE);
    let needPersist = false;
    let maxId = users.reduce((m,u)=> Number.isFinite(u.id)?Math.max(m,u.id):m, 0);
    for (const u of users) {
      if (!Number.isFinite(u.id)) { u.id = ++maxId; needPersist = true; }
      if (!u.statKey) { u.statKey = u.displayName || u.username || u.uuid; needPersist = true; }
    }
    if (needPersist) writeJson(USERS_FILE, users);
    return users;
  }
  async function aggregate(trigger) {
    if (_isAggregating) return;
    _isAggregating = true;
    const start = Date.now();
    try {
      let users = baseLoadUsers();
      await accumulateUsageAsync(users);
      const now = Date.now();
      const enriched = users.map(u => {
        const usagePreciseGB = (u.usageAccumBytes || 0) / 1073741824;
        const usageGB = +usagePreciseGB.toFixed(2);
        const daysLeft = u.expiry ? Math.max(0, Math.ceil((new Date(u.expiry) - now)/86400000)) : -1;
        const quotaGB = (typeof u.quota === 'number' && u.quota !== -1) ? u.quota : -1;
        const remainingPreciseGB = quotaGB === -1 ? -1 : Math.max(0, quotaGB - usagePreciseGB);
        const remainingGB = remainingPreciseGB === -1 ? -1 : +remainingPreciseGB.toFixed(2);
        let enabled = !!u.enabled;
        if ((quotaGB !== -1 && usagePreciseGB >= quotaGB) || (u.expiry && daysLeft <= 0)) enabled = false;
        if (enabled !== u.enabled) { u.enabled = enabled; }
        const PUBLIC_HOST = process.env.PUBLIC_HOST || 'aparat.feezor.net';
        const WS_PATH = '/aparat.com/v/';
        const label = encodeURIComponent(u.displayName || u.username);
        const params = new URLSearchParams({ encryption: 'none', security: 'tls', sni: PUBLIC_HOST, alpn: 'h3,h2,http/1.1', allowInsecure: '1', type: 'ws', host: PUBLIC_HOST, path: WS_PATH });
        const vlessUrl = `vless://${u.uuid}@${PUBLIC_HOST}:443?${params.toString()}#${label}`;
        return { ...u, bandwidthUsage: usageGB, bandwidthUsageRaw: usagePreciseGB, remainingBandwidth: remainingGB, remainingBandwidthRaw: remainingPreciseGB, daysLeft, vlessUrl };
      });
      persistEnabledFlags(enriched);
      _cachedEnriched = enriched;
      _cacheStamp = Date.now();
      const dur = Date.now() - start;
      if (dur > 1000) console.log('[BG_AGG] ms=', dur, 'users=', enriched.length, 'trigger=', trigger);
    } catch (e) { console.warn('[BG_AGG] fail', e.message); }
    finally { _isAggregating = false; }
  }
  setInterval(()=>aggregate('interval'), AGG_INTERVAL_MS).unref();
  setTimeout(()=>aggregate('startup'), 50).unref();

  // Fast cached version
  app.get('/api/users', (req,res)=>{
    const t0 = Date.now();
    try {
      if (req.query.diag === 'raw') {
        const raw = _cachedEnriched.length ? _cachedEnriched : baseLoadUsers();
        return res.json(raw.map(u=>({id:u.id, username:u.username, expiry:u.expiry, quota:u.quota, enabled:u.enabled})));
      }
      if (Date.now() - _cacheStamp > AGG_INTERVAL_MS*2 && !_isAggregating) aggregate('stale');
      if (req.query.refresh==='1') setTimeout(()=>aggregate('manual'),10).unref();
      const enriched = _cachedEnriched.length ? _cachedEnriched : baseLoadUsers();
      try { res.set({'Cache-Control':'no-store, no-cache, must-revalidate, max-age=0','Pragma':'no-cache','Expires':'0'}); res.removeHeader('ETag'); } catch {}
      const response = enriched.map(u=>({
        id:u.id, username:u.username, uuid:u.uuid, displayName:u.displayName||'', expiry:u.expiry||'', quota:(typeof u.quota==='number')?u.quota:-1, enabled:!!u.enabled,
        bandwidthUsage:+((u.bandwidthUsage||0).toFixed(2)), bandwidthUsageRaw:u.bandwidthUsageRaw||(u.bandwidthUsage||0),
        bandwidthUsageBytes:(()=>{ try {return Math.round((u.bandwidthUsageRaw||u.bandwidthUsage||0)*1073741824);}catch{return 0;}})(),
        remainingBandwidth:u.remainingBandwidth===-1?-1:+((u.remainingBandwidth||0).toFixed(2)), remainingBandwidthRaw:u.remainingBandwidthRaw===-1?-1:(u.remainingBandwidthRaw??u.remainingBandwidth??0),
        daysLeft:u.daysLeft, vlessUrl:u.vlessUrl
      }));
      const phases = `cached:${_cachedEnriched.length?1:0},agg:${_isAggregating?1:0}`;
      try { res.set({'X-Phases':phases,'X-Cache-Age':String(Date.now()-_cacheStamp)}); } catch {}
      res.json(response);
      console.log('[PERF] GET /api/users total='+ (Date.now()-t0)+'ms cacheAge='+(Date.now()-_cacheStamp)+'ms users='+response.length);
    } catch(e){ console.error('GET /api/users error', e); res.status(500).json({error:e.message}); }
  });

  /**
   * POST /api/users
  * Body: { username: string, displayName?: string, expiry?: string, quota?: number }
   * Adds user to users.json, updates Xray VLESS clients, reloads Xray.
   */
  app.post('/api/users', (req, res) => {
  const t0 = Date.now();
  const { username, displayName, expiry, quota } = req.body;
    if (!username) {
      return res.status(400).json({ error: 'username is required' });
    }
    try {
      let users = readJson(USERS_FILE);
      if (users.find(u => u.username === username)) {
        return res.status(400).json({ error: 'username already exists' });
      }
      // Generate UUID v4 server-side (RFC4122)
      const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });

      const nextId = users.reduce((m,u)=> Number.isFinite(u.id)?Math.max(m,u.id):m, 0) + 1;
      function normalizeExpiry(e) {
        if (!e || typeof e !== 'string') return '';
        let s = e.trim();
        if (!s) return '';
        s = s.replace('T',' ');
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) s += ':00';
        s = s.replace(/Z$/i,'');
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return '';
        return s;
      }
	users.push({
        id: nextId,
        username,
        uuid,
        displayName: displayName || '',
	expiry: normalizeExpiry(expiry),
        quota: (typeof quota === 'number') ? quota : -1,
        enabled: true,
        bandwidthUsage: 0,
        statKey: displayName || username || uuid
      });
  // Fold current usage (will initialize accumulation fields for all users) before restart
  accumulateUsage(users);
  writeJson(USERS_FILE, users);

  // Central sync & always restart per requirement
  syncVlessClients(users);
  utils.restartXray?.();
  res.json({ added: username });
  console.log(`[PERF] POST /api/users user=${username} total=${Date.now()-t0}ms`);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * PUT /api/users/:username
  * Updates a user's fields. Supports: username, displayName, expiry, quota.
   * UUID changes are not allowed (auto-generated); attempts are ignored.
   */
  app.put('/api/users/:username', (req, res) => {
	const t0 = Date.now();
    const { username: oldUsername } = req.params;
  const { username: newUsername, displayName, expiry, quota } = req.body || {};
    try {
      let users = readJson(USERS_FILE);
      const idx = users.findIndex(u => u.username === oldUsername);
      if (idx === -1) return res.status(404).json({ error: 'User not found' });

      const prev = users[idx];
      // Prevent duplicate username if renaming
      if (newUsername && newUsername !== oldUsername && users.some(u => u.username === newUsername)) {
        return res.status(400).json({ error: 'username already exists' });
      }

      const updated = { ...prev };
      if (typeof newUsername === 'string' && newUsername.trim()) updated.username = newUsername.trim();
  // UUID immutable now
      if (typeof displayName === 'string') updated.displayName = displayName;
      // Expiry: allow clearing (null -> empty string)
      if (Object.prototype.hasOwnProperty.call(req.body, 'expiry')) {
        function normalize(e) {
          if (!e || typeof e !== 'string') return '';
          let s = e.trim().replace('T',' ');
            if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) s += ':00';
            s = s.replace(/Z$/i,'');
            if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return '';
            return s;
        }
        const before = users[idx].expiry || '';
        const norm = normalize(expiry);
        updated.expiry = norm;
        if (before !== norm) console.log(`[USERS] Expiry change for ${oldUsername}: '${before}' -> '${norm}'`);
      }
      if (typeof quota === 'number') updated.quota = quota;
  // maxConnections removed

      users[idx] = updated;
      // Determine what changed
      const usernameChanged = updated.username !== prev.username;
      const quotaChanged = typeof quota === 'number' && quota !== prev.quota;
      const expiryChanged = Object.prototype.hasOwnProperty.call(req.body,'expiry') && updated.expiry !== prev.expiry;
      // Only run expensive usage accumulation if quota changed (affects enable/disable logic) or username changed (statKey impact)
      if (usernameChanged || quotaChanged) {
        const a0 = Date.now();
        accumulateUsage(users);
        const a1 = Date.now();
        console.log('[PERF] accumulateOnPUT ms=', a1 - a0, 'usernameChanged=', usernameChanged, 'quotaChanged=', quotaChanged);
      }
      writeJson(USERS_FILE, users);
      if (usernameChanged) {
        syncVlessClients(users);
        utils.restartXray?.();
      }

  res.json({ updated: updated.username });
  console.log(`[PERF] PUT /api/users/${oldUsername} total=${Date.now()-t0}ms`);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * DELETE /api/users/:username
   * Removes user from users.json and Xray VLESS clients, then reloads Xray.
   */
  app.delete('/api/users/:username', (req, res) => {
  const t0 = Date.now();
    const { username } = req.params;
    try {
      let users = readJson(USERS_FILE);
      const user = users.find(u => u.username === username);
      if (!user) return res.status(404).json({ error: 'User not found' });

  users = users.filter(u => u.username !== username);
  accumulateUsage(users);
  writeJson(USERS_FILE, users);

  syncVlessClients(users);
  utils.restartXray?.();
  res.json({ removed: username });
  console.log(`[PERF] DELETE /api/users/${username} total=${Date.now()-t0}ms`);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /api/users/:username/reset-quota
   * Resets user's usage counters:
   * - Xray per-user stats (best-effort)
   * - bandwidthUsage field in users.json
   */
  app.post('/api/users/:username/reset-quota', (req, res) => {
    const { username } = req.params;
    try {
      let users = readJson(USERS_FILE);
      const user = users.find(u => u.username === username);
      if (!user) return res.status(404).json({ error: 'User not found' });

        const resetOK = (utils.resetUserTrafficAllVariants
          ? utils.resetUserTrafficAllVariants([user.uuid, user.username, user.displayName, user.statKey])
          : (utils.resetUserTrafficCountersMulti
              ? utils.resetUserTrafficCountersMulti([user.uuid, user.username, user.displayName, user.statKey])
              : resetUserTrafficCounters(user.uuid)));
  user.usageAccumBytes = 0;
  user.lastRawBytes = 0;
      // Also reset persistent usage-store entry
      try {
        const dir = path.dirname(USERS_FILE);
        const USAGE_FILE = path.join(dir, 'usage-store.json');
        let store = {};
        try { store = utils.readJson(USAGE_FILE); } catch { store = {}; }
        if (store[user.uuid]) { store[user.uuid] = { accumBytes: 0, lastRawBytes: 0 }; writeJson(USAGE_FILE, store); }
      } catch {}
      if ('bandwidthUsageRaw' in user) user.bandwidthUsageRaw = 0;
      writeJson(USERS_FILE, users);
  // Sync & restart (requirement: restart on every change)
  syncVlessClients(users);
  utils.restartXray?.();

      res.json({ quotaReset: username, xrayCountersReset: resetOK });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Debug endpoint: view stored & live raw usage for a user
  app.get('/api/users/:username/usage-debug', (req, res) => {
    try {
      const { username } = req.params;
      const users = readJson(USERS_FILE);
      const u = users.find(x => x.username === username);
      if (!u) return res.status(404).json({ error: 'User not found' });
      const dir = path.dirname(USERS_FILE);
      const USAGE_FILE = path.join(dir, 'usage-store.json');
      let store = {}; try { store = utils.readJson(USAGE_FILE); } catch {}
      const statKey = u.statKey || u.displayName || u.username || u.uuid;
      const multiRaw = getUserTrafficMulti([statKey, u.displayName, u.username, u.uuid]);
      const singleRaw = utils.getUserTraffic?.(u.uuid) || 0;
      res.json({
        username,
        uuid: u.uuid,
        store: store[u.uuid] || null,
        multiRaw,
        singleRaw,
        diff: (store[u.uuid]?.lastRawBytes ?? 0) - multiRaw
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /api/users/:username/enable
   * Sets enabled=true for the user and ensures UUID is present in Xray clients.
   */
  app.post('/api/users/:username/enable', (req, res) => {
  const t0 = Date.now();
    const { username } = req.params;
    try {
      let users = readJson(USERS_FILE);
      const user = users.find(u => u.username === username);
      if (!user) return res.status(404).json({ error: 'User not found' });
  // Capture usage for all users before restart
  accumulateUsage(users);
  user.enabled = true;
  writeJson(USERS_FILE, users);

  syncVlessClients(users);
  utils.restartXray?.();
  res.json({ enabled: username });
  console.log(`[PERF] POST /api/users/${username}/enable total=${Date.now()-t0}ms`);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /api/users/:username/disable
   * Sets enabled=false for the user and removes UUID from Xray clients.
   */
  app.post('/api/users/:username/disable', (req, res) => {
  const t0 = Date.now();
    const { username } = req.params;
    try {
      let users = readJson(USERS_FILE);
      const user = users.find(u => u.username === username);
      if (!user) return res.status(404).json({ error: 'User not found' });
  accumulateUsage(users);
  user.enabled = false;
  writeJson(USERS_FILE, users);

  syncVlessClients(users);
  utils.restartXray?.();
  res.json({ disabled: username });
  console.log(`[PERF] POST /api/users/${username}/disable total=${Date.now()-t0}ms`);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Manual sync endpoint (diagnostics)
  app.post('/api/users-sync', (req, res) => {
    try {
      const users = readJson(USERS_FILE);
      const changed = syncVlessClients(users);
      res.json({ synced: true, changed });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

}

export default { registerUserRoutes };