import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const preview = new URL('ticket-markup.html', import.meta.url).href;
const browsers = { chromium, firefox, webkit };
const names = process.argv.slice(2);
for (const name of names.length ? names : ['chromium']) {
  const browser = await browsers[name].launch();
  try {
    for (const width of [360, 820]) {
      const touch = width === 360 && name !== 'firefox';
      const page = await browser.newPage({ viewport: { width, height: 860 }, hasTouch: touch, reducedMotion: 'reduce' });
      const errors = [], externalRequests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (/^https?:/.test(request.url())) externalRequests.push(request.url());
      });
      const button = text => page.getByRole('button', { name: text, exact: true });
      await page.goto(preview);
      await page.getByRole('button', { name: /Play walkthrough/ }).waitFor();
      for (const label of ['Circle', 'Crop', 'Hide details', 'Review']) {
        await button(label).click();
        assert.equal(await button(label).getAttribute('aria-current'), 'step');
      }
      await button('Try it yourself').click();
      await button('Circle change due').click();
      await button('Crop').click();
      await button('Crop to receipt').click();
      await button('Hide details').click();
      await button('Cover customer number').click();
      const sampleMask = () => page.locator('#surface').evaluate(canvas =>
        Array.from(canvas.getContext('2d').getImageData(399, 45, 1, 1).data));
      assert.deepEqual(await sampleMask(), [24, 35, 48, 255]);
      await button('Undo edit').click();
      assert.notDeepEqual(await sampleMask(), [24, 35, 48, 255]);
      await button('Redo edit').click();
      await page.getByLabel('What did you expect to happen?').fill('Expected ฿20 change.');
      await button('Review attachment').click();
      await page.getByRole('heading', {name:'What support would see'}).waitFor();
      const exported = await page.locator('#result-image').evaluate(async image => {
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        const mask = ctx.getImageData(379, 37, 97, 20).data;
        const color = [24, 35, 48, 255];
        const circle = ctx.getImageData(360, 173, 124, 76).data;
        let redPixels = 0;
        for (let i = 0; i < circle.length; i += 4) {
          if (circle[i] > 140 && circle[i + 1] < 100 && circle[i + 2] < 90) redPixels++;
        }
        return [canvas.width, canvas.height, mask.every((v, i) => v === color[i % 4]), redPixels];
      });
      assert.deepEqual(exported.slice(0, 3), [489, 249, true]);
      assert.ok(exported[3] > 100);
      assert.equal(await page.locator('#result-text').textContent(), 'Expected ฿20 change.');
      await button('Back to editing').click();
      const surface = page.locator('#surface');
      await button('Crop').click();
      await surface.focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Shift+ArrowRight');
      await page.keyboard.press('Shift+ArrowDown');
      await page.keyboard.press('Enter');
      assert.ok(Number(await surface.getAttribute('width')) < 20);
      await button('Undo edit').click();
      for (const offset of [15, 80]) {
        const options = {position: {x:offset, y:offset}};
        if (touch) await surface.tap(options);
        else await surface.click(options);
      }
      assert.ok(Number(await surface.getAttribute('width')) < 200);
      await button('Undo edit').click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      assert.deepEqual(externalRequests, []);
      await page.close();
      console.log(name, browser.version(), width + 'px', 'walkthrough, practice, export pixels, undo/redo, keyboard, two clicks and offline checks passed');
    }
    const page = await browser.newPage();
    await page.goto(preview);
    await page.getByRole('button', { name: /Pause walkthrough/ }).click();
    await page.getByRole('button', { name: /Play walkthrough/ }).click();
    await page.getByRole('button', { name: /Replay walkthrough/ }).waitFor({timeout: 20000});
    assert.equal(await page.locator('.shot').getAttribute('data-step'), '3');
    console.log(name, 'autoplay stopped on the final step');
  } finally {
    await browser.close();
  }
}
