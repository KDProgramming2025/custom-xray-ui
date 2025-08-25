'use strict';

/**
 * Routing rules routes:
 * - GET  /api/routing-rules
 * - POST /api/routing-rules
 * - GET  /api/routing/psiphon-domains
 *
 * Features:
 * - View/replace routing rules in Xray config
 * - View which domains are currently routed via Psiphon (by outboundTag)
 *
 * @param {import('express').Express} app
 * @param {*} utils
 */
function registerRoutingRoutes(app, utils) {
  const {
    CONFIG_FILE,
    readJson,
    writeJson,
  reloadXray,
  restartXray,
    PSIPHON_OUTBOUND_TAG,
  } = utils;

  /**
   * GET /api/routing-rules
   * Returns the routing.rules array from config.
   */
  app.get('/api/routing-rules', (req, res) => {
    try {
      const config = readJson(CONFIG_FILE);
      const rules = (config.routing && config.routing.rules) || [];
      res.json(rules);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /api/routing-rules
   * Replace all routing.rules with the provided array, then reload Xray.
   * Body: { rules: array }
   */
  app.post('/api/routing-rules', (req, res) => {
    const { rules } = req.body;
    if (!Array.isArray(rules)) return res.status(400).json({ error: 'rules must be array' });
    try {
      const config = readJson(CONFIG_FILE);
      config.routing = { ...config.routing, rules };
      writeJson(CONFIG_FILE, config);
  // Full restart required after routing changes per current requirement
  if (typeof restartXray === 'function') restartXray(); else reloadXray();
      res.json({ updated: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /api/routing/psiphon-domains
   * Returns a de-duplicated list of domains that are routed to the Psiphon outbound.
   */
  app.get('/api/routing/psiphon-domains', (req, res) => {
    try {
      const config = readJson(CONFIG_FILE);
      const rules = (config.routing && config.routing.rules) || [];
      const domains = new Set();

      for (const r of rules) {
        if (!r) continue;
        const toPsiphon = r.outboundTag === PSIPHON_OUTBOUND_TAG;
        if (!toPsiphon) continue;
        // Common Xray rule fields: domain, domains, or rule.domain like { type: 'field', domain: ['example.com'] }
        if (Array.isArray(r.domain)) r.domain.forEach(d => domains.add(d));
        if (Array.isArray(r.domains)) r.domains.forEach(d => domains.add(d));
        if (r.domain && typeof r.domain === 'string') domains.add(r.domain);
      }

      res.json({ outboundTag: PSIPHON_OUTBOUND_TAG, domains: Array.from(domains) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

export default { registerRoutingRoutes };