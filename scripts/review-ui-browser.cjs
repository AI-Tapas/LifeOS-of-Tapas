/* eslint-disable @typescript-eslint/no-require-imports -- Optional browser harness uses NODE_PATH for externally installed tooling. */
// Run against the local development fixture. Requires playwright and
// @axe-core/playwright in NODE_PATH, plus CHROMIUM_EXECUTABLE if needed.
// Synthetic UI only: no sign-in, provider delivery or database write occurs.
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const assert = require('node:assert/strict');
const base = process.env.REVIEW_BASE_URL || 'http://localhost:3000';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(base + '/dev-preview');
    await page.waitForTimeout(1500); // Allow the development fixture to hydrate.
    const opener = page.getByRole('button', { name: '+ Task', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'New task', exact: true });
    await dialog.waitFor();
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('dialog')), true, 'initial focus belongs to modal');
    await page.getByRole('button', { name: 'Close', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('dialog')), true, 'backward tab cannot reach background');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await opener.evaluate((element) => element === document.activeElement), true, 'focus returns to opener');
    await opener.click();
    await dialog.getByLabel('Title', { exact: true }).fill('Synthetic unsaved task');
    page.once('dialog', (confirmation) => confirmation.dismiss());
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 1, 'declining discard preserves dirty form');
    page.once('dialog', (confirmation) => confirmation.accept());
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    console.log('PASS modal focus, Shift+Tab containment, Escape, restoration and dirty dismissal');

    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      await page.waitForTimeout(400); // Finish theme colour transitions before contrast sampling.
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const result = await new AxeBuilder({ page }).exclude('p.bg-amber-100').withRules(['color-contrast', 'list', 'scrollable-region-focusable']).analyze();
        assert.deepEqual(result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.html) })), [], `${colorScheme} ${width}px component accessibility`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no page overflow');
      }
    }
    console.log('PASS contrast, list semantics, keyboard scroll regions and no overflow at 320/390/1280px in light and dark themes');

    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.evaluate(async () => {
      const legacy = await caches.open('life-os-v4');
      await legacy.put('/synthetic-private', new Response('private fixture'));
      await new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = resolve;
        navigator.serviceWorker.controller.postMessage({ type: 'PURGE_PRIVATE_DATA' }, [channel.port2]);
      });
    });
    assert.equal(await page.evaluate(async () => (await caches.keys()).includes('life-os-v4')), false);
    assert.equal(await page.evaluate(async () => !!await caches.match(location.href)), false, 'private preview HTML is never cached');
    const other = await context.newPage();
    await other.goto(base + '/dev-preview');
    await other.waitForTimeout(1500); // The tab must hydrate its cross-tab listener.
    await page.evaluate(() => localStorage.setItem('lifeos:signed-out', String(Date.now())));
    await other.waitForURL('**/login');
    console.log('PASS sign-out signal clears another tab via full navigation and removes legacy cache');
    await context.clearCookies();
    await context.setOffline(true);
    await page.goto(base + '/dev-preview');
    await page.getByRole('heading', { name: 'Offline', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '+ Task', exact: true }).count(), 0);
    console.log('PASS offline navigation shows public shell only after cookie removal');
    await context.setOffline(false);
    await page.goto(base + '/login?error=invalid_link&next=https%3A%2F%2Fevil.test');
    await page.getByRole('status').filter({ hasText: 'expired' }).waitFor();
    await page.route('**/auth/v1/otp*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ msg: 'database error', code: 'unexpected_failure' }) }));
    await page.getByRole('button', { name: 'Send sign-in code', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'temporarily unavailable' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Send sign-in code', exact: true }).isEnabled(), true);
    console.log('PASS expired-link recovery and service outage feedback; sign-in control remains usable');
    await context.close();
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
