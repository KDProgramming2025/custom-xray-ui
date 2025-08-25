'use strict';

/**
 * Config routes:
 * - GET  /api/config
 * - POST /api/config
 * - POST /api/config/validate
 *
 * @param {import('express').Express} app
 * @param {*} utils
 */
function registerConfigRoutes(app, utils) {
  const { CONFIG_FILE, readJson, writeJson, reloadXray } = utils;

  /**
   * GET /api/config
   * Return the full current config (formatted JSON).
   */
  app.get('/api/config', (req, res) => {
    try {
      const config = readJson(CONFIG_FILE);
      res.json(config);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /api/config
   * Overwrite the full config, then reload Xray.
   * Body: config JSON object
   */
  app.post('/api/config', (req, res) => {
    const config = req.body;
    try {
      writeJson(CONFIG_FILE, config);
      reloadXray();
      res.json({ saved: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /api/config/validate
   * Validate incoming config JSON is well-formed (basic structural check).
   */
  app.post('/api/config/validate', (req, res) => {
    const config = req.body;
    try {
      JSON.stringify(config);
      res.json({ valid: true });
    } catch (e) {
      res.status(400).json({ valid: false, error: e.message });
    }
  });
}

export default { registerConfigRoutes };