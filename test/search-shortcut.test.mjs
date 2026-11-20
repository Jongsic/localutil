import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

test('Ctrl+S focuses the tool search', async () => {
    await env.goto('index.html');
    await env.page.keyboard.press('Control+s');
    assert.equal(await env.page.evaluate(() => document.activeElement.id), 'tool-search');
});

test('Ctrl+F is left to the browser find-in-page', async () => {
    await env.goto('index.html');
    await env.page.keyboard.press('Control+f');
    const active = await env.page.evaluate(() => document.activeElement.id || document.activeElement.tagName);
    assert.notEqual(active, 'tool-search');
});

test('search filters the nav', async () => {
    await env.goto('index.html');
    await env.page.fill('#tool-search', 'wallet');
    const visible = await env.page.$$eval('.nav-item', els =>
        els.filter(e => e.style.display !== 'none').map(e => e.textContent.trim()));
    assert.deepEqual(visible, ['Web3 Wallet']);
});

const visibleNav = () => env.page.$$eval('.nav-item', els =>
    els.filter(e => e.style.display !== 'none').map(e => e.textContent.trim()));

test('search typed with the Korean 2-set layout on finds the Latin name', async () => {
    await env.goto('index.html');
    // b-a-s-e: no syllable forms, the IME leaves bare jamo
    await env.page.fill('#tool-search', 'ㅠㅁㄴㄷ');
    assert.deepEqual(await visibleNav(), ['Base64', 'Image to Base64']);
    // j-s-o-n: the IME joins s+o into 내
    await env.page.fill('#tool-search', 'ㅓ내ㅜ');
    assert.ok((await visibleNav()).includes('JSON Formatter'));
    // w-a-l-l-e-t: 미 + ㅣ + ㄷ + ㅅ
    await env.page.fill('#tool-search', 'ㅈ미ㅣㄷㅅ');
    assert.deepEqual(await visibleNav(), ['Web3 Wallet']);
    // d-i-f-f: a syllable with a final consonant is split back into its keys
    await env.page.fill('#tool-search', '얄ㄹ');
    assert.ok((await visibleNav()).some(n => n.startsWith('Diff')));
    // jamo mixed with keys typed in Latin mode
    await env.page.fill('#tool-search', 'ㅠㅁㄴㄷ64');
    assert.deepEqual(await visibleNav(), ['Base64', 'Image to Base64']);
});

test('each word matches on its own, as typed or as keys', async () => {
    await env.goto('index.html');
    await env.page.fill('#tool-search', 'json 래금ㅅ');        // json + f-o-r-m-a-t
    assert.deepEqual(await visibleNav(), ['JSON Formatter']);
    await env.page.fill('#tool-search', 'base 64');
    assert.deepEqual(await visibleNav(), ['Base64', 'Image to Base64']);
});

test('Korean words find tools by their Korean name, even in the English UI', async () => {
    await env.goto('index.html');
    await env.page.fill('#tool-search', 'ㅊㄴㅍ 뷰어');
    // the Korean dictionary is fetched on the first Hangul syllable, then the list refilters
    await env.page.waitForFunction(() => window.LOCALUTIL_I18N && window.LOCALUTIL_I18N.ko);
    await env.page.waitForFunction(() => document.querySelector('.nav-item[href="csv-view.html"]').style.display === '');
    assert.deepEqual(await visibleNav(), ['CSV Viewer']);
    // the page itself stays English
    assert.equal(await env.page.getAttribute('html', 'lang'), 'en');
});

test('jamo alone never fetches the Korean dictionary', async () => {
    await env.goto('index.html');
    await env.page.fill('#tool-search', 'ㅠㅁㄴㄷ');
    await env.page.waitForTimeout(200);
    assert.equal(await env.page.evaluate(() => !!document.querySelector('script[src="i18n/ko.js"]')), false);
});

test('in the Korean UI the English names still match', async () => {
    const page = await env.browser.newPage();
    await page.addInitScript(() => localStorage.setItem('localutil-lang', 'ko'));
    await page.goto(`${env.server.base}/index.html`, { waitUntil: 'networkidle' });
    await page.fill('#tool-search', 'ㅊㄴㅍ 뷰어');
    const shown = await page.$$eval('.nav-item', els =>
        els.filter(e => e.style.display !== 'none').map(e => e.getAttribute('href')));
    assert.deepEqual(shown, ['csv-view.html']);
    await page.fill('#tool-search', 'csv viewer');
    assert.deepEqual(await page.$$eval('.nav-item', els =>
        els.filter(e => e.style.display !== 'none').map(e => e.getAttribute('href'))), ['csv-view.html']);
    await page.close();
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
