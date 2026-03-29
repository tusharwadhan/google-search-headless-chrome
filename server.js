const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3001;

let browser = null;
let lastRequestTime = 0;
const MIN_REQUEST_GAP = 2000; // 2s between requests to avoid Google blocking

function log(msg) {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] ${msg}`);
}

async function launchBrowser() {
  if (browser) {
    try { await browser.close(); } catch {}
  }
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--disable-extensions',
      '--js-flags=--max-old-space-size=128'
    ]
  });
  log('Browser launched');
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: browser ? 'ready' : 'starting', uptime: process.uptime() });
});

// Search endpoint
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Missing ?q= parameter' });
  }

  // Rate limit
  const now = Date.now();
  const wait = MIN_REQUEST_GAP - (now - lastRequestTime);
  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait));
  }
  lastRequestTime = Date.now();

  if (!browser) {
    return res.status(503).json({ error: 'Browser not ready' });
  }

  let page = null;
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-IN',
      viewport: { width: 1280, height: 720 }
    });
    page = await context.newPage();

    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
    log(`Searching: ${query}`);

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Wait for results to render
    await page.waitForSelector('h3', { timeout: 10000 }).catch(() => {});

    // Extract search results
    const results = await page.evaluate(() => {
      const items = [];
      const headings = document.querySelectorAll('h3');
      headings.forEach(h3 => {
        const anchor = h3.closest('a');
        const title = h3.textContent?.trim();
        const url = anchor?.href || '';
        if (title && url && !url.includes('google.com')) {
          items.push({ title, url });
        }
      });
      return items.slice(0, 5);
    });

    log(`Found ${results.length} results for: ${query}`);
    await context.close();

    res.json({ results, query });
  } catch (err) {
    log(`Search error: ${err.message}`);
    if (page) {
      try {
        const ctx = page.context();
        await ctx.close();
      } catch {}
    }

    // Relaunch browser if it crashed
    if (err.message.includes('Target closed') || err.message.includes('Browser closed')) {
      log('Browser crashed, relaunching...');
      await launchBrowser();
    }

    res.status(500).json({ error: err.message });
  }
});

// Start
app.listen(PORT, async () => {
  log(`Search service running on port ${PORT}`);
  await launchBrowser();
});
