import { chromium } from 'playwright';
const [, , base] = process.argv;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies([
  { name: 'moyu_session', value: 'visual-token', domain: '127.0.0.1', path: '/' },
]);
const page = await context.newPage();
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
console.log((await page.locator('body').innerText()).slice(0, 2000));
await browser.close();
