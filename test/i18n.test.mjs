import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

async function gotoWithLang(page, url, lang) {
    await page.addInitScript(l => localStorage.setItem('localutil-lang', l), lang);
    await page.goto(url, { waitUntil: 'networkidle' });
}

test('default stays English and shows the language selector', async () => {
    await env.page.goto(`${env.server.base}/epoch.html`, { waitUntil: 'networkidle' });
    assert.equal(await env.page.getAttribute('html', 'lang'), 'en');
    assert.equal(await env.page.textContent('.card-title'), 'Right now');
    assert.equal(await env.page.inputValue('#lang-select'), 'en');
});

test('saved Korean translates static markup, chrome and attributes', async () => {
    const page = await env.browser.newPage();
    await gotoWithLang(page, `${env.server.base}/epoch.html`, 'ko');
    assert.equal(await page.getAttribute('html', 'lang'), 'ko');

    // The dictionary itself is the expectation source — the page must show
    // exactly what i18n/ko.js maps these keys to.
    const dict = await page.evaluate(() => window.LOCALUTIL_I18N.ko);
    assert.ok(dict && Object.keys(dict).length > 100, 'ko dictionary loaded');
    assert.ok(dict['Right now'], 'ko dictionary covers page strings');

    assert.equal(await page.textContent('.card-title'), dict['Right now']);
    // sidebar chrome (category title) and topbar h1 come from app.js-rendered text
    assert.equal(await page.textContent('#current-tool-title'), dict['Epoch Converter']);
    assert.equal(
        await page.textContent('.nav-group[data-group="Utilities"] .nav-group-title'),
        dict['Utilities']);
    // attribute translation
    const ph = await page.getAttribute('#ts-sec-input', 'placeholder');
    assert.equal(ph, dict['e.g. 1672531200']);
    await page.close();
});

test('MutationObserver translates strings rendered after load', async () => {
    const page = await env.browser.newPage();
    await gotoWithLang(page, `${env.server.base}/epoch.html`, 'ko');
    const dict = await page.evaluate(() => window.LOCALUTIL_I18N.ko);

    // Typing then clearing makes the page re-set the hint via innerHTML —
    // only the observer can translate that.
    await page.fill('#ts-sec-input', '1672531200');
    await page.fill('#ts-sec-input', '');
    const key = 'Enter a timestamp in seconds...';
    assert.ok(dict[key], 'dictionary covers the dynamic hint');
    await page.waitForFunction(
        expected => document.querySelector('#ts-sec-result').textContent.trim() === expected,
        dict[key]);
    await page.close();
});

test('user content in outputs is not rewritten', async () => {
    const page = await env.browser.newPage();
    await gotoWithLang(page, `${env.server.base}/base64.html`, 'ko');
    // textarea values are user data — never translated even if they equal a key
    await page.fill('#b64-input', 'Right now');
    assert.equal(await page.inputValue('#b64-input'), 'Right now');
    await page.close();
});

test('changing the selector persists and reloads into that language', async () => {
    const page = await env.browser.newPage();
    await page.goto(`${env.server.base}/epoch.html`, { waitUntil: 'networkidle' });
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }),
        page.selectOption('#lang-select', 'ko'),
    ]);
    assert.equal(await page.getAttribute('html', 'lang'), 'ko');
    assert.equal(await page.evaluate(() => localStorage.getItem('localutil-lang')), 'ko');
    await page.close();
});
