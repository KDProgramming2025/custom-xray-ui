'use strict';

/**
 * Registers endpoints to update Xray and Psiphon binaries and show their current versions.
 * Implements robust download+install using curl/unzip and systemctl reload/restart.
 *
 * Endpoints:
 *  - POST /api/update/xray
 *  - POST /api/update/psiphon
 *  - GET  /api/version
 *
 * Dependencies expected on the system: curl, unzip (for Xray .zip extraction).
 *
 * @param {import('express').Express} app
 * @param {*} utils imported utils module
 */
function registerUpdateBinaryRoutes(app, utils) {
  const { runCmd, reloadXray, XRAY_BIN, PSIPHON_BIN } = utils;

  // Update Xray from latest release
  app.post('/api/update/xray', async (req, res) => {
    const script = `
      set -euo pipefail
      tmp="$(mktemp -d)"
      trap 'rm -rf "$tmp"' EXIT
      cd "$tmp"
      curl -fsSL -o xray.zip https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip
      unzip -o xray.zip xray >/dev/null
      install -m 0755 xray "${XRAY_BIN}"
    `;
    try {
      await runCmd(script);
      reloadXray();
      res.json({ updated: true, binary: XRAY_BIN });
    } catch (err) {
      res.status(500).json({
        updated: false,
        error: err.message || String(err),
        stderr: err.stderr || '',
      });
    }
  });

  // Update Psiphon from latest release
  app.post('/api/update/psiphon', async (req, res) => {
    const script = `
      set -euo pipefail
      tmp="$(mktemp -d)"
      trap 'rm -rf "$tmp"' EXIT
      cd "$tmp"
      curl -fsSL -o psiphon https://github.com/Psiphon-Inc/psiphon-tunnel-core/releases/latest/download/psiphon-tunnel-core-linux
      chmod +x psiphon
      install -m 0755 psiphon "${PSIPHON_BIN}"
    `;
    try {
      await runCmd(script);
      await runCmd('systemctl restart psiphon');
      res.json({ updated: true, binary: PSIPHON_BIN });
    } catch (err) {
      res.status(500).json({
        updated: false,
        error: err.message || String(err),
        stderr: err.stderr || '',
      });
    }
  });

  // Show versions of Xray/Psiphon
  app.get('/api/version', async (req, res) => {
    try {
      const xr = await runCmd(`${XRAY_BIN} version || true`);
      const ps = await runCmd(`${PSIPHON_BIN} --version || true`);
      res.json({
        xray: xr.stdout.trim() || xr.stderr.trim(),
        psiphon: ps.stdout.trim() || ps.stderr.trim(),
      });
    } catch (err) {
      res.status(500).json({
        error: err.message || String(err),
        stderr: err.stderr || '',
      });
    }
  });
}

export default { registerUpdateBinaryRoutes };