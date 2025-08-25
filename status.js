'use strict';

/**
 * Status, connections, and restart routes:
 * - GET  /api/status
 * - GET  /api/connections
 * - POST /api/restart/xray
 * - POST /api/restart/psiphon
 *
 * @param {import('express').Express} app
 * @param {*} utils
 */
import { exec } from 'child_process';

function registerStatusRoutes(app, utils) {
  const { XRAY_BIN, PSIPHON_BIN } = utils;

  /**
   * GET /api/status
   * Returns whether Xray and Psiphon processes are running.
   */
  app.get('/api/status', async (req, res) => {
    try {
      const xrayStatus = await new Promise(resolve => {
        exec(`pgrep -f '${XRAY_BIN}'`, (err, stdout) => resolve(!!stdout?.toString().trim()));
      });
      const psiphonStatus = await new Promise(resolve => {
        exec(`pgrep -f '${PSIPHON_BIN}'`, (err, stdout) => resolve(!!stdout?.toString().trim()));
      });
      res.json({
        xray: xrayStatus ? 'running' : 'stopped',
        psiphon: psiphonStatus ? 'running' : 'stopped',
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });


  /**
   * POST /api/restart/xray
   * Restart Xray service.
   */
  app.post('/api/restart/xray', (req, res) => {
    exec('systemctl restart xray', (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ restarted: 'xray' });
    });
  });

  /**
   * POST /api/restart/psiphon
   * Restart Psiphon service.
   */
  app.post('/api/restart/psiphon', (req, res) => {
    exec('systemctl restart psiphon', (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ restarted: 'psiphon' });
    });
  });
}

export default { registerStatusRoutes };