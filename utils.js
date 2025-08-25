'use strict';

/**
 * Shared utilities and constants for the VPN Manager backend.
 * Includes: file paths, process helpers, Xray API helpers, domain validation, config reload,
 *           and lightweight connection counting from access logs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { exec, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve project root dynamically (directory containing this utils.js file)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = __dirname; // adjust if utils.js is moved into subfolder later

// Paths and binaries
const USERS_FILE = path.join(PROJECT_ROOT, 'users.json');
const DOMAINS_FILE = path.join(PROJECT_ROOT, 'domains.json');
const CONFIG_FILE = '/etc/xray/config.json';
const XRAY_BIN = '/usr/local/bin/xray';
const PSIPHON_BIN = '/usr/local/bin/psiphon-console-client';
const XRAY_ACCESS_LOG = '/var/log/xray/access.log';

// Xray API
const XRAY_API_PORT = 10085;
// Keep full functionality; diagnostic timing logs will be added downstream.
const DISABLE_STATS = false;

// Outbound tag used by Xray for Psiphon routing rules
const PSIPHON_OUTBOUND_TAG = process.env.PSIPHON_OUTBOUND_TAG || 'psiphon';

/**
 * Ensure a directory exists (creates recursively if not present).
 * @param {string} dirPath
 */
function ensureDir(dirPath) {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
}

/**
 * Read JSON file and parse its content.
 * @param {string} filePath
 * @returns {any}
 */
function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * Write an object as formatted JSON to a file.
 * @param {string} filePath
 * @param {any} data
 */
function writeJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Convert bytes to gigabytes with two decimals (as number).
 * @param {number} bytes
 * @returns {number}
 */
function bytesToGB(bytes) {
  return +(bytes / 1073741824).toFixed(2);
}

/**
 * Validate domain string, allows optional leading wildcard (*.example.com).
 * @param {string} domain
 * @returns {boolean}
 */
function validateDomain(domain) {
  return /^(\*\.)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/.test(domain);
}

/**
 * Detects conflicts between a new domain and existing domain entries.
 * - Blocks duplicates
 * - Blocks overlaps between wildcard and exact domain entries
 * @param {{domain:string;wildcard?:boolean}[]} domains
 * @param {string} newDomain
 * @param {boolean} isWildcard
 * @returns {boolean} true if conflict exists
 */
