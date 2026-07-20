import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startEnv, PUBLIC_DIR } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

test('public/LICENSE.txt mirrors the root LICENSE', async () => {
    const root = await readFile(join(PUBLIC_DIR, '..', 'LICENSE'), 'utf8');
    const served = await readFile(join(PUBLIC_DIR, 'LICENSE.txt'), 'utf8');
    assert.equal(served, root, 'run: cp LICENSE public/LICENSE.txt');
    assert.match(root, /MIT License/);
    assert.match(root, /WITHOUT WARRANTY OF ANY KIND/);
});

test('sidebar shows the license notice on every page shell', async () => {
    await env.goto('calldata.html');
    const footer = await env.page.$eval('.sidebar-footer', e => e.textContent);
    assert.match(footer, /MIT License/);
    assert.match(footer, /no warranty/);
    assert.equal(
        await env.page.$eval('.sidebar-footer a', e => e.getAttribute('href')),
        'LICENSE.txt',
    );
});

test('landing page carries the full disclaimer', async () => {
    await env.goto('index.html');
    const footer = await env.page.$eval('.landing-footer', e => e.textContent);
    assert.match(footer, /MIT License/);
    assert.match(footer, /no liability/);
});
