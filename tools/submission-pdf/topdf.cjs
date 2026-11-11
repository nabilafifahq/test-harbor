// Prints submission.html (written by build.py) to docs/submission.pdf with Playwright's Chromium.
const path = require('path');
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.goto('file://' + path.join(__dirname, 'submission.html'), { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  await p.pdf({ path: process.env.OUT || path.join(__dirname, '..', '..', 'docs', 'submission.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true, headerTemplate: '<div></div>',
    footerTemplate: '<div style="width:100%;font-size:7pt;color:#74869B;padding:0 15mm;display:flex;justify-content:space-between;font-family:Arial"><span>Harbor Point Order Desk · Submission · HP-O2C-SUB-001</span><span><span class="pageNumber"></span> of <span class="totalPages"></span></span></div>' });
  await b.close();
})();