function findDomainConflict(domains, newDomain, isWildcard) {
  const base = (d) => d.replace(/^\*\./, '');

  for (const d of domains) {
    const dIsWildcard = !!d.wildcard;
    const dBase = base(d.domain);
    const newBase = base(newDomain);

    if (isWildcard) {
      // Adding *.example.com conflicts with example.com or existing *.example.com
      if ((!dIsWildcard && d.domain === newBase) || (dIsWildcard && dBase === newBase)) {
        return true;
      }
    } else {
      // Adding example.com conflicts with example.com or existing *.example.com
      if ((!dIsWildcard && d.domain === newDomain) || (dIsWildcard && newDomain.endsWith(dBase))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Run a shell command returning a Promise with stdout/stderr.
 * @param {string} cmd
 * @param {import('child_process').ExecOptions} [options]
 * @returns {Promise<{stdout:string, stderr:string}>}
 */
function runCmd(cmd, options = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { shell: '/bin/bash', ...options }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' }));
      resolve({ stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
    });
  });
}

/**
 * Query Xray API counters for a user's total traffic (uplink + downlink) in bytes.
 * Returns 0 if stats are not available.
 * @param {string} uuid
 * @returns {number} bytes
 */
const _trafficCache = new Map(); // key -> { ts, bytes }
const TRAFFIC_CACHE_MS = 3000;
function runXrayWithTimeout(cmd) {
  // Use coreutils timeout to avoid hanging processes; fallback to normal if timeout not present
  const wrapped = `timeout 0.5s ${cmd}`;
  const t0 = Date.now();
  try {
    const out = execSync(wrapped, { stdio: ['ignore','pipe','ignore'] }).toString();
    const dt = Date.now() - t0;
    if (dt > 400) console.warn('[STATS_SLOW timeout-wrapper]', { cmd, ms: dt });
    return out;
  }
  catch {
    try {
      const t1 = Date.now();
      const out2 = execSync(cmd, { stdio: ['ignore','pipe','ignore'] }).toString();
      const dt2 = Date.now() - t1;
      if (dt2 > 400) console.warn('[STATS_SLOW direct]', { cmd, ms: dt2 });
      return out2;
    } catch { return ''; }
  }
}
function getUserTraffic(idOrEmail) {
  if (!idOrEmail) return 0;
  try {
  const now = Date.now();
  const cached = _trafficCache.get(idOrEmail);
  if (cached && (now - cached.ts) < TRAFFIC_CACHE_MS) return cached.bytes;
    // Wildcard ( * ) pattern for the last segment appears unsupported in current xray binary; use prefix instead.
    // Pattern "user>>>KEY" returns both uplink & downlink entries for that KEY, so query once then sum.
  let raw = runXrayWithTimeout(`${XRAY_BIN} api statsquery --server=127.0.0.1:${XRAY_API_PORT} --pattern "user>>>${idOrEmail}"`);
    if (!raw.includes('stat')) return 0;
    let j;
    try { j = JSON.parse(raw); } catch { return 0; }
    let sum = 0;
    for (const s of j.stat || []) {
      if (!s || typeof s.value !== 'number') continue;
      if (s.name && s.name.startsWith(`user>>>${idOrEmail}>>>traffic>>>`)) sum += s.value;
    }
    // Fallback: if still zero, try explicit uplink/downlink queries (older versions may not return both with prefix)
    if (sum === 0) {
      try {
        const up = runXrayWithTimeout(`${XRAY_BIN} api statsquery --server=127.0.0.1:${XRAY_API_PORT} --pattern "user>>>${idOrEmail}>>>traffic>>>uplink"`);
        const upJ = JSON.parse(up); if (Array.isArray(upJ.stat)) for (const s of upJ.stat) if (typeof s.value === 'number') sum += s.value;
      } catch {}
      try {
        const down = runXrayWithTimeout(`${XRAY_BIN} api statsquery --server=127.0.0.1:${XRAY_API_PORT} --pattern "user>>>${idOrEmail}>>>traffic>>>downlink"`);
        const downJ = JSON.parse(down); if (Array.isArray(downJ.stat)) for (const s of downJ.stat) if (typeof s.value === 'number') sum += s.value;
      } catch {}
    }
    if (process.env.STATS_DEBUG) {
      console.log('[STATS]', idOrEmail, sum);
    }
  _trafficCache.set(idOrEmail, { ts: Date.now(), bytes: sum });
  return sum;
  } catch (e) {
    if (process.env.STATS_DEBUG) console.warn('[STATS_FAIL]', idOrEmail, e.message);
    return 0;
  }
}

/**
 * Aggregate traffic across multiple potential stat keys (to handle historical email/label changes).
 * Keys array should contain unique identifiers (e.g. displayName/username/uuid).
 * @param {string[]} keys
 * @returns {number}
 */
function getUserTrafficMulti(keys = []) {
  const seenStatNames = new Set();
  let total = 0;
  for (const key of [...new Set(keys.filter(Boolean))]) {
    try {
  const now = Date.now();
  const cached = _trafficCache.get(key);
  if (cached && (now - cached.ts) < TRAFFIC_CACHE_MS) { total += cached.bytes; continue; }
  let raw = runXrayWithTimeout(`${XRAY_BIN} api statsquery --server=127.0.0.1:${XRAY_API_PORT} --pattern "user>>>${key}"`);
      if (!raw.includes('stat')) continue;
      let j; try { j = JSON.parse(raw); } catch { continue; }
      for (const s of j.stat || []) {
        if (!s || typeof s.value !== 'number') continue;
        if (!s.name || !s.name.startsWith(`user>>>`)) continue;
        if (!seenStatNames.has(s.name)) {
          seenStatNames.add(s.name);
          total += s.value;
        }
      }
  _trafficCache.set(key, { ts: Date.now(), bytes: total });
    } catch {}
  }
  if (process.env.STATS_DEBUG) console.log('[STATS_MULTI]', keys.join(','), total);
  return total;
}

/**
 * Reset Xray per-user traffic counters (uplink/downlink) for a given UUID.
 * Best-effort; returns boolean indicating success.
 * @param {string} uuid
 * @returns {boolean}
 */
function resetUserTrafficCounters(uuid) {
  try {
    // Explicitly reset both directions; ignore failures individually.
    execSync(`${XRAY_BIN} api statsreset --server=127.0.0.1:${XRAY_API_PORT} --pattern "user>>>${uuid}>>>traffic>>>uplink"`);
  } catch {}
  try {
    execSync(`${XRAY_BIN} api statsreset --server=127.0.0.1:${XRAY_API_PORT} --pattern "user>>>${uuid}>>>traffic>>>downlink"`);
  } catch {}
  return true;
}

/**
 * Reset counters for multiple historical keys (uuid, username, displayName) to fully clear usage
 * after label/email changes. Always returns true (best-effort).
 * @param {string[]} keys
 */
function resetUserTrafficCountersMulti(keys = []) {
  const uniq = [...new Set(keys.filter(Boolean))];
  for (const k of uniq) {
  try { execSync(`${XRAY_BIN} api statsreset --server=127.0.0.1:${XRAY_API_PORT} --pattern "user>>>${k}"`); } catch {}
    try { execSync(`${XRAY_BIN} api statsreset --server=127.0.0.1:${XRAY_API_PORT} --pattern "user>>>${k}>>>traffic>>>uplink"`); } catch {}
    try { execSync(`${XRAY_BIN} api statsreset --server=127.0.0.1:${XRAY_API_PORT} --pattern "user>>>${k}>>>traffic>>>downlink"`); } catch {}
  }
  return true;
}

/**
 * Reload Xray service to apply config changes.
 */
function reloadXray() {
  exec('systemctl reload xray');
}

function restartXray() {
  exec('systemctl restart xray');
}

/**
 * Read the last N lines of Xray access log (if exists).
 * @param {number} maxLines
 * @returns {string[]} lines (most recent up to maxLines)
 */
function readAccessLogTail(maxLines = 2000) {
  if (!existsSync(XRAY_ACCESS_LOG)) return [];
  const log = readFileSync(XRAY_ACCESS_LOG, 'utf8');
  const lines = log.split('\n').filter(Boolean);
  const start = Math.max(0, lines.length - maxLines);
  return lines.slice(start);
}

/**
 * Extract UUIDs from lines using a robust UUIDv4 regex.
 * @param {string[]} lines
 * @returns {string[]} uuids
 */
function extractUUIDs(lines) {
  const re = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/ig;
  const uuids = [];
  for (const line of lines) {
    const found = line.match(re);
    if (found) uuids.push(...found);
  }
  return uuids;
}

/**
 * Count approximate active connections per user UUID from recent access.log lines.
 * Note: This is a heuristic, not exact. Intended for lightweight monitoring and coarse enforcement.
 * @param {number} maxLines
 * @returns {Record<string, number>}
 */
function getRecentUuidCounts(maxLines = 2000) {
  const lines = readAccessLogTail(maxLines);
  const uuids = extractUUIDs(lines);
  const counts = {};
  for (const u of uuids) counts[u] = (counts[u] || 0) + 1;
  return counts;
}

/**
 * Get approximate number of active users (unique UUIDs seen recently).
 * @param {number} maxLines
 * @returns {number}
 */
function getApproxActiveUsersCount(maxLines = 2000) {
  const lines = readAccessLogTail(maxLines);
  const uuids = extractUUIDs(lines);
  return new Set(uuids).size;
}

export default {
  // Paths
  USERS_FILE,
  DOMAINS_FILE,
  CONFIG_FILE,
  XRAY_BIN,
  PSIPHON_BIN,
  XRAY_ACCESS_LOG,
  XRAY_API_PORT,
  PSIPHON_OUTBOUND_TAG,
  DISABLE_STATS,

  // Utils
  ensureDir,
  readJson,
  writeJson,
  runCmd,
  bytesToGB,
  validateDomain,
  findDomainConflict,

  // Xray helpers
  getUserTraffic,
  getUserTrafficMulti,
  resetUserTrafficCounters,
  resetUserTrafficCountersMulti,
  reloadXray,
  restartXray,
  // Advanced reset helper to clear all stat name variants for provided keys
  resetUserTrafficAllVariants: function(keys = []) {
    const uniq = [...new Set(keys.filter(Boolean))];
    for (const k of uniq) {
      try {
        const raw = execSync(`${XRAY_BIN} api statsquery --server=127.0.0.1:${XRAY_API_PORT} --pattern "user>>>${k}"`).toString();
        let j; try { j = JSON.parse(raw); } catch { j = null; }
        const names = (j?.stat || []).map(s => s?.name).filter(Boolean);
        const resetPatterns = new Set([
          `user>>>${k}`,
          `user>>>${k}>>>traffic>>>uplink`,
          `user>>>${k}>>>traffic>>>downlink`,
          ...names
        ]);
        for (const p of resetPatterns) {
          try { execSync(`${XRAY_BIN} api statsreset --server=127.0.0.1:${XRAY_API_PORT} --pattern "${p}"`); } catch {}
        }
      } catch {}
    }
    return true;
  },

  // Access log helpers
  readAccessLogTail,
  extractUUIDs,
  getRecentUuidCounts,
  getApproxActiveUsersCount,
};