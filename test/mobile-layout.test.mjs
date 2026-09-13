import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, listPages } from './helpers.mjs';

let env;
before(async () => {
    env = await startEnv({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
    });
});
after(async () => { await env.close(); });

test('no page overflows horizontally on a phone viewport', async () => {
    const problems = [];
    for (const file of await listPages()) {
        await env.goto(file);
        await env.page.waitForTimeout(150);
        const r = await env.page.evaluate(() => {
            const doc = document.documentElement;
            const tc = document.querySelector('.tools-container');
            return {
                doc: doc.scrollWidth - doc.clientWidth,
                container: tc ? tc.scrollWidth - tc.clientWidth : 0,
            };
        });
        if (r.doc > 1 || r.container > 1) problems.push(`${file}: doc=${r.doc}px container=${r.container}px`);
    }
    assert.deepEqual(problems, []);
});

test('body uses dvh so mobile browser chrome cannot cut off the bottom', async () => {
    await env.goto('index.html');
    // jsdom-free check: the stylesheet must declare the dvh height after the vh fallback.
    const ok = await env.page.evaluate(async () => {
        const css = await (await fetch('styles.css')).text();
        return /height:\s*100vh;\s*height:\s*100dvh;/.test(css.replace(/\/\*[\s\S]*?\*\//g, ''));
    });
    assert.ok(ok, 'styles.css should declare height:100vh; height:100dvh; on body');
});
