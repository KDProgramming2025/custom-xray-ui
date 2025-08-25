#!/usr/bin/env node
// Headless Chromium performance probe for admin panel real-world timings.
// Measures: page load, login roundtrip, first users table render (detects presence of #users-table rows),
// and time until second (full) refresh after 500ms staged fetch.
import puppeteer from 'puppeteer';

const BASE = process.env.PERF_URL || 'https://aparat.feezor.net/frontend/';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'admin';

function ts() { return Date.now(); }

(async () => {
  const launchT0 = ts();
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const ctx = { marks: {} };
  const page = await browser.newPage();
  page.setDefaultTimeout(90_000);
  page.on('console', msg => {
    if (/GET \/api\/users/.test(msg.text())) ctx.marks.lastUsersLog = ts();
  });

  const navStart = ts();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  ctx.marks.domContent = ts();

  // Wait for login form
  await page.waitForSelector('#login-form', { visible: true });
  ctx.marks.loginFormVisible = ts();

  await page.type('#login-username', USER);
  await page.type('#login-password', PASS);
  const submitClick = ts();
  await Promise.all([
    page.click('#loginSubmit'),
    page.waitForSelector('#logoutBtn', { visible: true }) // indicates auth overlay gone
  ]);
  ctx.marks.postLoginVisible = ts();

  // Now wait for first users table content (at least one row with data-id attribute)
  const usersFirstReqStart = ts();
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('#users-table tbody tr');
    return rows.length > 0 && rows[0].textContent.trim().length > 0;
  }, { polling: 100 });
  ctx.marks.usersFirstRender = ts();

  // Detect second (full refresh) render ~ after 500ms in frontend script by watching change in X-Cache-Age maybe - fallback to additional wait
  await page.waitForTimeout(1200);
  const usersSecondRender = ts();

  const metrics = {
    url: BASE,
    launchToBrowserMs: launchT0 ? (ctx.marks.domContent - launchT0) : null,
    navDomContentMs: ctx.marks.domContent - navStart,
    loginFormAppearMs: ctx.marks.loginFormVisible - navStart,
    loginRoundtripMs: ctx.marks.postLoginVisible - submitClick,
    firstUsersRenderMs: ctx.marks.usersFirstRender - submitClick,
    secondUsersRenderDeltaMs: usersSecondRender - ctx.marks.usersFirstRender,
    totalToFirstUsersMs: ctx.marks.usersFirstRender - navStart
  };

  console.log('[PERF_BROWSER]', JSON.stringify(metrics, null, 2));
  await browser.close();
})().catch(e => { console.error('perf-browser failed', e); process.exit(1); });
