import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

const activeVisible = () => env.page.evaluate(() => {
    const list = document.getElementById('tool-list');
    const active = list.querySelector('.nav-item.active');
    if (!active) return null;
    const a = active.getBoundingClientRect(), l = list.getBoundingClientRect();
    return a.top >= l.top - 1 && a.bottom <= l.bottom + 1;
});

test('the nav keeps its scroll position across a page load', async () => {
    await env.goto('index.html');
    const scrollable = await env.page.evaluate(() => {
        const list = document.getElementById('tool-list');
        return list.scrollHeight > list.clientHeight;
    });
    assert.ok(scrollable, 'nav must overflow for this test to mean anything');

    // Scroll to the bottom and open the last tool down there.
    const href = await env.page.evaluate(() => {
        const list = document.getElementById('tool-list');
        list.scrollTop = list.scrollHeight;
        const items = list.querySelectorAll('.nav-item');
        return items[items.length - 1].getAttribute('href');
    });
    await env.page.click(`.nav-item[href="${href}"]`);
    await env.page.waitForLoadState('networkidle');

    assert.equal(await env.page.evaluate(() => document.getElementById('tool-list').scrollTop > 0), true);
    assert.equal(await activeVisible(), true);
});

test('a deep link scrolls the active tool into view', async () => {
    const href = await env.page.evaluate(() => {
        const items = document.querySelectorAll('#tool-list .nav-item');
        return items[items.length - 1].getAttribute('href');
    });
    const ctx = await env.browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${env.server.base}/${href}`, { waitUntil: 'networkidle' });
    const visible = await page.evaluate(() => {
        const list = document.getElementById('tool-list');
        const active = list.querySelector('.nav-item.active');
        const a = active.getBoundingClientRect(), l = list.getBoundingClientRect();
        return a.top >= l.top - 1 && a.bottom <= l.bottom + 1;
    });
    assert.equal(visible, true);
    await ctx.close();
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
