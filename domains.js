'use strict';

/**
 * Domain management routes:
 * - GET    /api/domains
 * - POST   /api/domains
 * - DELETE /api/domains/:domain
 * - POST   /api/domains/:domain/toggle
 *
 * Features:
 * - Enable/disable domains (soft toggle)
 * - Add/remove domains
 * - Support domain wildcards (e.g., *.aparat.com)
 * - Warn/block when a domain overlaps or conflicts with an existing (wildcard/exact) entry
 *
 * @param {import('express').Express} app
 * @param {*} utils - shared utilities (see utils.js)
 */
function registerDomainRoutes(app, utils) {
  const {
    DOMAINS_FILE,
    readJson,
    writeJson,
    validateDomain,
    findDomainConflict,
  } = utils;

  /**
   * GET /api/domains
   * Returns all domains with flags (enabled, wildcard).
   */
  app.get('/api/domains', (req, res) => {
    try {
      const domains = readJson(DOMAINS_FILE);
      res.json(domains);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /api/domains
   * Body: { domain: string, wildcard?: boolean }
   * Adds a domain (supports wildcard). Blocks duplicates and overlaps with existing entries.
   */
  app.post('/api/domains', (req, res) => {
    const { domain, wildcard } = req.body;
    if (!domain || !validateDomain(domain)) {
      return res.status(400).json({ error: 'Valid domain is required' });
    }
    try {
      let domains = readJson(DOMAINS_FILE);

      // Duplicate exact entry check
      if (domains.find(d => d.domain === domain && !!d.wildcard === !!wildcard)) {
        return res.status(400).json({ error: 'Domain already exists' });
      }

      // Overlap/conflict check (wildcard vs exact and vice versa)
      if (findDomainConflict(domains, domain, !!wildcard)) {
        return res.status(400).json({ error: 'Domain conflict with existing entry' });
      }

      domains.push({ domain, enabled: true, wildcard: !!wildcard });
      writeJson(DOMAINS_FILE, domains);
      res.json({ added: domain });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * DELETE /api/domains/:domain
   * Removes an exact domain string entry.
   */
  app.delete('/api/domains/:domain', (req, res) => {
    const { domain } = req.params;
    try {
      let domains = readJson(DOMAINS_FILE);
      domains = domains.filter(d => d.domain !== domain);
      writeJson(DOMAINS_FILE, domains);
      res.json({ removed: domain });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /api/domains/:domain/toggle
   * Flips the enabled flag of a domain entry.
   */
  app.post('/api/domains/:domain/toggle', (req, res) => {
    const { domain } = req.params;
    try {
      let domains = readJson(DOMAINS_FILE);
      const domainObj = domains.find(d => d.domain === domain);
      if (!domainObj) return res.status(404).json({ error: 'Domain not found' });

      domainObj.enabled = !domainObj.enabled;
      writeJson(DOMAINS_FILE, domains);
      res.json({ toggled: domain, enabled: domainObj.enabled });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

export default { registerDomainRoutes };