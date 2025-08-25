'use strict';

/**
 * Backup and restore routes:
 * - POST /api/backup
 * - POST /api/restore
 * - GET  /api/backup/download/:filename
 * - POST /api/backup/upload
 *
 * @param {import('express').Express} app
 * @param {*} utils
 */
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';

function registerBackupRoutes(app, utils) {
  const {
    USERS_FILE,
    DOMAINS_FILE,
    CONFIG_FILE,
    BACKUP_DIR,
    readJson,
    writeJson,
    ensureDir,
    reloadXray,
  } = utils;
  const FULL_BACKUP_DIR = path.join(BACKUP_DIR, 'full');

  /**
   * POST /api/backup
   * Create a full snapshot (users/domains/config) and store under BACKUP_DIR.
   */
  app.post('/api/backup', (req, res) => {
    try {
      ensureDir(BACKUP_DIR);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = {
        users: readJson(USERS_FILE),
        domains: readJson(DOMAINS_FILE),
        config: readJson(CONFIG_FILE),
      };
  const backupFile = path.join(BACKUP_DIR, `vpn-backup-${stamp}.json`);
      writeJson(backupFile, backup);
      res.json({ path: backupFile });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /api/backup/full
   * Streams a tar.gz containing everything needed to recreate the VPN setup.
   * This intentionally gathers a wide list of likely relevant paths; only existing ones are included.
   * Must run with sufficient permissions (root) to read system files/binaries.
   */
  app.get('/api/backup/full', (req, res) => {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const candidatePaths = [
        // Project root (admin panel backend/frontend & data files)
        path.join(process.cwd()),
        USERS_FILE, DOMAINS_FILE, CONFIG_FILE,
        // Xray / Psiphon config (exclude volatile /var/log/* dirs to keep archive small)
        '/etc/xray', '/usr/local/etc/xray', '/etc/psiphon',
        // Nginx configuration
        '/etc/nginx/nginx.conf', '/etc/nginx/conf.d', '/etc/nginx/sites-available', '/etc/nginx/sites-enabled',
        // Systemd units (service definitions)
        '/etc/systemd/system/xray.service', '/etc/systemd/system/psiphon.service', '/etc/systemd/system/vpn-manager.service',
        // Binaries (if locally installed)
        '/usr/local/bin/xray', '/usr/bin/xray', '/usr/local/bin/psiphon', '/usr/bin/psiphon'
      ];
      const existing = candidatePaths.filter(p => { try { fs.accessSync(p); return true; } catch { return false; } });
      if (existing.length === 0) return res.status(500).json({ error: 'No expected paths found to back up' });

      // Build manifest metadata
      const manifest = {
        createdAt: new Date().toISOString(),
        host: os.hostname(),
        platform: process.platform,
        node: process.version,
        included: existing,
  appVersion: (()=>{ try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'))).version || null; } catch { return null; } })()
      };
      const manifestPath = path.join(os.tmpdir(), `vpn-backup-manifest-${process.pid}-${Date.now()}.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      existing.push(manifestPath);

      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="vpn-full-backup-${stamp}.tar.gz"`);

      // Use absolute paths; -P preserves them; restoration script can relocate.
      const args = ['-czf', '-', '-P', ...existing];
      const tar = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      tar.stdout.pipe(res);
      let stderr = '';
      tar.stderr.on('data', d => { stderr += d.toString(); });
      tar.on('close', code => {
        fs.unlink(manifestPath, () => {});
        if (code !== 0) {
          if (!res.headersSent) res.status(500).end('tar failed');
          console.error('Full backup tar error:', code, stderr);
        }
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /api/backup/full
   * Create a tar.gz file on disk (not streamed) containing full environment and return filename.
   * Response: { file, size, manifest }
   */
  app.post('/api/backup/full', (req, res) => {
    try {
      ensureDir(FULL_BACKUP_DIR);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const finalFile = path.join(FULL_BACKUP_DIR, `vpn-full-backup-${stamp}.tar.gz`);
      const tmpFile = path.join(os.tmpdir(), `vpn-full-backup-${process.pid}-${Date.now()}.tar.gz`);

      const projectRoot = process.cwd();
      const candidatePaths = [
        // Project code root (will exclude backups dir below)
        projectRoot,
        USERS_FILE, DOMAINS_FILE, CONFIG_FILE,
        '/etc/xray', '/usr/local/etc/xray', '/etc/psiphon',
        '/etc/nginx/nginx.conf', '/etc/nginx/conf.d', '/etc/nginx/sites-available', '/etc/nginx/sites-enabled',
        '/etc/systemd/system/xray.service', '/etc/systemd/system/psiphon.service', '/etc/systemd/system/vpn-manager.service',
        '/usr/local/bin/xray', '/usr/bin/xray', '/usr/local/bin/psiphon', '/usr/bin/psiphon'
      ];
      const existing = candidatePaths.filter(p => { try { fs.accessSync(p); return true; } catch { return false; } });
      if (!existing.length) return res.status(500).json({ error: 'No paths found' });

      const manifest = {
        createdAt: new Date().toISOString(),
        included: existing,
  appVersion: (()=>{ try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'))).version || null; } catch { return null; } })()
      };
      const manifestPath = path.join(os.tmpdir(), `vpn-backup-manifest-${process.pid}-${Date.now()}.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      existing.push(manifestPath);

      // Build tar (exclude backup dir + temp file itself to avoid recursion). Use absolute paths with -P.
      const backupDirPath = path.join(projectRoot, 'backups');
      const excludes = [
        '--exclude', backupDirPath,
        '--exclude', backupDirPath + '/*',
        '--exclude', finalFile,
        '--exclude', tmpFile,
        '--exclude', '/var/log/xray',
        '--exclude', '/var/log/xray/*',
        '--exclude', '/var/log/psiphon',
        '--exclude', '/var/log/psiphon/*'
      ];
      // Suppress benign changing-log warnings & ignore read failures that are transient
      const args = ['-czf', tmpFile, '--warning=no-file-changed', '--ignore-failed-read', ...excludes, '-P', ...existing];
      const tar = spawn('tar', args);
      let stderr = '';
      tar.stderr.on('data', d => { stderr += d.toString(); });
      tar.on('close', code => {
        fs.unlink(manifestPath, () => {});
        // Treat changing log warnings / ignored read failures as benign.
        const benignPattern = /(file changed as we read it)|(Removing leading)/i;
        const linesRaw = stderr.trim();
        const lines = linesRaw ? linesRaw.split('\n').filter(l=>l) : [];
        const onlyBenign = (lines.length > 0 && lines.every(l=>benignPattern.test(l)));
        if (code !== 0 && !onlyBenign) {
          console.warn('tar non-zero with stderr lines', { code, lines });
        }
        if (code !== 0 && !onlyBenign) {
          console.error('Full backup tar failed', { code, stderr });
          return res.status(500).json({ error: 'tar failed', code, stderr });
        }
        if (code !== 0 && onlyBenign) console.warn('tar exited non-zero with only benign warnings');
        try { fs.renameSync(tmpFile, finalFile); } catch (e) {
          console.error('Rename failed', e);
          return res.status(500).json({ error: 'rename failed', detail: e.message });
        }
        let size = 0;
        try { size = fs.statSync(finalFile).size; } catch {}
        res.json({ file: path.basename(finalFile), size, manifest, excludes });
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Explicit download route (avoids relying on static middleware / reverse proxy specifics)
  app.get('/backups/full/:filename', (req, res) => {
    try {
      const { filename } = req.params;
      if (!filename || !/^[a-zA-Z0-9._-]+$/.test(filename)) {
        return res.status(400).json({ error: 'Invalid filename' });
      }
      const base = path.join(BACKUP_DIR, 'full');
      const filePath = path.join(base, filename);
      // Prevent path traversal
      if (!filePath.startsWith(base)) return res.status(400).json({ error: 'Bad path' });
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
      res.download(filePath);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * POST /api/restore
   * Restore a previously created backup file path.
   * Body: { backupFile: string }
   */
  app.post('/api/restore', (req, res) => {
    const { backupFile } = req.body;
    try {
      const backup = readJson(backupFile);
      writeJson(USERS_FILE, backup.users);
      writeJson(DOMAINS_FILE, backup.domains);
      writeJson(CONFIG_FILE, backup.config);
      reloadXray();
      res.json({ restored: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /api/backup/download/:filename
   * Download a backup file stored in BACKUP_DIR.
   */
  app.get('/api/backup/download/:filename', (req, res) => {
    const { filename } = req.params;
  const filePath = path.join(BACKUP_DIR, filename);
    res.download(filePath);
  });

  /**
   * POST /api/backup/upload
   * Upload a raw JSON backup (as request body) and store it as a file.
   */
  app.post('/api/backup/upload', (req, res) => {
    try {
      ensureDir(BACKUP_DIR);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(BACKUP_DIR, `vpn-uploaded-${stamp}.json`);
      writeJson(backupFile, req.body);
      res.json({ uploaded: backupFile });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

export default { registerBackupRoutes };