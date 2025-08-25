// --- DOM helpers & core element references ---
const $ = sel => document.querySelector(sel);
// --- Auth & Confirm System Injection ---
// Token helpers
function getAuthToken() { return localStorage.getItem('vpn_token') || null; }
function setAuthToken(t) { if (t) localStorage.setItem('vpn_token', t); }
function clearAuthToken() { localStorage.removeItem('vpn_token'); }

const authOverlay = document.getElementById('auth-overlay');
const loginForm = document.getElementById('login-form');
const loginErrorEl = document.getElementById('login-error');
const loginUsername = document.getElementById('login-username');
const loginPassword = document.getElementById('login-password');
const loginSubmitBtn = document.getElementById('loginSubmit');
const logoutBtn = document.getElementById('logoutBtn');
let refreshTimer = null;
let appInitialized = false;

function showAuth() {
  if (authOverlay) authOverlay.style.display = 'flex';
  if (loginErrorEl) { loginErrorEl.style.display='none'; loginErrorEl.textContent=''; }
  if (loginUsername) setTimeout(()=>loginUsername.focus(), 30);
}
function hideAuth() { if (authOverlay) authOverlay.style.display = 'none'; }

function scheduleRefresh(expiresInSec) {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (!expiresInSec || !Number.isFinite(expiresInSec)) return;
  // refresh at 80% of lifetime
  const delay = Math.max(5_000, Math.floor(expiresInSec * 0.8) * 1000);
  refreshTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/refresh', { method:'POST' });
      if (r.ok) {
        const j = await r.json().catch(()=>({}));
        if (j.token) { setAuthToken(j.token); scheduleRefresh(j.expiresIn); }
      } else if (r.status === 401) {
        clearAuthToken();
        showAuth();
      }
    } catch { showAuth(); }
  }, delay);
}

// Password visibility toggle
document.querySelector('.pw-toggle')?.addEventListener('click', () => {
  if (!loginPassword) return;
  const isPw = loginPassword.type === 'password';
  loginPassword.type = isPw ? 'text' : 'password';
});

// Monkey patch fetch to auto-attach token & handle 401
const _origFetch = window.fetch.bind(window);
window.fetch = async function(input, init) {
  init = init || {};
  if (typeof input === 'string' && input.startsWith('/api/')) {
    const h = new Headers(init.headers || {});
    const t = getAuthToken();
    if (t) h.set('Authorization', 'Bearer ' + t);
    init.headers = h;
  }
  const resp = await _origFetch(input, init);
  if (resp.status === 401 && typeof input === 'string' && input.startsWith('/api/')) {
    clearAuthToken();
    if (!authOverlay || authOverlay.style.display === 'none') showAuth();
  }
  return resp;
};

async function attemptAutoLogin() {
  const token = getAuthToken();
  if (!token) { showAuth(); return; }
  try {
    const r = await fetch('/api/status');
    if (r.status === 401) { showAuth(); return; }
    if (!appInitialized) initAppAfterAuth();
  } catch { showAuth(); }
}

loginForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!loginUsername || !loginPassword) return;
  loginSubmitBtn.disabled = true;
  loginSubmitBtn.textContent = 'Signing in…';
  loginErrorEl.style.display='none';
  try {
    const body = JSON.stringify({ username: loginUsername.value.trim(), password: loginPassword.value });
    let r;
    try {
      r = await _origFetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body });
    } catch (netErr) {
      throw new Error('Network error contacting server');
    }
    if (!r.ok) {
      // Provide clearer messages for upstream/server errors vs auth errors
      if (r.status >= 500) {
        throw new Error('Server unavailable (HTTP '+r.status+')');
      } else if (r.status === 429) {
        throw new Error('Too many attempts – slow down');
      } else if (r.status === 401) {
        throw new Error('Invalid credentials');
      } else {
        throw new Error('Login failed (HTTP '+r.status+')');
      }
    }
    const j = await r.json().catch(()=>({}));
    const token = j.token || j.accessToken || j.jwt || null;
    if (!token) {
      // If backend sets cookie-only, proceed anyway
      if (!j.success && !j.ok && !j.user) throw new Error('Login failed');
    } else setAuthToken(token);
    hideAuth();
  if (logoutBtn) logoutBtn.style.display = 'inline-flex';
  scheduleRefresh(j.expiresIn);
    if (!appInitialized) initAppAfterAuth();
  } catch (err) {
    loginErrorEl.textContent = err.message || 'Login failed';
    loginErrorEl.style.display='block';
  } finally {
    loginSubmitBtn.disabled = false;
    loginSubmitBtn.textContent = 'Sign In';
  }
});

