import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--window-size=600,700'] });
const page = await browser.newPage(); await page.setViewport({ width: 600, height: 700 });
page.on('console', (m) => m.type() === 'error' && !/XNNPACK/.test(m.text()) && console.log('ERR', m.text()));
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
await page.goto('http://localhost:8765/tests/render.html', { waitUntil: 'networkidle0' });
await page.waitForFunction('window.ready');
const out = process.env.OUT;
for (const f of process.argv.slice(2)) {
  const r = await page.evaluate(async (f) => {
    const rep = await head.fromPhoto('/dev/' + f);
    head.setFraming('portrait'); head.renderStill({}, {});
    return { g: rep.hairGray, v: rep.hairVar, hair: rep.colors.hair, gc: rep.colors.hairGray, png: head.renderer.domElement.toDataURL('image/png') };
  }, f);
  if (out) fs.writeFileSync(`${out}/ht-${f.split('/')[1].replace('.jpg', '')}.png`, Buffer.from(r.png.split(',')[1], 'base64'));
  delete r.png; console.log(f.padEnd(22), JSON.stringify(r));
}
await browser.close();
