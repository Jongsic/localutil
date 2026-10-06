import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startEnv } from './helpers.mjs';

let env;
before(async () => {
    env = await startEnv({ acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
    await env.goto('paste-board.html');
});
after(async () => {
    assert.deepEqual(env.errors, []);
    await env.close();
});

// Fires a real paste event at the page, carrying a PNG drawn in the page (w × h) and/or text.
function paste({ png, text } = {}) {
    return env.page.evaluate(async ({ png, text }) => {
        const dt = new DataTransfer();
        if (png) {
            const c = document.createElement('canvas');
            c.width = png[0];
            c.height = png[1];
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#2f6bff';
            ctx.fillRect(0, 0, c.width / 2, c.height);
            const blob = await new Promise(r => c.toBlob(r, 'image/png'));
            dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
        }
        if (text) dt.setData('text/plain', text);
        document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, { png, text });
}

const rows = () => env.page.$$eval('#pb-list .pb-item', els => els.map(el => ({
    kind: el.dataset.kind,
    name: el.querySelector('.pb-name').textContent,
    detail: el.querySelector('.pb-detail').textContent,
})));

test('pasted images and text stack newest first', async () => {
    assert.equal(await env.page.isVisible('#pb-empty'), true);
    await paste({ png: [1600, 900] });
    await paste({ text: 'hello\nworld' });
    await env.page.waitForFunction(() => /1600 × 900/.test(document.querySelector('[data-kind="image"] .pb-detail').textContent));

    const list = await rows();
    assert.equal(list.length, 2);
    assert.equal(list[0].kind, 'text');
    assert.match(list[0].detail, /^11 chars · 2 lines/);
    assert.equal(list[1].kind, 'image');
    assert.match(list[1].name, /^paste-\d{8}-\d{6}-1\.png$/);
    assert.equal(await env.page.textContent('#pb-count'), '1 image · 1 text');
    assert.equal(await env.page.isVisible('#pb-empty'), false);
});

test('an image copied with its HTML keeps only the image', async () => {
    await paste({ png: [10, 10], text: '<img src="x">' });
    const list = await rows();
    assert.equal(list.length, 3);
    assert.equal(list[0].kind, 'image');
});

test('pasting into the tool search stays a normal paste', async () => {
    await env.page.focus('.search-container input');
    await env.page.evaluate(() => {
        const dt = new DataTransfer();
        dt.setData('text/plain', 'jwt');
        document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    assert.equal((await rows()).length, 3);
});

test('the viewer shows an image at its original pixel size, and can fit it', async () => {
    const img = '#pb-list [data-kind="image"]:last-child .pb-thumb';
    await env.page.click(img);
    await env.page.waitForSelector('#pb-viewer.show');
    await env.page.waitForFunction(() => document.querySelector('#pb-viewer-stage img').style.width === '1600px');
    const size = () => env.page.$eval('#pb-viewer-stage img', i => [i.clientWidth, i.clientHeight]);
    assert.deepEqual(await size(), [1600, 900]);

    await env.page.click('#pb-viewer-zoom');
    const [w] = await size();
    assert.ok(w < 1600, 'fitted into a narrower viewport');

    await env.page.keyboard.press('Escape');
    assert.equal(await env.page.isVisible('#pb-viewer'), false);
});

test('text opens in full in the viewer', async () => {
    await env.page.click('#pb-list [data-kind="text"] .pb-thumb');
    assert.equal(await env.page.textContent('#pb-viewer-stage pre'), 'hello\nworld');
    assert.equal(await env.page.isVisible('#pb-viewer-zoom'), false);
    await env.page.click('#pb-viewer-close');
    assert.equal(await env.page.isVisible('#pb-viewer'), false);
});

test('download saves the original bytes under the item name', async () => {
    const [dl] = await Promise.all([
        env.page.waitForEvent('download'),
        env.page.click('#pb-list [data-kind="text"] [data-action="download"]'),
    ]);
    assert.match(dl.suggestedFilename(), /^paste-\d{8}-\d{6}-2\.txt$/);
    assert.equal(await readFile(await dl.path(), 'utf8'), 'hello\nworld');

    const [img] = await Promise.all([
        env.page.waitForEvent('download'),
        env.page.click('#pb-list [data-kind="image"]:last-child [data-action="download"]'),
    ]);
    assert.match(img.suggestedFilename(), /-1\.png$/);
    const bytes = await readFile(await img.path());
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    assert.equal(bytes.readUInt32BE(16), 1600);
});

test('copy puts text and images back on the clipboard', async () => {
    await env.page.click('#pb-list [data-kind="text"] [data-action="copy"]');
    assert.equal(await env.page.evaluate(() => navigator.clipboard.readText()), 'hello\nworld');

    await env.page.click('#pb-list [data-kind="image"]:last-child [data-action="copy"]');
    await env.page.waitForFunction(async () => {
        const [entry] = await navigator.clipboard.read();
        return entry.types.includes('image/png');
    });
});

test('delete removes one item; clear all empties the list', async () => {
    await env.page.click('#pb-list [data-kind="text"] [data-action="delete"]');
    const list = await rows();
    assert.equal(list.length, 2);
    assert.ok(list.every(r => r.kind === 'image'));
    assert.equal(await env.page.textContent('#pb-count'), '2 images · 0 texts');

    await env.page.click('#pb-clear');
    assert.equal((await rows()).length, 0);
    assert.equal(await env.page.isVisible('#pb-empty'), true);
    assert.equal(await env.page.isDisabled('#pb-clear'), true);
});
