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
      const errors = [], external = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('request', r => { if (/^https?:/.test(r.url())) external.push(r.url()); });
      const button = label => page.getByRole('button', {name:label, exact:true});
      const click = label => button(label).click();
      const surface = page.locator('#surface');
      const select = label => page.getByLabel('Selected mark', {exact:true}).selectOption({label});
      const marks = () => page.locator('#objects option').allTextContents();
      async function at(x,y) {
        await surface.scrollIntoViewIfNeeded();
        const b = await surface.boundingBox();
        return {x:b.x + b.width*x/720,y:b.y+b.height*y/350};
      }
      async function tap(x,y) {
        const p=await at(x,y);
        if(touch) await page.touchscreen.tap(p.x,p.y);
        else await page.mouse.click(p.x,p.y);
      }
      async function review() {
        await click('Review attachment');
        await button('Back to editing').waitFor();
        return page.locator('#result-image').evaluate(async img=>{
          await img.decode();
          const c=document.createElement('canvas');
          c.width=img.naturalWidth;c.height=img.naturalHeight;
          const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
          // The crop starts at (201,68). Sample both the phone and change amount.
          const mask=ctx.getImageData(379,37,97,20).data;
          const oval=ctx.getImageData(350,160,137,87).data;
          let red=0;
          for(let i=0;i<oval.length;i+=4)if(oval[i]>140 && oval[i+1]<100 && oval[i+2]<90)red++;
          return {size:[c.width,c.height],red,covered:mask.every((v,i)=>v===[24,35,48,255][i%4]),pixels:c.toDataURL()};
        });
      }

      await page.goto(preview);
      await page.locator('#width-value').filter({hasText:'108 px'}).waitFor();
      await click('Increase width');
      assert.equal(await page.locator('#width-value').innerText(),'116 px');
      assert.equal(await page.locator('#height-value').innerText(),'52 px');
      await click('Decrease height');
      await page.getByLabel('Outline',{exact:true}).selectOption('8');
      const from=await at(688,273), to=await at(698,273);
      await page.mouse.move(from.x,from.y);await page.mouse.down();
      await page.mouse.move(to.x,to.y,{steps:4});await page.mouse.up();
      assert.ok(parseInt(await page.locator('#width-value').innerText())>120);
      await click('Undo edit');
      assert.equal(await page.locator('#width-value').innerText(),'116 px');
      await click('Redo edit');

      // Place a second, overlapping oval followed by a privacy mask and crop.
      await click('Circle');await tap(597,264);
      await click('Hide details');await click('Cover customer number');
      await click('Increase width');await click('Decrease width');
      await click('Crop');await click('Crop to receipt');
      await click('Increase height');await click('Decrease height');
      await page.getByLabel('What did you expect to happen?').fill('Expected ฿20 change.');
      const before=await review();
      assert.deepEqual(before.size,[489,249]);
      assert.ok(before.covered && before.red>100);
      assert.equal(await page.locator('#result-text').textContent(),'Expected ฿20 change.');
      await click('Back to editing');

      await click('Eraser');await select('Circle 1');await click('Remove selected mark');
      assert.deepEqual(await marks(),['Choose a mark','Circle 2','Mask 3','Crop frame']);
      const after=await review();
      assert.ok(after.covered && after.red>100 && after.red<before.red);
      await click('Back to editing');await click('Undo edit');
      assert.deepEqual(await marks(),['Choose a mark','Circle 1','Circle 2','Mask 3','Crop frame']);
      assert.equal((await review()).pixels,before.pixels);
      await click('Back to editing');await click('Redo edit');
      assert.equal((await review()).pixels,after.pixels);
      await click('Back to editing');

      await click('Eraser');await tap(628,114);
      assert.equal((await review()).covered,false);
      await click('Back to editing');await click('Undo edit');
      assert.equal((await review()).pixels,after.pixels);
      await click('Back to editing');
      await select('Circle 2');await surface.focus();await page.keyboard.press('Delete');
      assert.ok(!(await marks()).includes('Circle 2'));
      await select('Crop frame');await click('Reset crop');
      assert.deepEqual((await review()).size,[720,350]);
      await click('Back to editing');
      await click('Crop');await surface.focus();
      await page.keyboard.press('Enter');await page.keyboard.press('Shift+ArrowRight');
      await page.keyboard.press('Shift+ArrowDown');await page.keyboard.press('Enter');
      assert.deepEqual((await review()).size,[17,17]);
      await click('Back to editing');await click('Crop');await tap(10,10);await tap(100,90);
      const twoTaps=await review();
      assert.ok(Math.abs(twoTaps.size[0]-91)<4 && Math.abs(twoTaps.size[1]-81)<4, JSON.stringify(twoTaps.size));
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await click('Walkthrough');
      for (const label of ['Circle','Resize','Crop','Hide details','Eraser','Review']){
        await click(label);assert.equal(await button(label).getAttribute('aria-current'),'step');
      }
      assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
      await page.close();
      console.log(name,browser.version(),width+'px','resize, drag, erase, overlap, undo/redo, crop, mask pixels, keyboard and walkthrough passed');
    }
    const page=await browser.newPage();
    await page.goto(preview+'#walkthrough');
    await page.getByRole('button',{name:/Pause walkthrough/}).click();
    await page.getByRole('button',{name:/Play walkthrough/}).click();
    await page.getByRole('button',{name:/Replay walkthrough/}).waitFor({timeout:25000});
    assert.equal(await page.locator('.shot').getAttribute('data-scene'),'review');
    console.log(name,'autoplay stopped on Review');
  } finally { await browser.close(); }
}
