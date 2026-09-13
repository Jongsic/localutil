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

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
