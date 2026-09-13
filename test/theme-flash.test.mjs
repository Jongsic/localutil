import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startEnv, listPages, PUBLIC_DIR } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

test('every styled page loads theme-init.js before the stylesheet', async () => {
    const problems = [];
    for (const file of await listPages()) {
        const html = await readFile(join(PUBLIC_DIR, file), 'utf8');
        const cssAt = html.indexOf('href="styles.css"');
        if (cssAt === -1) continue; // redirect-only pages have nothing to flash
        const initAt = html.indexOf('src="theme-init.js"');
        if (initAt === -1 || initAt > cssAt) problems.push(file);
    }
    assert.deepEqual(problems, [], 'theme-init.js must come before styles.css to prevent a theme flash');
});

test('saved light theme applies before paint, without app.js', async () => {
    // Block app.js so only the pre-paint theme-init script can set the theme.
    await env.page.route('**/app.js', route => route.abort());
    await env.page.addInitScript(() => localStorage.setItem('localutil-theme', 'light'));
    await env.page.goto(`${env.server.base}/index.html`, { waitUntil: 'domcontentloaded' });
    assert.equal(
        await env.page.evaluate(() => document.documentElement.getAttribute('data-theme')),
        'light',
    );
    await env.page.unroute('**/app.js');
});
