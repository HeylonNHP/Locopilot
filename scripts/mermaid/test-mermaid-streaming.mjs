import { chromium } from 'playwright';

const URL = 'http://localhost:3456/mermaid-streaming';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(URL);
  await page.waitForTimeout(3000);
  const result = await page.evaluate(() => {
    const pres = [...document.querySelectorAll('pre')];
    const code = document.querySelector('pre > code.language-mermaid');
    const rendered = document.querySelector('pre.mermaid-rendered');
    const error = document.querySelector('pre.mermaid-error');
    return {
      preCount: pres.length,
      hasCode: !!code,
      codeText: code?.textContent?.slice(0, 200) || null,
      rendered: !!rendered,
      svg: !!rendered?.querySelector('svg'),
      error: error?.textContent?.slice(0, 500) || null,
      bodyText: document.body.textContent.slice(0, 300),
    };
  });
  console.log(result);
  await browser.close();
}

try { await main(); } catch (err) { console.error(err); throw err; }
