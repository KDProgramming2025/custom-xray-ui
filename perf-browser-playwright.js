#!/usr/bin/env node
import { chromium } from 'playwright';

const BASE = process.env.PERF_URL || 'https://aparat.feezor.net/frontend/';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'admin';

function now(){ return Date.now(); }

(async () => {
  const tLaunch0 = now();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();

  const tNavStart = now();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const tDomContent = now();
  await page.waitForSelector('#login-form', { state: 'visible', timeout: 60000 });
  const tLoginForm = now();

  await page.fill('#login-username', USER);
  await page.fill('#login-password', PASS);
  const tSubmit = now();
  await Promise.all([
    page.click('#loginSubmit'),
    page.waitForSelector('#logoutBtn', { state: 'visible', timeout: 60000 })
  ]);
  const tLoggedIn = now();

  // First users row
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('#users-table tbody tr');
    return rows.length > 0 && rows[0].textContent.trim().length > 0;
  }, { timeout: 60000 });
  const tFirstUsers = now();

  // Wait small time for the second (full) refresh (frontend schedules ~500ms later)
  await page.waitForTimeout(1200);
  const tSecondUsers = now();

  const metrics = {
    url: BASE,
    navDomContentMs: tDomContent - tNavStart,
    loginFormAppearMs: tLoginForm - tNavStart,
    loginRoundtripMs: tLoggedIn - tSubmit,
    firstUsersRenderAfterSubmitMs: tFirstUsers - tSubmit,
    totalTimeToFirstUsersMs: tFirstUsers - tNavStart,
    secondUsersDeltaMs: tSecondUsers - tFirstUsers
  };
  console.log('[PLAYWRIGHT_PERF]', JSON.stringify(metrics, null, 2));
  await browser.close();
})().catch(e => { console.error('playwright perf failed', e); process.exit(1); });