// Custom confirm dialog (Promise based)
let _confirmRoot = null;
function ensureConfirmRoot() {
  if (_confirmRoot) return _confirmRoot;
  _confirmRoot = document.createElement('div');
  _confirmRoot.className = 'confirm-overlay';
  _confirmRoot.style.display = 'none';
  _confirmRoot.innerHTML = '<div class="confirm-modal" role="dialog" aria-modal="true"><div class="confirm-message"></div><div class="confirm-actions"><button class="btn btn-sm btn-primary confirm-ok">OK</button><button class="btn btn-sm btn-ghost confirm-cancel">Cancel</button></div></div>';
  document.body.appendChild(_confirmRoot);
  return _confirmRoot;
}
function uiConfirm(message) {
  const root = ensureConfirmRoot();
  const msgEl = root.querySelector('.confirm-message');
  const okBtn = root.querySelector('.confirm-ok');
  const cancelBtn = root.querySelector('.confirm-cancel');
  msgEl.textContent = message;
  root.style.display = 'flex';
  return new Promise(resolve => {
    function cleanup(result) {
      root.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      root.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onBackdrop(e) { if (e.target === root) cleanup(false); }
    function onKey(e) { if (e.key === 'Escape') cleanup(false); if (e.key === 'Enter') cleanup(true); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    root.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    okBtn.focus();
  });
}

function initAppAfterAuth() {
  if (appInitialized) return;
  appInitialized = true;
  enterCreateMode();
  loadUsers();
  setInterval(loadUsers, POLL_INTERVAL_MS);
  refreshStatus();
  loadVersions();
  if (logoutBtn) logoutBtn.style.display = 'inline-flex';
}

// Kick off auth check ASAP
window.addEventListener('load', attemptAutoLogin);

logoutBtn?.addEventListener('click', async () => {
  try { await fetch('/api/logout', { method:'POST' }); } catch {}
  clearAuthToken();
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  showAuth();
});

const thead = document.querySelector('#users-table thead');
const tbody = document.querySelector('#users-table tbody');
const tabs = document.querySelectorAll('.tabs .tab');
const tabIndicator = document.querySelector('.tabs .tab-indicator');
const views = document.querySelectorAll('.view');

// --- Tab activation ---
function activateTab(tab, focusView = true) {
  if (!tab) return;
  tabs.forEach(t => {
    const active = t === tab;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const v = tab.getAttribute('data-view');
  views.forEach(el => el.style.display = (el.id === `view-${v}` ? 'block' : 'none'));
  if (focusView) {
    if (v === 'status') { refreshStatus(); loadVersions(); }
    if (v === 'routing') { loadRoutingRules(); loadPsiphonDomains(); }
    if (v === 'config') { loadConfig(); }
  }
  // Reposition indicator
  if (tabIndicator && tabIndicator.dataset.style !== '7') {
    const rect = tab.getBoundingClientRect();
    const parentRect = tab.parentElement.getBoundingClientRect();
    const x = rect.left - parentRect.left;
    tabIndicator.style.setProperty('--_w', rect.width + 'px');
    if (tabIndicator.dataset.style === '5') {
      // center dot style
      tabIndicator.style.transform = `translateX(${x + rect.width / 2 - (tabIndicator.offsetWidth||22)/2}px)`;
    } else {
      tabIndicator.style.transform = `translateX(${x}px)`;
    }
  }
}

tabs.forEach(tab => {
  tab.addEventListener('click', () => activateTab(tab));
  tab.addEventListener('keydown', e => {
    const idx = Array.from(tabs).indexOf(tab);
    if (['ArrowRight','ArrowLeft','Home','End'].includes(e.key)) e.preventDefault();
    if (e.key === 'ArrowRight') activateTab(tabs[(idx + 1) % tabs.length], true);
    if (e.key === 'ArrowLeft') activateTab(tabs[(idx - 1 + tabs.length) % tabs.length], true);
    if (e.key === 'Home') activateTab(tabs[0], true);
    if (e.key === 'End') activateTab(tabs[tabs.length - 1], true);
  });
});
window.addEventListener('load', () => activateTab(document.querySelector('.tabs .tab.active'), false));
window.addEventListener('resize', () => { renderTable(); activateTab(document.querySelector('.tabs .tab.active'), false); });

// Apply single Frost Sweep indicator
const indicator = document.querySelector('.tab-indicator');
if (indicator) {
  indicator.dataset.style='frost';
  Object.assign(indicator.style,{left:'0', top:'6px', height:'calc(100% - 12px)', bottom:'', borderRadius:'14px', background:'linear-gradient(145deg, rgba(255,255,255,0.20), rgba(255,255,255,0.06))', boxShadow:'0 4px 10px -6px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.05), 0 0 18px -6px rgba(100,160,255,0.45)'});
  const first = document.querySelector('.tabs .tab.active'); activateTab(first, false);
  window.addEventListener('resize', () => activateTab(document.querySelector('.tabs .tab.active'), false));
}

// --- User panel refs ---
const panel = $('#user-panel');
const panelToggle = $('#user-panel-toggle');
const panelTitle = $('#panel-title');
const panelMode = $('#panel-mode');
const panelEditId = $('#panel-edit-id');
const panelEditIdVal = $('#panel-edit-id-val');
const submitBtn = $('#submitBtn');

function setPanelOpen(open) {
  panel.classList.toggle('open', open);
  panelToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}
setPanelOpen(false);

    panelToggle?.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      setPanelOpen(!panel.classList.contains('open'));
    });
    $('#new-user').addEventListener('click', () => {
      enterCreateMode();
      setPanelOpen(true);
      $('#username').focus();
    });

    // Toast helper
    function toast(msg) {
      const el = document.createElement('div');
      el.className = 'toast';
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(10px)'; }, 2000);
      setTimeout(() => el.remove(), 2600);
    }

  // Online status logic (re-built)
  // Offline by default. A user becomes Online if their total used bytes increases by >1 KB between polls.
  // They stay Online for 30s after the last detected increase.
  const POLL_INTERVAL_MS = 5000;
  const ACTIVE_WINDOW_MS = 30_000;
  const DELTA_THRESHOLD_BYTES = 1024; // 1 KB threshold for considering activity
  let lastBytes = new Map();      // id -> last observed absolute bytes
  let lastActiveTime = new Map(); // id -> timestamp of last positive delta

    // Sort/Filter state
    let sortKey = 'id';
    let sortDir = 'asc';
    let filterText = '';

    // Users cache
    let currentUsers = new Map();
      // UUID helpers
  // UUID input removed (server generates). Remove related listeners if present.
  ['gen_pass','toggle_pw','copy_pw'].forEach(id => { const el = document.getElementById(id); if (el) el.remove(); });

  // Formatting helpers
  function fmtGB(val) { if (val === -1 || String(val) === '-1') return '∞'; return Number(val).toFixed(2); }

  // Lucide inline SVG minimal set (MIT). Stroke inherits currentColor.
  const ICONS = {
    edit: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1.767 1.767 0 0 1 2.5 2.5L12 14l-4 1 1-4 9.375-8.375Z"/></svg>',
    enable: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  disable: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg>',
    reset: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/><path d="M3.51 15a9 9 0 0 0 14.85 3.36L23 20"/><path d="M20.49 9a9 9 0 0 0-14.85-3.36L1 4"/></svg>',
    trash: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
    copy: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4c0-1.1.9-2 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    qr: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h6v6H3z"/><path d="M15 3h6v6h-6z"/><path d="M3 15h6v6H3z"/><path d="M17 13v4h-4v-4h4z"/><path d="M13 17h-2"/><path d="M17 17h2v4h-4v-2"/></svg>'
  };
  function icon(name) { return ICONS[name] || ''; }
  // If icons fail to load or render, we can optionally inject fallback text later.

  // Adaptive byte formatter: takes bytes, returns human-readable string with unit.
  function formatBytesAdaptive(bytes) {
    if (bytes == null || isNaN(bytes)) return '0 B';
    const B = Number(bytes);
    const KB = 1024;
    const MB = KB * 1024;
    const GB = MB * 1024;
    if (B >= GB) return (B / GB).toFixed(2) + ' GB';
    if (B >= MB) return (B / MB).toFixed(2) + ' MB';
    if (B >= KB) return (B / KB).toFixed(2) + ' KB';
    return B + ' B';
  }

  function isEnabled(u) { return !!u.enabled; }

    // Tehran timezone conversions (fixed UTC+3:30)
    const TEHRAN_OFFSET_MIN = 210;

    function utcSqlToTehranInput(utcStr) {
      try {
        if (!utcStr) return '';
        let s = String(utcStr).trim();
        if (!s) return '';
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) {
          s = s.replace(' ', 'T') + 'Z';
        } else if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !/[zZ]|[+\-]\d{2}:\d{2}$/.test(s)) {
          s += 'Z';
        }
        const dUtc = new Date(s);
        if (isNaN(dUtc.getTime())) return '';
        const msTehran = dUtc.getTime() + TEHRAN_OFFSET_MIN * 60000;
        const t = new Date(msTehran);
        const pad = n => String(n).padStart(2, '0');
        const y = t.getUTCFullYear();
        const m = pad(t.getUTCMonth() + 1);
        const d = pad(t.getUTCDate());
        const hh = pad(t.getUTCHours());
        const mm = pad(t.getUTCMinutes());
        return `${y}-${m}-${d}T${hh}:${mm}`;
      } catch {
        return '';
      }
    }

    function tehranInputToUtcSql(input) {
      try {
        if (!input) return null;
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(input).trim());
        if (!m) return null;
        const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), hh = Number(m[4]), mm = Number(m[5]);
        const ms = Date.UTC(y, mo - 1, d, hh, mm) - TEHRAN_OFFSET_MIN * 60000;
        const t = new Date(ms);
        if (isNaN(t.getTime())) return null;
        const pad = n => String(n).padStart(2, '0');
        const Y = t.getUTCFullYear();
        const M = pad(t.getUTCMonth() + 1);
        const D = pad(t.getUTCDate());
        const H = pad(t.getUTCHours());
        const Mi = pad(t.getUTCMinutes());
        const S = pad(t.getUTCSeconds());
        return `${Y}-${M}-${D} ${H}:${Mi}:${S}`;
      } catch {
        return null;
      }
    }

    function showExpiryDebug(raw, localStr) {
      const el = $('#expiry-debug');
      if (!el) return;
      el.style.display = 'block';
      el.textContent = `Expiry (UTC raw): ${raw || '(none)'} → Tehran input: ${localStr || '(empty)'}`;
      console.debug('[TGUI] Expiry debug:', { raw, tehranInput: localStr });
    }
	    // Dirty flags
    let usernameDirty = false;
  let passwordDirty = false; // no longer used but kept to avoid refactor noise
    let quotaDirty = false;
    let expiresDirty = false;

    function resetDirty() { usernameDirty = false; passwordDirty = false; quotaDirty = false; expiresDirty = false; }

    // Form helpers
    $('#quota_unit').addEventListener('change', (e) => { $('#quota_value').disabled = e.target.value !== 'gb'; });
    const clearFormOnly = () => {
      $('#user-form').reset?.();
  // UUID field removed
      $('#display_name').value = '';
      $('#quota_unit').value = 'unlimited';
      $('#quota_value').value = '';
      $('#quota_value').disabled = true;
      $('#expires_at').value = '';
  // removed length control for UUID generation
      $('#expiry-debug').style.display = 'none';
      resetDirty();
    };
      // Days Left input logic
      $('#days_left').addEventListener('input', function() {
        const days = parseInt(this.value, 10);
        if (!isNaN(days) && days > 0) {
          // Get current Tehran time
          const now = new Date();
          // Tehran offset is UTC+3:30
          const tehranOffsetMin = 210;
          const msTehran = now.getTime() + tehranOffsetMin * 60000;
          const tehranNow = new Date(msTehran);
          // Add days
          tehranNow.setUTCDate(tehranNow.getUTCDate() + days);
          // Set time to 23:59 for expiry
          tehranNow.setUTCHours(20, 29, 0, 0); // 23:59 Tehran = 20:29 UTC
          // Format for input type="datetime-local"
          const pad = n => String(n).padStart(2, '0');
          const y = tehranNow.getUTCFullYear();
          const m = pad(tehranNow.getUTCMonth() + 1);
          const d = pad(tehranNow.getUTCDate());
          const hh = pad(tehranNow.getUTCHours());
          const mm = pad(tehranNow.getUTCMinutes());
          $('#expires_at').value = `${y}-${m}-${d}T${hh}:${mm}`;
        }
      });
    $('#clear').addEventListener('click', clearFormOnly);
    $('#clear2').addEventListener('click', clearFormOnly);

    function enterCreateMode() {
      panel.classList.add('mode-create');
      panel.classList.remove('mode-edit');
      panelTitle.textContent = 'Create User';
      panelMode.textContent = 'Create';
      panelMode.classList.add('badge-primary');
      panelMode.classList.remove('badge-warning');
      panelEditId.style.display = 'none';
      submitBtn.textContent = 'Create User';

      $('#user-id').value = '';
      $('#orig-username').value = '';
      $('#username').value = '';
  // UUID field removed
      $('#display_name').value = '';
      $('#quota_unit').value = 'unlimited';
      $('#quota_value').value = '';
      $('#quota_value').disabled = true;
      $('#expires_at').value = '';
  // removed length control for UUID generation
      $('#expiry-debug').style.display = 'none';
  $('#username').setAttribute('required', 'true');
      resetDirty();
    }

    async function enterEditMode(u) {
      panel.classList.remove('mode-create');
      panel.classList.add('mode-edit');
      panelTitle.textContent = 'Edit User';
      panelMode.textContent = 'Edit';
      panelMode.classList.remove('badge-primary');
      panelMode.classList.add('badge-warning');
      panelEditId.style.display = '';
      panelEditIdVal.textContent = u.id;
      submitBtn.textContent = 'Update User';

      $('#user-id').value = u.id;
      $('#orig-username').value = u.username;
      $('#username').value = u.username;
      $('#display_name').value = u.name ?? '';
  // UUID field removed
      // Quota (u.quota is GB or -1 for unlimited)
      if (u.quota == null || u.quota === -1) {
        $('#quota_unit').value = 'unlimited';
        $('#quota_value').value = '';
        $('#quota_value').disabled = true;
      } else {
        $('#quota_unit').value = 'gb';
        $('#quota_value').disabled = false;
        $('#quota_value').value = Number(u.quota).toString();
      }
      // Expiry
      $('#expires_at').value = '';
      $('#expiry-debug').style.display = 'none';
      $('#username').setAttribute('required', 'true');
  document.getElementById('orig-expiry').value = (u.expiry || '').trim();
  // UUID field removed
      resetDirty();

      const rawUtc = u.expiry || u.expires_at || u.expiresAt || null;
      if (rawUtc) {
        const tehranInput = utcSqlToTehranInput(rawUtc);
        $('#expires_at').value = tehranInput || '';
        showExpiryDebug(rawUtc, tehranInput);
      }
    }

    // Track field changes
    $('#quota_unit').addEventListener('change', () => { quotaDirty = true; });
    $('#quota_value').addEventListener('input', () => { quotaDirty = true; });
    $('#expires_at').addEventListener('change', () => { expiresDirty = true; });
    // Reverse sync: when expiry picked manually, update Days Left field
    $('#expires_at').addEventListener('input', () => {
      try {
        const expEl = document.getElementById('expires_at');
        const daysEl = document.getElementById('days_left');
        const origExp = document.getElementById('orig-expiry')?.value || '';
        if (!expEl || !daysEl) return;
        const val = expEl.value;
        if (!val) { /* don't auto-clear days */ return; }
        // Parse Tehran-local datetime from input then compute days difference (ceil)
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(val);
        if (!m) return;
        const y = +m[1], mo = +m[2], d = +m[3], hh = +m[4], mm = +m[5];
        // Treat input as Tehran time, convert to UTC ms
        const TEHRAN_OFFSET_MIN = 210; // keep local constant (dup for isolation)
        const utcMs = Date.UTC(y, mo - 1, d, hh, mm) - TEHRAN_OFFSET_MIN * 60000;
        const nowUtc = Date.now();
        const diffDays = Math.max(0, Math.ceil((utcMs - nowUtc) / 86400000));
        if (diffDays > 0) daysEl.value = String(diffDays); // only set positive
        // If changed vs original, ensure dirty
        if (origExp) {
          // Convert current input to normalized server form to compare
          const tehranInput = expEl.value;
          const utcSql = tehranInputToUtcSql(tehranInput);
          if (utcSql && utcSql !== origExp) expiresDirty = true;
        }
      } catch {}
    });
    // Days-left auto expiry helper
    const daysInput = document.getElementById('days_left');
    if (daysInput) {
      daysInput.addEventListener('input', () => {
        const v = daysInput.value.trim();
        if (!v) return; // don't clear expiry unless user explicitly clears date
        const days = parseInt(v, 10);
        if (!Number.isFinite(days) || days <= 0) return;
        // Compute Tehran end-of-day date days from now
        try {
          const now = new Date();
          const tehranOffsetMin = 210; // UTC+3:30
          const base = new Date(now.getTime() + tehranOffsetMin * 60000);
          base.setUTCDate(base.getUTCDate() + days);
          // Set to 23:59 Tehran => 20:29 UTC
          base.setUTCHours(20, 29, 0, 0);
          const pad = n => String(n).padStart(2, '0');
          const y = base.getUTCFullYear();
          const m = pad(base.getUTCMonth() + 1);
          const d = pad(base.getUTCDate());
          const hh = pad(base.getUTCHours());
          const mm = pad(base.getUTCMinutes());
          const formatted = `${y}-${m}-${d}T${hh}:${mm}`;
          const expEl = document.getElementById('expires_at');
          if (expEl && expEl.value !== formatted) {
            expEl.value = formatted;
            expiresDirty = true;
            // Also clear original stored expiry to force sending if changed
            try { const oe = document.getElementById('orig-expiry'); if (oe) oe.value = ''; } catch {}
          }
        } catch {}
      });
      daysInput.addEventListener('change', () => {
        // If user clears days field, do not auto-clear expiry (they can clear expiry manually)
      });
    }
    $('#username').addEventListener('input', () => {
      const orig = $('#orig-username').value;
      usernameDirty = ($('#user-id').value !== '' && $('#username').value !== orig);
    });
  // UUID field removed

    function computeQuotaBytes() {
      const unit = $('#quota_unit').value;
      if (unit === 'unlimited') return -1;
      const raw = $('#quota_value').value.trim();
      if (!raw) return null;
      const qv = Number(raw);
      if (!Number.isFinite(qv) || qv <= 0) return null;
      return qv * 1024 * 1024 * 1024; // convert GB (can be fractional) to bytes
    }
    function computeExpiresAt() {
      const tehranInput = $('#expires_at').value;
      const utcSql = tehranInputToUtcSql(tehranInput);
  // utcSql already 'YYYY-MM-DD HH:MM:SS'; return as-is
  return utcSql;
    }

    // Filter UI
    $('#filterText').addEventListener('input', (e) => {
      filterText = (e.target.value || '').toLowerCase().trim();
      renderTable();
    });
    $('#clearFilter').addEventListener('click', () => {
      filterText = '';
      $('#filterText').value = '';
      renderTable();
    });

    // Sorting UI
    thead.addEventListener('click', (e) => {
      const th = e.target.closest('th');
      if (!th) return;
      if (th.getAttribute('data-sortable') === 'false') return;
      if (!th.classList.contains('sortable')) return;
      const key = th.getAttribute('data-key');
      if (!key) return;
      if (sortKey === key) {
        sortDir = (sortDir === 'asc') ? 'desc' : 'asc';
      } else {
        sortKey = key;
        sortDir = (key === 'id' || key === 'used_bytes' || key === 'remaining_bytes' || key === 'remaining_days') ? 'desc' : 'asc';
      }
      renderTable();
    });
	    function compareValues(a, b, key) {
      switch (key) {
        case 'id': return Number(a.id) - Number(b.id);
        case 'username': return (a.username || '').toLowerCase().localeCompare((b.username || '').toLowerCase());
        case 'name': return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
        case 'live': return (a.live === true ? 1 : 0) - (b.live === true ? 1 : 0);
        case 'enabled': return (a.enabled ? 1 : 0) - (b.enabled ? 1 : 0);
        case 'used_bytes': return Number(a.usedB) - Number(b.usedB);
        case 'remaining_bytes': return Number(a.remainingB) - Number(b.remainingB);
        case 'remaining_days': return Number(a.remainingDaysNum) - Number(b.remainingDaysNum);
        default: return 0;
      }
    }
    function applySorting(list) {
      const arr = list.slice();
      arr.sort((a, b) => {
        let cmp = compareValues(a, b, sortKey);
        if (sortDir === 'desc') cmp = -cmp;
        return cmp;
      });
      return arr;
    }
    function applyFilter(list) {
      if (!filterText) return list;
      return list.filter(u => {
        const un = (u.username || '').toLowerCase();
        const dn = (u.name || '').toLowerCase();
        return un.includes(filterText) || dn.includes(filterText);
      });
    }
    function updateSortIndicators() {
      document.querySelectorAll('#users-table thead th').forEach(th => {
        th.classList.remove('sorted');
        const span = th.querySelector('.sort-indicator');
        if (span) span.textContent = '';
      });
      const active = document.querySelector(`#users-table thead th[data-key="${sortKey}"]`);
      if (active) {
        active.classList.add('sorted');
        const span = active.querySelector('.sort-indicator');
        if (span) span.textContent = sortDir === 'asc' ? '▲' : '▼';
      }
    }

    // ---------- Status/Versions ----------
    async function refreshStatus() {
      try {
        const r = await fetch('/api/status');
        if (!r.ok) throw new Error('status');
        const j = await r.json();
        const sx = j.xray === 'running' ? 'badge-success' : 'badge-danger';
        const sp = j.psiphon === 'running' ? 'badge-success' : 'badge-danger';
        const xs = $('#xrayStatus'); xs.className = `badge ${sx}`; xs.textContent = j.xray;
        const ps = $('#psiphonStatus'); ps.className = `badge ${sp}`; ps.textContent = j.psiphon;
      } catch {}
  // Active users feature removed.
    }
    async function loadVersions() {
      try {
        const r = await fetch('/api/version');
        if (!r.ok) return;
        const j = await r.json();
        $('#xrayVersion').textContent = j.xray || '';
        $('#psiphonVersion').textContent = j.psiphon || '';
      } catch {}
    }
    document.getElementById('refreshStatusBtn')?.addEventListener('click', refreshStatus);
    document.getElementById('restartXray')?.addEventListener('click', async () => {
      if (!(await uiConfirm('Restart Xray service?'))) return;
      const r = await fetch('/api/restart/xray', { method: 'POST' });
      toast(r.ok ? 'Xray restarted' : 'Failed to restart Xray');
      refreshStatus();
    });
    document.getElementById('restartPsiphon')?.addEventListener('click', async () => {
      if (!(await uiConfirm('Restart Psiphon service?'))) return;
      const r = await fetch('/api/restart/psiphon', { method: 'POST' });
      toast(r.ok ? 'Psiphon restarted' : 'Failed to restart Psiphon');
      refreshStatus();
    });
    document.getElementById('updateXray')?.addEventListener('click', async () => {
      if (!(await uiConfirm('Update Xray binary to latest?'))) return;
      const r = await fetch('/api/update/xray', { method: 'POST' });
      toast(r.ok ? 'Xray updated' : 'Xray update failed');
      loadVersions();
    });
    document.getElementById('updatePsiphon')?.addEventListener('click', async () => {
      if (!(await uiConfirm('Update Psiphon binary to latest?'))) return;
      const r = await fetch('/api/update/psiphon', { method: 'POST' });
      toast(r.ok ? 'Psiphon updated' : 'Psiphon update failed');
      loadVersions();
    });


    // ---------- Routing ----------
    async function loadRoutingRules() {
      try {
        const r = await fetch('/api/routing-rules');
        if (!r.ok) throw new Error('rules');
        const rules = await r.json();
        document.getElementById('routingRules').value = JSON.stringify(rules, null, 2);
      } catch {}
    }
    async function saveRoutingRules() {
      try {
        const txt = document.getElementById('routingRules').value;
        const rules = JSON.parse(txt);
        const r = await fetch('/api/routing-rules', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rules }) });
        toast(r.ok ? 'Routing rules saved' : 'Save failed');
      } catch { toast('Invalid JSON'); }
    }
    document.getElementById('loadRulesBtn')?.addEventListener('click', loadRoutingRules);
    document.getElementById('saveRulesBtn')?.addEventListener('click', saveRoutingRules);
    async function loadPsiphonDomains() {
      try {
        const r = await fetch('/api/routing/psiphon-domains');
        if (!r.ok) return;
        const j = await r.json();
        const container = document.getElementById('psiphonDomainsList');
    // Capture existing domains for diff animation
    const existing = new Set(Array.from(container.querySelectorAll('.psiphon-domain-item')).map(el=>el.dataset.domain));
    container.innerHTML = '';
        const domains = j.domains || [];
        if (domains.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'subtle';
          empty.style.padding = '4px 4px 0';
          empty.textContent = 'No Psiphon domains.';
          container.appendChild(empty);
        } else {
          for (const d of domains) {
            let domain = d.startsWith('domain:') ? d.slice(7) : d;
            const item = document.createElement('div');
            item.className = 'psiphon-domain-item';
      item.dataset.domain = domain;
      if (!existing.has(domain)) item.classList.add('entering');
            item.setAttribute('role','listitem');
            const capsule = document.createElement('div');
            capsule.className = 'psiphon-capsule';
            const link = document.createElement('a');
            link.textContent = domain;
            link.href = 'http://' + domain;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.className = 'capsule-link';
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'capsule-remove';
            removeBtn.title = 'Remove domain';
            removeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>';
            removeBtn.addEventListener('click', () => removePsiphonDomain(d));
            capsule.appendChild(link);
            capsule.appendChild(removeBtn);
            item.appendChild(capsule);
            container.appendChild(item);
          }
        }
      } catch {}
    }

    // Add domain UI
  // No longer needed: input/button are now static in HTML

    async function addPsiphonDomain() {
      const input = document.getElementById('addPsiphonDomainInput');
      let domain = input.value.trim();
      if (!domain) return toast('Enter a domain');
    // Basic sanitize
    domain = domain.replace(/\s+/g,'').replace(/^https?:\/\//i,'');
      if (!domain.startsWith('domain:')) domain = 'domain:' + domain;
      let rules;
      try {
        rules = JSON.parse(document.getElementById('routingRules').value);
      } catch { toast('Invalid routing rules JSON'); return; }
      // Find the psiphon rule with a domain array
      let found = false;
      for (const r of rules) {
        if (r.outboundTag === 'psiphon' && Array.isArray(r.domain)) {
          if (!r.domain.includes(domain)) r.domain.push(domain);
          found = true;
          break;
        }
      }
      if (!found) {
        rules.push({ type: 'field', outboundTag: 'psiphon', domain: [domain] });
      }
      document.getElementById('routingRules').value = JSON.stringify(rules, null, 2);
      input.value = '';
      saveRoutingRules();
      loadPsiphonDomains();
  try { rememberDomainHistory(domain.replace(/^domain:/,'')); } catch {}
    }

    async function removePsiphonDomain(domain) {
      // Get current rules
      let rules;
      try {
        rules = JSON.parse(document.getElementById('routingRules').value);
      } catch { toast('Invalid routing rules JSON'); return; }
      // Animate removal if element present
      try {
        const norm = (typeof domain==='string' && domain.startsWith('domain:')) ? domain.slice(7):domain;
        const el = document.querySelector(`.psiphon-domain-item[data-domain="${CSS.escape(norm)}"]`);
        if (el) {
          el.classList.add('removing');
          setTimeout(()=>{ el.remove(); }, 260);
        }
      } catch {}
      // Remove only rules for this domain to psiphon, preserve all others
      function normalize(d) {
        return typeof d === 'string' && d.startsWith('domain:') ? d.slice(7) : d;
      }
      rules = rules.map(r => {
        if (r.outboundTag !== 'psiphon') return r;
        if (Array.isArray(r.domain)) {
          const filtered = r.domain.filter(d => normalize(d) !== normalize(domain));
          return { ...r, domain: filtered };
        }
        return r;
      });
      document.getElementById('routingRules').value = JSON.stringify(rules, null, 2);
      saveRoutingRules();
      loadPsiphonDomains();
    }

    // Setup UI on tab switch
  document.getElementById('refreshPsiphonDomainsBtn')?.addEventListener('click', loadPsiphonDomains);
  document.getElementById('addPsiphonDomainBtn')?.addEventListener('click', addPsiphonDomain);
  // Show busy state on refresh button
  const refreshDomainsBtn = document.getElementById('refreshPsiphonDomainsBtn');
  if (refreshDomainsBtn){
    refreshDomainsBtn.addEventListener('click', async ()=>{
      refreshDomainsBtn.classList.add('busy');
      try { await loadPsiphonDomains(); } finally { setTimeout(()=>refreshDomainsBtn.classList.remove('busy'), 400); }
    });
  }
  // Enter key adds domain
  document.getElementById('addPsiphonDomainInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addPsiphonDomain(); } });
  // Populate history on load
  (function initDomainHistory(){
    try {
      const listEl = document.getElementById('psiphonDomainHistory');
      if (!listEl) return;
      const hist = JSON.parse(localStorage.getItem('psiphon_domain_history')||'[]').slice(0,30);
      listEl.innerHTML = hist.map(d=>`<option value="${d}"></option>`).join('');
    } catch {}
  })();
  function rememberDomainHistory(dom){
    if(!dom) return;
    try {
      const key='psiphon_domain_history';
      let arr=JSON.parse(localStorage.getItem(key)||'[]');
      dom=dom.toLowerCase();
      arr=arr.filter(d=>d!==dom);
      arr.unshift(dom);
      if(arr.length>60) arr.length=60;
      localStorage.setItem(key, JSON.stringify(arr));
      const listEl = document.getElementById('psiphonDomainHistory');
      if (listEl) listEl.innerHTML = arr.slice(0,30).map(d=>`<option value="${d}"></option>`).join('');
    } catch {}
  }
  document.addEventListener('DOMContentLoaded', loadPsiphonDomains);
    document.getElementById('refreshPsiphonDomainsBtn')?.addEventListener('click', loadPsiphonDomains);

    // ---------- Config ----------
    async function loadConfig() {
      try {
        const r = await fetch('/api/config');
        if (!r.ok) return;
        const j = await r.json();
        document.getElementById('configJson').value = JSON.stringify(j, null, 2);
      } catch {}
    }
    async function validateConfig() {
      try {
        const txt = document.getElementById('configJson').value;
        const cfg = JSON.parse(txt);
        const r = await fetch('/api/config/validate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(cfg) });
        const j = await r.json().catch(()=>({}));
        toast(j.valid ? 'Config valid' : (j.error || 'Invalid'));
      } catch { toast('Invalid JSON'); }
    }
    async function saveConfig() {
      try {
        const txt = document.getElementById('configJson').value;
        const cfg = JSON.parse(txt);
        const r = await fetch('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(cfg) });
        toast(r.ok ? 'Config saved' : 'Save failed');
      } catch { toast('Invalid JSON'); }
    }
    document.getElementById('loadConfigBtn')?.addEventListener('click', loadConfig);
    document.getElementById('validateConfigBtn')?.addEventListener('click', validateConfig);
    document.getElementById('saveConfigBtn')?.addEventListener('click', saveConfig);

  async function loadUsers() {
      try {
    // Append a cache-busting query param to absolutely prevent any stale caching in stubborn browser profiles
  const res = await fetch('/api/users?fast=1&_=' + Date.now());
        if (!res.ok) throw new Error('HTTP '+res.status);
        const list = await res.json();
        const next = new Map();
        for (const u of list) {
          const usedB = Number(u.bandwidthUsageRaw || u.bandwidthUsage || u.bandwidthusage || 0); // GB (precise)
          const usedBytesExact = Number(u.bandwidthUsageBytes || 0);
          // Use raw remaining (not rounded) to preserve very small quotas (e.g. 0.001 GB)
          const remainingB = (u.remainingBandwidthRaw === -1 || u.remainingbandwidthraw === -1 || u.remainingBandwidth === -1 || u.remainingbandwidth === -1)
            ? -1
            : Number(u.remainingBandwidthRaw ?? u.remainingBandwidth ?? u.remainingbandwidthraw ?? u.remainingbandwidth ?? 0);
          const remainingDaysNum = (u.daysLeft == null || u.daysLeft === '') ? Number.POSITIVE_INFINITY : Number(u.daysLeft);
          next.set(String(u.id), {
            id: u.id,
            username: u.username,
            name: u.displayName || '',
            uuid: u.uuid,
            quota: u.quota, // GB or -1
            expiry: u.expiry, // raw UTC string
            usedB, usedBytesExact, remainingB, remainingDaysNum,
            enabled: !!u.enabled,
            vlessUrl: u.vlessUrl,
            maxConnections: u.maxConnections,
            approxConnections: u.approxConnections
          });
        }
        currentUsers = next;

        renderTable();
        // Schedule a full stats refresh after initial fast load
        setTimeout(async () => {
          try {
            const full = await fetch('/api/users?_=' + Date.now());
            if (!full.ok) return;
            const list2 = await full.json();
            const next2 = new Map();
            for (const u of list2) {
              const usedB = Number(u.bandwidthUsageRaw || u.bandwidthUsage || 0);
              const usedBytesExact = Number(u.bandwidthUsageBytes || 0);
              const remainingB = (u.remainingBandwidthRaw === -1 || u.remainingBandwidth === -1) ? -1 : Number(u.remainingBandwidthRaw ?? u.remainingBandwidth ?? 0);
              const remainingDaysNum = (u.daysLeft == null || u.daysLeft === '') ? Number.POSITIVE_INFINITY : Number(u.daysLeft);
              next2.set(String(u.id), { id: u.id, username: u.username, name: u.displayName || '', uuid: u.uuid, quota: u.quota, expiry: u.expiry, usedB, usedBytesExact, remainingB, remainingDaysNum, enabled: !!u.enabled, vlessUrl: u.vlessUrl, maxConnections: u.maxConnections, approxConnections: u.approxConnections });
            }
            currentUsers = next2;
            renderTable();
          } catch {}
        }, 500);
      } catch (e) {
        console.error(e);
      }
    }

    // Incremental rendering state trackers
    let _lastOrder = [];
    let _lastFilter = '';
    let _lastSortKey = sortKey;
    let _lastSortDir = sortDir;
    let _lastMobileMode = null;
  const ALWAYS_FULL_REBUILD = true; // force full rebuild each poll to avoid stale usage cells
    // Track last API raw bytes to detect freezes
    const lastApiBytes = new Map(); // id -> {bytes,time}

    function renderTable() {
      const now = Date.now();
      const list = Array.from(currentUsers.values());
      let filtered = applyFilter(list);
      const augmented = filtered.map(u => {
        const id = String(u.id);
  const absBytes = u.usedBytesExact || Math.round(u.usedB * 1073741824);
  // Record latest bytes for debug / freeze detection
  lastApiBytes.set(id, { bytes: absBytes, time: now });
        const prevAbs = lastBytes.get(id);
        if (prevAbs != null) {
          if (absBytes > prevAbs + DELTA_THRESHOLD_BYTES) {
            lastActiveTime.set(id, now);
          } else if (absBytes < prevAbs) {
            lastBytes.set(id, absBytes); // reset baseline after counter restart
          }
        }
        const live = lastActiveTime.has(id) && (now - lastActiveTime.get(id) < ACTIVE_WINDOW_MS);
        return { ...u, live };
      });
      const sorted = applySorting(augmented);
      updateSortIndicators();

      const orderIds = sorted.map(u => String(u.id));
      const mobileMode = window.innerWidth < 560;
      const needFull = (_lastFilter !== filterText) || (_lastSortKey !== sortKey) || (_lastSortDir !== sortDir) || (_lastOrder.length !== orderIds.length) || (mobileMode !== _lastMobileMode) || orderIds.some((id,i)=> id !== _lastOrder[i]);

  if (ALWAYS_FULL_REBUILD || needFull) {
        const frag = document.createDocumentFragment();
        for (const u of sorted) {
          const tr = document.createElement('tr');
          tr.dataset.id = u.id;
          const pillClasses = ['status-pill', u.enabled ? 'enabled':'disabled', u.live ? 'online':'offline'];
          const statusLabelFull = u.enabled ? (u.live ? 'Online Enabled':'Offline Enabled') : (u.live ? 'Online Disabled':'Offline Disabled');
          const statusLabelShort = u.enabled ? (u.live ? 'On En':'Off En') : (u.live ? 'On Dis':'Off Dis');
          const usedBytes = u.usedBytesExact || Math.round(u.usedB * 1073741824);
          tr.innerHTML = `
            <td class="nowrap" data-label="ID">${u.id}</td>
            <td class="cell-status" data-label="Status"><span class="${pillClasses.join(' ')}" title="${statusLabelFull}"><span class="pulse"></span><span class="text"><span class="full">${statusLabelFull}</span><span class="short">${statusLabelShort}</span></span></span></td>
            <td class="cell-username" data-label="Username"><div class="mono">${u.username}</div></td>
            <td class="cell-name" data-label="Display Name"><div class="subtle">${u.name ?? ''}</div></td>
            <td class="usage-cell cell-usage" data-label="Usage">${quotaUsageCell(u.usedB, u.remainingB, usedBytes)}</td>
            <td class="cell-days" data-label="Days Left">${Number.isFinite(u.remainingDaysNum) ? expiryBadge(u.remainingDaysNum) : ''}</td>
            <td class="cell-vless" data-label="VLESS">${u.vlessUrl ? `<div class=\"vless-mini\"><button class=\"icon-btn copy\" data-action=\"copy-url\" data-id=\"${u.id}\" title=\"Copy VLESS URL\" aria-label=\"Copy VLESS URL\">${icon('copy')}</button><button class=\"icon-btn qr\" data-action=\"qr-url\" data-id=\"${u.id}\" title=\"Show QR Code\" aria-label=\"Show QR Code\">${icon('qr')}</button></div>` : '<span class="subtle">No VLESS URL</span>'}</td>
            <td class="cell-actions" data-label="Actions"><div class="table-actions"><div class="action-group" role="group" aria-label="User actions"><button data-action="edit" data-id="${u.id}" title="Edit user" aria-label="Edit user">${icon('edit')}</button><button data-action="${u.enabled ? 'disable':'enable'}" data-id="${u.id}" class="action-toggle" data-enabled="${u.enabled ? 'true':'false'}" title="${u.enabled ? 'Disable user':'Enable user'}" aria-label="${u.enabled ? 'Disable user':'Enable user'}">${u.enabled ? icon('disable') : icon('enable')}</button><button data-action="reset" data-id="${u.id}" title="Reset usage" aria-label="Reset usage">${icon('reset')}</button><button data-action="delete" data-id="${u.id}" class="action-danger" title="Delete user" aria-label="Delete user">${icon('trash')}</button></div></div></td>`;
          frag.appendChild(tr);
        }
        tbody.innerHTML = '';
        tbody.appendChild(frag);

        // Mobile conversions
        const tableEl = document.getElementById('users-table');
        if (mobileMode) {
          tableEl.classList.add('mobile-cards');
          const headers = Array.from(tableEl.querySelectorAll('thead th')).map(th=>th.textContent.trim());
          tableEl.querySelectorAll('tbody tr').forEach(row => {
            Array.from(row.children).forEach((td,i)=>{ if (!td.hasAttribute('data-label') && headers[i]) td.setAttribute('data-label', headers[i]); });
          });
        } else { tableEl.classList.remove('mobile-cards'); }
        if (window.innerWidth < 480) {
          document.querySelectorAll('.action-group').forEach(group => {
            if (group.dataset.dropdownified) return;
            group.dataset.dropdownified='1';
            const btns=[...group.querySelectorAll('button')];
            const toggle=document.createElement('button'); toggle.type='button'; toggle.className='btn btn-sm'; toggle.textContent='Actions'; toggle.style.marginBottom='4px';
            const wrap=document.createElement('div'); wrap.style.display='flex'; wrap.style.flexDirection='column'; wrap.appendChild(toggle);
            const menu=document.createElement('div'); Object.assign(menu.style,{display:'none',background:'#122232',border:'1px solid var(--border)',borderRadius:'8px',padding:'4px',boxShadow:'0 6px 16px -6px rgba(0,0,0,0.6)'});
            btns.forEach(b=>{ b.style.width='100%'; b.style.border=0; b.style.justifyContent='flex-start'; b.style.background='transparent'; b.style.borderRadius='6px'; b.addEventListener('click',()=>{ menu.style.display='none'; }); b.addEventListener('mouseenter',()=>{ b.style.background='rgba(255,255,255,0.06)'; }); b.addEventListener('mouseleave',()=>{ b.style.background='transparent'; }); menu.appendChild(b); });
            toggle.addEventListener('click',()=>{ menu.style.display = (menu.style.display==='none')?'block':'none'; });
            group.replaceWith(wrap); wrap.appendChild(menu);
          });
        }
        // Icon fallback once per full rebuild
        document.querySelectorAll('.action-group button').forEach(btn=>{
          if (!btn.querySelector('svg') && !btn.dataset.fallbackApplied){
            const action=btn.getAttribute('data-action');
            const map={ edit:'E', enable:'On', disable:'Off', reset:'R', delete:'Del' };
            btn.insertAdjacentHTML('beforeend', `<span class="ico-fallback">${map[action]||'?'}<\/span>`);
            btn.dataset.fallbackApplied='1';
          }
        });
        _lastOrder = orderIds.slice();
        _lastFilter = filterText;
        _lastSortKey = sortKey;
        _lastSortDir = sortDir;
        _lastMobileMode = mobileMode;
      } else {
        // Incremental path
        for (const u of sorted) {
          const row = tbody.querySelector(`tr[data-id="${u.id}"]`);
          if (!row) continue;
          // Status pill
          const statusCell = row.querySelector('.cell-status');
          if (statusCell) {
            const pill = statusCell.querySelector('.status-pill');
            const shouldEnabled = u.enabled; const shouldOnline = u.live;
            if (!pill || pill.classList.contains('enabled')!==shouldEnabled || pill.classList.contains('online')!==shouldOnline) {
              const full = shouldEnabled ? (shouldOnline?'Online Enabled':'Offline Enabled') : (shouldOnline?'Online Disabled':'Offline Disabled');
              const short = shouldEnabled ? (shouldOnline?'On En':'Off En') : (shouldOnline?'On Dis':'Off Dis');
              statusCell.innerHTML = `<span class="status-pill ${shouldEnabled?'enabled':'disabled'} ${shouldOnline?'online':'offline'}" title="${full}"><span class="pulse"></span><span class="text"><span class="full">${full}</span><span class="short">${short}</span></span></span>`;
            }
          }
          // Usage cell
          const usageCell = row.querySelector('.cell-usage');
          if (usageCell) {
            const usedBytes = u.usedBytesExact || Math.round(u.usedB * 1073741824);
            const htmlNew = quotaUsageCell(u.usedB, u.remainingB, usedBytes);
            if (usageCell.firstElementChild?.outerHTML !== htmlNew) usageCell.innerHTML = htmlNew;
          }
            // Days left
          const daysCell = row.querySelector('.cell-days');
          if (daysCell) {
            const newDays = Number.isFinite(u.remainingDaysNum) ? expiryBadge(u.remainingDaysNum) : '';
            if (daysCell.innerHTML !== newDays) daysCell.innerHTML = newDays;
          }
          // Enabled toggle icon
          const toggleBtn = row.querySelector('.action-toggle');
          if (toggleBtn) {
            const currentEnabled = toggleBtn.getAttribute('data-enabled') === 'true';
            if (currentEnabled !== !!u.enabled) {
              toggleBtn.setAttribute('data-enabled', u.enabled ? 'true':'false');
              toggleBtn.setAttribute('data-action', u.enabled ? 'disable':'enable');
              toggleBtn.title = u.enabled ? 'Disable user':'Enable user';
              toggleBtn.setAttribute('aria-label', toggleBtn.title);
              toggleBtn.innerHTML = u.enabled ? icon('disable') : icon('enable');
            }
          }
        }
      }

      // Update byte baselines
      for (const u of sorted) {
        const id = String(u.id);
        const absBytes = u.usedBytesExact || Math.round(u.usedB * 1073741824);
        lastBytes.set(id, absBytes);
      }
  { const el = document.getElementById('lastRefresh'); if (el) el.textContent = 'Last: ' + new Date().toLocaleTimeString(); }
      for (const id of Array.from(lastActiveTime.keys())) if (!currentUsers.has(id)) lastActiveTime.delete(id);
      for (const id of Array.from(lastBytes.keys())) if (!currentUsers.has(id)) lastBytes.delete(id);
    } // end renderTable

    // Helper: unified usage cell (bar + labels)
    function quotaUsageCell(usedB, remainingB, usedBytesExact) {
      if (remainingB === -1) {
        const usedBytes = (usedB || 0) * 1073741824;
        return `<div title="Unlimited quota">
          <div class="usage-bar"><div class="fill" style="width:0%"></div></div>
          <div class="usage-meta"><span>${formatBytesAdaptive(usedBytes)}</span><span>∞</span></div>
        </div>`;
      }
      const totalGB = (usedB || 0) + (remainingB || 0);
      if (!isFinite(totalGB) || totalGB <= 0) return '';
      const totalBytes = totalGB * 1073741824;
      const usedBytes = usedBytesExact ?? (usedB * 1073741824);
      const pct = Math.min(100, (usedBytes / totalBytes) * 100);
      const remainingBytes = Math.max(0, totalBytes - usedBytes);
      let cls = 'usage-bar';
      const ratio = usedBytes / totalBytes;
      if (ratio >= 0.9) cls += ' danger'; else if (ratio >= 0.75) cls += ' warn';
      return `<div title="Used ${formatBytesAdaptive(usedBytes)} of ${formatBytesAdaptive(totalBytes)} (${pct.toFixed(1)}%)">
        <div class="${cls}"><div class="fill" style="transform:scaleX(${pct/100});"></div></div>
        <div class="usage-meta"><span>${formatBytesAdaptive(usedBytes)}</span><span>${formatBytesAdaptive(totalBytes)}</span></div>
      </div>`;
    }

    function expiryBadge(days) {
  if (days < 0 || days === Number.POSITIVE_INFINITY) return '';
  if (days === 0) return '<span class="badge badge-danger" title="Expired">0</span>';
  if (days <= 3) return `<span class="badge badge-warning" title="Expiring soon (${days} days)">${days}</span>`;
  return String(days);
    }

    // Persist active tab & user panel open state
    const savedTab = localStorage.getItem('vpn_tab');
    if (savedTab) {
      const tabBtn = document.querySelector(`.tabs .tab[data-view="${savedTab}"]`);
      if (tabBtn) tabBtn.click();
    }
    const savedPanelOpen = localStorage.getItem('vpn_user_panel_open') === '1';
    if (savedPanelOpen) setPanelOpen(true);
    tabs.forEach(tab => tab.addEventListener('click', ()=>{
      localStorage.setItem('vpn_tab', tab.getAttribute('data-view'));
    }));
    panelToggle.addEventListener('click', ()=>{
      localStorage.setItem('vpn_user_panel_open', panel.classList.contains('open') ? '1':'0');
    });

    // Domain conflict pre-check (client side) using current loaded domains
    let cachedDomains = [];
    async function loadDomainsCached() {
      try {
        const r = await fetch('/api/domains');
        if (r.ok) cachedDomains = await r.json();
      } catch {}
    }
    loadDomainsCached();
    async function clientDomainConflict(newDomain, wildcard) {
      const base = d => d.replace(/^\*\./,'');
      const newBase = base(newDomain);
      for (const d of cachedDomains) {
        const dWildcard = !!d.wildcard;
        const dBase = base(d.domain);
        if (wildcard) {
          if ((!dWildcard && d.domain === newBase) || (dWildcard && dBase === newBase)) return true;
        } else {
          if ((!dWildcard && d.domain === newDomain) || (dWildcard && newDomain.endsWith(dBase))) return true;
        }
      }
      return false;
    }
    const addDomainBtn = document.getElementById('addDomainBtn');
    if (addDomainBtn) {
      addDomainBtn.addEventListener('click', async ()=>{ setTimeout(loadDomainsCached,500); });
    }
    // Warn on input change
    const newDomainInput = document.getElementById('newDomain');
    const wildcardChk = document.getElementById('newDomainWildcard');
    function maybeWarnDomain() {
      const d = newDomainInput.value.trim();
      if (!d) return;
      clientDomainConflict(d, wildcardChk.checked).then(conflict => {
        newDomainInput.style.borderColor = conflict ? '#fbbf24' : '';
        newDomainInput.title = conflict ? 'Potential conflict with existing domain/wildcard' : 'Domain';
      });
    }
    if (newDomainInput) {
      newDomainInput.addEventListener('input', maybeWarnDomain);
      wildcardChk.addEventListener('change', maybeWarnDomain);
    }
	    // Load QRCode library on-demand from CDN
    async function ensureQRCodeLoaded() {
      if (window.QRCode) return true;
      return new Promise(resolve => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
        s.referrerPolicy = 'no-referrer';
        s.onload = () => resolve(true);
        s.onerror = () => resolve(false);
        document.head.appendChild(s);
      });
    }

    async function openQrModal(url, title) {
      if (!url) { toast('No URL to show'); return; }
      const ok = await ensureQRCodeLoaded();
      if (!ok || !window.QRCode) { toast('QR library failed to load'); return; }

      const backdrop = document.createElement('div');
      backdrop.className = 'qr-backdrop';
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) document.body.removeChild(backdrop); });

      const modal = document.createElement('div'); modal.className = 'qr-modal';
      const header = document.createElement('div'); header.className = 'qr-header';
      const hTitleWrap = document.createElement('div'); hTitleWrap.style.display = 'flex'; hTitleWrap.style.alignItems = 'center';
      const hTitle = document.createElement('div'); hTitle.className = 'qr-title'; hTitle.textContent = title || 'vless://';
      // Copy username button
      const copyUserBtn = document.createElement('button'); copyUserBtn.className = 'icon-btn copy-user'; copyUserBtn.title = 'Copy Username'; copyUserBtn.textContent = '📋';
      copyUserBtn.style.marginLeft = '8px';
      copyUserBtn.addEventListener('click', async () => {
        try {
          if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(hTitle.textContent);
          else { const ta = document.createElement('textarea'); ta.value = hTitle.textContent; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
          toast('Username copied');
        } catch { toast('Copy failed'); }
      });
      hTitleWrap.appendChild(hTitle);
      hTitleWrap.appendChild(copyUserBtn);
      const closeBtn = document.createElement('button'); closeBtn.className = 'qr-close'; closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', () => document.body.removeChild(backdrop));
      header.appendChild(hTitleWrap); header.appendChild(closeBtn);

      const canvasWrap = document.createElement('div'); canvasWrap.className = 'qr-canvas'; canvasWrap.style.width = '260px'; canvasWrap.style.height = '260px';
      const urlText = document.createElement('div'); urlText.className = 'qr-url mono'; urlText.textContent = url;

      const actions = document.createElement('div'); actions.className = 'qr-actions';
      const copyBtn = document.createElement('button'); copyBtn.className = 'btn btn-sm'; copyBtn.textContent = 'Copy URL';
      copyBtn.addEventListener('click', async () => {
        try {
          if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
          else { const ta = document.createElement('textarea'); ta.value = url; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
          toast('URL copied');
        } catch { toast('Copy failed'); }
      });
      const saveBtn = document.createElement('button'); saveBtn.className = 'btn btn-sm'; saveBtn.textContent = 'Save PNG';
      saveBtn.addEventListener('click', () => {
        const canvas = canvasWrap.querySelector('canvas'); if (!canvas) return;
        const a = document.createElement('a'); a.href = canvas.toDataURL('image/png'); a.download = (title || 'vless') + '.png'; a.click();
      });
      actions.appendChild(copyBtn); actions.appendChild(saveBtn);

      modal.appendChild(header); modal.appendChild(canvasWrap); modal.appendChild(urlText); modal.appendChild(actions);
      backdrop.appendChild(modal); document.body.appendChild(backdrop);

      try { const q = new QRCode(canvasWrap, { width: 240, height: 240, colorDark: '#000000', colorLight: '#ffffff' }); q.makeCode(url); }
      catch (e) { console.error(e); toast('Failed to render QR'); }
    }

    // Table actions
    tbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
  const id = btn.getAttribute('data-id');
      const action = btn.getAttribute('data-action');
  const entry = currentUsers.get(String(id));
  const usernameForApi = entry?.username || id;

      try {
  // popover logic removed; direct buttons now

        if (action === 'copy-url') {
          const u = currentUsers.get(String(id));
          const url = u?.vlessUrl || btn.parentElement.querySelector('.url-code')?.textContent?.trim();
          if (!url) return;
          try {
            if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
            else { const ta = document.createElement('textarea'); ta.value = url; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
            toast('URL copied');
          } catch { toast('Copy failed'); }
          return;
        }

        if (action === 'qr-url') {
          const u = currentUsers.get(String(id));
          const url = u?.vlessUrl;
          await openQrModal(url, u?.name || u?.username || 'vless');
          return;
        }

        if (action === 'enable') {
          const resp = await fetch(`/api/users/${encodeURIComponent(usernameForApi)}/enable`, { method: 'POST' });
          if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            toast(data.message || 'Enable failed');
          } else {
            toast('User enabled');
            await loadUsers();
          }
          return;
        }

        if (action === 'disable') {
          const resp = await fetch(`/api/users/${encodeURIComponent(usernameForApi)}/disable`, { method: 'POST' });
          if (!resp.ok) toast('Disable failed');
          else { toast('User disabled'); await loadUsers(); }
          return;
        }

        if (action === 'edit') {
          const u = entry;
          if (!u) return;
          await enterEditMode(u);
          setPanelOpen(true);
          window.scrollTo({ top: 0, behavior: 'smooth' });
          toast('Editing user #' + id);
          return;
        }

        if (action === 'reset') {
          if (!(await uiConfirm('Reset traffic counters?'))) return;
          const res = await fetch(`/api/users/${encodeURIComponent(usernameForApi)}/reset-quota`, { method: 'POST' });
          if (res.ok) { toast('Traffic reset'); await loadUsers(); }
          else toast('Reset failed');
          return;
        }

        if (action === 'delete') {
          if (!(await uiConfirm('Delete this user?'))) return;
          const res = await fetch(`/api/users/${encodeURIComponent(usernameForApi)}`, { method: 'DELETE' });
          if (res.ok) { toast('User deleted'); await loadUsers(); }
          else toast('Delete failed');
          return;
        }
      } catch (err) {
        console.error(err);
        toast('Action failed');
      }
    });

    // Form submit
  $('#user-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = $('#user-id').value;
      const isCreate = !id;
      const username = $('#username').value.trim();
      const uuid = '';
      const display_name = $('#display_name').value.trim();
      // Show loading spinner on button
      const origBtnText = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner" style="margin-right:8px;width:16px;height:16px;display:inline-block;border:2px solid #fff;border-top:2px solid #888;border-radius:50%;animation:spin 1s linear infinite;"></span>' + origBtnText;
      try {
        if (isCreate) {
          if (!username) { toast('Username is required'); submitBtn.disabled = false; submitBtn.textContent = origBtnText; return; }
          const payload = { username };
          if (display_name) payload.displayName = display_name;
          const qb = computeQuotaBytes();
          if (qb === -1) {
            payload.quota = -1;
          } else if (qb !== null) {
            payload.quota = qb / (1024*1024*1024);
          }
          const utcSql = computeExpiresAt();
          if (utcSql) payload.expiry = utcSql;
          const res = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (!res.ok) throw new Error('Create failed');
          toast('User created');
          enterCreateMode();
          await loadUsers();
          return;
        }
        // Partial update
        const payload = {};
        payload.displayName = display_name;
        // Force-expiry detection before building conditional block
        (function ensureExpiryDirtyIfChanged(){
          try {
            const rawInput = $('#expires_at').value.trim();
            const origExpiry = document.getElementById('orig-expiry').value.trim();
            if (rawInput) {
              const cmp = computeExpiresAt();
              if (cmp && cmp !== origExpiry) expiresDirty = true;
            }
          } catch {}
        })();
        if (usernameDirty && username) payload.username = username;
        if (quotaDirty) {
          const qb = computeQuotaBytes();
          if (qb === -1) {
            payload.quota = -1;
          } else if (qb !== null) {
            payload.quota = qb / (1024*1024*1024);
          }
        }
        let extendedToFuture = false;
        if (expiresDirty) {
          const rawInput = $('#expires_at').value.trim();
          const origExpiry = document.getElementById('orig-expiry').value.trim();
          if (!rawInput) {
            payload.expiry = '';
          } else {
            const utcSql = computeExpiresAt();
            if (utcSql) {
        payload.expiry = utcSql; // always send when user indicated change
        extendedToFuture = (new Date(utcSql + 'Z').getTime() > Date.now());
            } else payload.expiry = '';
          }
      console.debug('Expiry update debug', { rawInput, origExpiry, computed: payload.expiry });
        }
        const wasDisabled = !currentUsers.get(String(id))?.enabled;
        const res = await fetch(`/api/users/${encodeURIComponent($('#orig-username').value || id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        console.debug('Update payload sent', payload);
        if (!res.ok) throw new Error('Update failed');
        if (wasDisabled && extendedToFuture) {
          try { await fetch(`/api/users/${id}/enable`, { method: 'POST' }); } catch {}
        }
        toast('User updated');
        resetDirty();
        await loadUsers();
      } catch (err) {
        console.error(err);
        toast(err.message || 'Save failed');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = origBtnText;
      }
    });

  // Initial load + polling now occurs after successful auth (see initAppAfterAuth)
  