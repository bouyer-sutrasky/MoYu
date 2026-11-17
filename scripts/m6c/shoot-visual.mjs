import { chromium } from 'playwright';

const [, , base, out, theme = 'light', mobile = 'false'] = process.argv;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: mobile === 'true' ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  colorScheme: theme,
  deviceScaleFactor: 1,
});
await context.addCookies([
  { name: 'moyu_session', value: 'visual-token', domain: '127.0.0.1', path: '/' },
]);
const page = await context.newPage();
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
if (mobile === 'true') {
  const open = page.getByLabel('打开导航');
  if (await open.isVisible().catch(() => false)) await open.click();
  await page.waitForTimeout(400);
}
await page.screenshot({ path: out, fullPage: false });
await browser.close();
