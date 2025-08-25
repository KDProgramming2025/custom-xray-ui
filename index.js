'use strict';

/**
 * VPN Manager API - Main application
 * Feature groups (modular routes):
 * - Users: users.js
 * - Domains: domains.js
 * - Routing: routing.js
 * - Config: config-routes.js
 * - Backup/Restore: backup.js
 * - Status/Connections/Restart: status.js
 * - Update Binaries + Versions: update-binaries.js
 *
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

// Shared utils and feature modules
import utils from './utils.js';
import users from './users.js';
import domains from './domains.js';
import routing from './routing.js';
import configRoutes from './config-routes.js';
import status from './status.js';
import updateBinaries from './update-binaries.js';
import auth from './auth.js';

const app = express();
app.use(express.json());
// Disable Express ETag to avoid client-side caching of dynamic JSON
app.set('etag', false);

// ---- Process-level diagnostics (helps root-cause 502s due to crashes) ----
const START_TIME = Date.now();
let lastCrashLikeEvent = null;
function logCrashLike(tag, err) {
  lastCrashLikeEvent = { tag, time: new Date().toISOString(), message: String(err && err.message || err), stack: err && err.stack };
  console.error(`[PROCESS] ${tag}`, lastCrashLikeEvent);
}
process.on('uncaughtException', err => { logCrashLike('uncaughtException', err); });
process.on('unhandledRejection', (reason, p) => { logCrashLike('unhandledRejection', reason); });
['SIGINT','SIGTERM'].forEach(sig => {
  process.on(sig, () => {
    console.warn('[PROCESS] Received', sig, 'shutting down gracefully');
    try { server?.close(()=> process.exit(0)); } catch { process.exit(0); }
  });
});

// (Removed temporary performance instrumentation & loop lag debug code)

// Force no-store on /api/users endpoints (and subpaths) to prevent any intermediary caching
app.use((req, res, next) => {
  if (req.path.startsWith('/api/users')) {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    try { res.removeHeader('ETag'); } catch {}
  }
  next();
});

// Static frontend files
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'frontend')));

// Public lightweight health endpoint (no auth) for external probes / uptime monitors
// Returns only non-sensitive basics to avoid information leakage.
app.get(['/healthz','/health'], (_req,res) => {
  res.json({ ok: true, uptimeSec: +process.uptime().toFixed(1), startTs: new Date(START_TIME).toISOString(), now: new Date().toISOString(), lastCrashLikeEvent });
});

// Auth routes first (login / refresh / logout) public login; protect others
auth.registerAuth(app);
app.use('/api', auth.requireAuth); // protect remaining /api/* except /api/login already mounted

// (Removed diagnostics recap endpoint)

// Register feature groups
users.registerUserRoutes(app, utils);
domains.registerDomainRoutes(app, utils);
routing.registerRoutingRoutes(app, utils);
configRoutes.registerConfigRoutes(app, utils);
status.registerStatusRoutes(app, utils);
updateBinaries.registerUpdateBinaryRoutes(app, utils);

// Start server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log('VPN Manager API running on port', PORT);
});