import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env;
before(async () => { env = await startEnv({ acceptDownloads: true }); });
after(async () => { await env.close(); });

// Build a PDF inside the page with pdf-lib and hand it back as a Buffer, so
// the tests feed the tools real PDF bytes without fixtures on disk.
async function makePdf(kind) {
    const b64 = await env.page.evaluate(async kind => {
        const { PDFDocument, rgb, StandardFonts } = PDFLib;
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const canvasBytes = async (type, draw) => {
            const c = document.createElement('canvas');
            c.width = 40; c.height = 30;
            const ctx = c.getContext('2d');
            draw(ctx);
            const blob = await new Promise(r => c.toBlob(r, type, 0.95));
            return new Uint8Array(await blob.arrayBuffer());
        };
        const picture = ctx => {
            ctx.fillStyle = '#6be0ff'; ctx.fillRect(0, 0, 40, 30);
            ctx.fillStyle = '#e00000'; ctx.fillRect(14, 9, 12, 12);
        };
        if (kind === 'bluebg') {
            const page = doc.addPage([300, 200]);
            page.drawRectangle({ x: 0, y: 0, width: 300, height: 200, color: rgb(0.42, 0.88, 1) });
            page.drawText('Hello (1 0 0 rg) world', { x: 20, y: 160, size: 14, font, color: rgb(0, 0, 0) });
            const png = await doc.embedPng(await canvasBytes('image/png', picture));
            const jpg = await doc.embedJpg(await canvasBytes('image/jpeg', picture));
            page.drawImage(png, { x: 20, y: 20, width: 120, height: 90 });
            page.drawImage(jpg, { x: 160, y: 20, width: 120, height: 90 });
        } else if (kind === 'proof') {
            // one page on A4 with the real page centered inside, like a print-shop proof
            const page = doc.addPage([595.28, 841.89]);
            page.drawRectangle({ x: 100, y: 150, width: 395.28, height: 541.89, color: rgb(1, 0.8, 0) });
            page.drawText('COVER', { x: 250, y: 420, size: 24, font });
        } else if (kind === 'body') {
            // three pages with a MediaBox that does not start at 0,0
            for (let i = 0; i < 3; i++) {
                const page = doc.addPage([395.28, 541.89]);
                page.setMediaBox(40, 60, 395.28, 541.89);
                page.drawText('Page ' + (i + 2), { x: 80, y: 300, size: 24, font });
            }
        }
        const bytes = await doc.save();
        let s = '';
        for (const b of bytes) s += String.fromCharCode(b);
        return btoa(s);
    }, kind);
    return Buffer.from(b64, 'base64');
}

async function downloadBytes() {
    const page = env.page;
    await page.waitForSelector('#dl-btn:not([disabled])', { timeout: 60000 });
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dl-btn')]);
    const chunks = [];
    for await (const c of await dl.createReadStream()) chunks.push(c);
    return { name: dl.suggestedFilename(), bytes: Buffer.concat(chunks) };
}

test('planImposition: booklet, calendar booklet and cut-and-stack orders', async () => {
    await env.goto('pdf-imposition.html');
    const r = await env.page.evaluate(() => {
        const items = n => Array.from({ length: n }, () => ({ w: 400, h: 560 }));
        const wide = n => Array.from({ length: n }, () => ({ w: 560, h: 354 }));
        // cells read top-to-bottom, left-to-right as they sit on the sheet
        const show = plan => plan.sides.map(s => s.cells.slice()
            .sort((a, b) => (b.rect.y - a.rect.y) || (a.rect.x - b.rect.x))
            .map(c => (c.item == null ? '-' : c.item + 1) + (c.rot ? 'r' : '')).join(' '));
        return {
            side: show(PdfCore.planImposition(items(4), { mode: 'booklet', binding: 'side', duplex: 'long' })),
            sideShort: show(PdfCore.planImposition(items(4), { mode: 'booklet', binding: 'side', duplex: 'short' })),
            top: show(PdfCore.planImposition(wide(8), { mode: 'booklet', binding: 'top', duplex: 'long' })),
            cut: show(PdfCore.planImposition(wide(6), { mode: 'cut', binding: 'side', duplex: 'long' })),
            odd: PdfCore.planImposition(items(5), { mode: 'booklet' }),
            stackedCut: PdfCore.planImposition(wide(4), { mode: 'cut' }).stacked,
        };
    });
    // Portrait pages, side binding on a landscape sheet: long-edge duplex turns the back.
    assert.deepEqual(r.side, ['4 1', '3r 2r']);
    assert.deepEqual(r.sideShort, ['4 1', '2 3']);
    // Landscape pages bound at the top: the half that folds behind is upside down.
    assert.deepEqual(r.top, ['8r 1', '7r 2r', '6r 3', '5r 4r']);
    // Cut and stack: odd pages on the front, the next page right behind each.
    assert.deepEqual(r.cut, ['1 3', '2 4', '5 -', '6 -']);
    assert.equal(r.stackedCut, true);
    // 5 pages → 3 blanks inserted before the back cover.
    assert.equal(r.odd.blanks, 3);
    assert.deepEqual(r.odd.sides[0].cells.map(c => c.item), [4, 0]);
});

test('content scanner ignores color-like text inside strings and inline images', async () => {
    const found = await env.page.evaluate(() => {
        const src = '0.42 0.88 1 rg\n(1 0 0 rg) Tj\n[(2 0 0 rg)] TJ\nBI /W 1 /H 1 /BPC 8 /CS /RGB ID \x01\x02\x03 EI\n1 0 0 1 10 10 cm\n0 0 0 1 k\n/P0 scn\n0.5 g\n';
        const bytes = new TextEncoder().encode(src);
        const out = [];
        PdfCore.scanColorOps(bytes, c => out.push(c.op + ':' + c.values.join(',')));
        return out;
    });
    assert.deepEqual(found, ['rg:0.42,0.88,1', 'k:0,0,0,1', 'g:0.5']);
});

test('print layout: joins files, auto-crops the proof, writes landscape sheets', async () => {
    const page = env.page;
    await env.goto('pdf-imposition.html');
    const proof = await makePdf('proof');
    const body = await makePdf('body');
    await page.setInputFiles('[data-testid=pdf-input]', [
        { name: 'cover.pdf', mimeType: 'application/pdf', buffer: proof },
        { name: 'body.pdf', mimeType: 'application/pdf', buffer: body },
    ]);
    await page.waitForSelector('[data-testid=pdf-file] >> nth=1');
    assert.deepEqual(await page.$$eval('[data-testid=crop]', els => els.map(e => e.value)), ['size', 'none']);
    assert.match(await page.textContent('#im-summary'), /4 pages → 1 sheets/);
    // live preview of both sides before anything is made
    await page.waitForSelector('#preview canvas >> nth=1');
    assert.deepEqual(await page.$$eval('#preview figcaption', e => e.map(x => x.textContent)), ['Sheet 1 · front', 'Sheet 1 · back']);
    await page.click('#im-mode button[data-v=nup]');
    await page.waitForFunction(() => document.querySelector('#preview figcaption')?.textContent === 'Sheet 1');
    await page.click('#run-btn');
    const { name, bytes } = await downloadBytes();
    assert.equal(name, 'cover_print.pdf');
    const info = await page.evaluate(async b64 => {
        const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const doc = await PDFLib.PDFDocument.load(raw);
        return doc.getPages().map(p => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
    }, bytes.toString('base64'));
    assert.deepEqual(info, [[842, 595], [842, 595]]);
    await page.waitForSelector('#preview canvas >> nth=1');
    assert.deepEqual(env.errors, []);
});

async function clickDownload(selector) {
    const page = env.page;
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click(selector)]);
    const chunks = [];
    for await (const c of await dl.createReadStream()) chunks.push(c);
    return { name: dl.suggestedFilename(), bytes: Buffer.concat(chunks) };
}

// Background fills (hex list) and, per picture, a corner and a center pixel.
async function inspect(bytes) {
    return env.page.evaluate(async b64 => {
        const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const doc = await PdfCore.loadPdf(raw);
        const fills = PdfCore.scanFillColors(doc).map(c => c.hex);
        const pics = [];
        for (const info of PdfCore.listImages(doc)) {
            const img = await PdfCore.decodeImage(doc, info);
            const px = (x, y) => Array.from(img.data.slice((y * img.w + x) * 4, (y * img.w + x) * 4 + 3));
            pics.push({ w: img.w, h: img.h, corner: px(1, 1), center: px(img.w >> 1, img.h >> 1) });
        }
        return { fills, pics };
    }, bytes.toString('base64'));
}

test('background color: lists the page fill and every picture, repaints the ticked ones', async () => {
    const page = env.page;
    await env.goto('pdf-recolor.html');
    await page.setInputFiles('[data-testid=pdf-input]', { name: 'blue.pdf', mimeType: 'application/pdf', buffer: await makePdf('bluebg') });
    await page.waitForSelector('[data-testid=pic] >> nth=1');
    // the full-page fill is listed and ticked
    const vec = await page.$$eval('[data-testid=vec-row]', e => e.map(x => [x.querySelector('code').textContent, x.querySelector('input').checked]));
    assert.deepEqual(vec[0], ['#6BE0FF', true]);
    // the ticked page color is shared with every picture
    assert.match(await page.textContent('#glob-colors'), /#6BE0FF/);
    await page.waitForFunction(() => [...document.querySelectorAll('.pdf-pic-status')].every(s => /1 colors/.test(s.textContent)));
    const { name, bytes } = await clickDownload('#make-btn');
    assert.equal(name, 'blue_recolored.pdf');
    const r = await inspect(bytes);
    assert.ok(r.fills.includes('#FFFFFF') && !r.fills.includes('#6BE0FF'));
    assert.equal(r.pics.length, 2);
    for (const p of r.pics) {
        assert.ok(Math.min(...p.corner) > 240, 'background repainted: ' + p.corner);
        assert.ok(p.center[0] > 180 && p.center[1] < 80 && p.center[2] < 80, 'red square kept: ' + p.center);
    }
    assert.deepEqual(env.errors, []);
});

test('background color: clicking a picture adds a color; chips can be removed and added again', async () => {
    const page = env.page;
    await env.goto('pdf-recolor.html');
    await page.setInputFiles('[data-testid=pdf-input]', { name: 'blue.pdf', mimeType: 'application/pdf', buffer: await makePdf('bluebg') });
    await page.waitForSelector('[data-testid=glob-chip]');
    await page.click('[data-testid=glob-chip] >> nth=0 >> button');          // remove the page color
    assert.equal(await page.$$eval('[data-testid=glob-chip]', e => e.length), 0);
    await page.waitForFunction(() => document.querySelector('[data-testid=pic] canvas').width > 1);
    await page.click('[data-testid=pic] >> nth=0 >> canvas >> nth=0', { position: { x: 3, y: 3 } });   // corner = background
    const chips = await page.$$eval('[data-testid=glob-chip] span', e => e.map(x => x.textContent));
    assert.equal(chips.length, 1);
    assert.match(chips[0], /^#6[A-F0-9]E[0-9A-F]F[EF]$/);
    await page.click('#glob-add');
    assert.equal(await page.$$eval('[data-testid=glob-chip]', e => e.length), 2);
    assert.deepEqual(env.errors, []);
});

test('background color: an unticked picture is left alone', async () => {
    const page = env.page;
    await env.goto('pdf-recolor.html');
    await page.setInputFiles('[data-testid=pdf-input]', { name: 'blue.pdf', mimeType: 'application/pdf', buffer: await makePdf('bluebg') });
    await page.waitForSelector('[data-testid=pic] >> nth=1');
    await page.uncheck('[data-testid=pic] >> nth=1 >> [data-testid=pic-enable]');
    const { bytes } = await clickDownload('#make-btn');
    const r = await inspect(bytes);
    const changed = r.pics.filter(p => Math.min(...p.corner) > 240).length;
    const kept = r.pics.filter(p => p.corner[2] > 200 && p.corner[0] < 160).length;
    assert.equal(changed, 1);
    assert.equal(kept, 1);
    assert.deepEqual(env.errors, []);
});

test('upscaler page: upscales only the ticked picture and puts it in the PDF', { timeout: 120000 }, async () => {
    const page = env.page;
    await env.goto('pdf-upscale.html');
    await page.waitForSelector('[data-testid=model]');
    await page.selectOption('#up-backend', 'wasm');
    await page.setInputFiles('[data-testid=pdf-input]', { name: 'blue.pdf', mimeType: 'application/pdf', buffer: await makePdf('bluebg') });
    await page.waitForSelector('[data-testid=pic] >> nth=1');
    await page.click('text=Select none');
    await page.check('[data-testid=pic] >> nth=0 >> [data-testid=pic-enable]');
    await page.click('#up-run');
    await page.waitForFunction(() => /160×120/.test(document.querySelector('[data-testid=pic] .pdf-pic-status').textContent), null, { timeout: 90000 });
    assert.match(await page.textContent('[data-testid=pic] >> nth=1 >> .pdf-pic-status'), /Not upscaled yet/);
    // clicking the upscaled picture opens it at actual size, flipping before/after
    await page.click('[data-testid=pic] >> nth=0 >> canvas >> nth=1');
    await page.waitForSelector('#compare:not(.hidden)');
    assert.deepEqual(await page.$eval('#cmp-canvas', c => [c.width, c.height]), [160, 120]);
    const first = await page.textContent('[data-testid=cmp-state]');
    await page.waitForFunction(f => document.querySelector('[data-testid=cmp-state]').textContent !== f, first, { timeout: 3000 });
    await page.keyboard.press('Escape');
    await page.waitForSelector('#compare.hidden', { state: 'attached' });
    const { name, bytes } = await clickDownload('#make-btn');
    assert.equal(name, 'blue_upscaled.pdf');
    const r = await inspect(bytes);
    assert.deepEqual(r.pics.map(p => p.w).sort((a, b) => a - b), [40, 160]);
    assert.deepEqual(env.errors, []);
});

test('upscaler: safety check replaces a region the model changed', async () => {
    await env.goto('pdf-upscale.html');
    const r = await env.page.evaluate(() => {
        const mk = (w, h, f) => {
            const data = new Uint8ClampedArray(w * h * 4);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                const v = f(x, y), i = (y * w + x) * 4;
                data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
            }
            return { w, h, data };
        };
        const orig = mk(16, 16, (x, y) => ((x + y) % 2 ? 0 : 255));   // dense checker
        const big = mk(64, 64, () => 128);                           // "smoothed away"
        const fallback = mk(64, 64, (x, y) => ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 0 : 255));
        const changed = PdfCore.mismatchBlend(orig, big, fallback, 4);
        const same = PdfCore.mismatchBlend(orig, mk(64, 64, (x, y) => ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 0 : 255)), fallback, 4);
        return { changed, same, center: big.data[(32 * 64 + 32) * 4] };
    });
    assert.equal(r.changed, true);
    assert.equal(r.same, false);
    assert.notEqual(r.center, 128);
});

test('upscaler: the default model runs on the CPU backend', { timeout: 120000 }, async () => {
    await env.goto('pdf-upscale.html');
    await env.page.waitForSelector('[data-testid=model]');
    const r = await env.page.evaluate(async () => {
        const models = await (await fetch('models/models.json')).json();
        const m = models.find(x => x.default);
        const bytes = await PdfCore.fetchModel('models/' + m.file);
        const up = await PdfCore.createUpscaler(bytes, { backend: 'wasm', scale: m.scale, tile: 16 });
        const w = 20, h = 12, data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) { data[i * 4] = i % 7 * 30; data[i * 4 + 1] = 120; data[i * 4 + 2] = 200; data[i * 4 + 3] = 255; }
        const { img, scale } = await up.upscale({ w, h, data });
        up.release();
        let sum = 0;
        for (let i = 0; i < img.data.length; i += 4) sum += img.data[i + 2];
        return { id: m.id, scale, w: img.w, h: img.h, blue: sum / (img.w * img.h), backend: up.backend };
    });
    assert.equal(r.scale, 4);
    assert.equal(r.w, 80);
    assert.equal(r.h, 48);
    assert.equal(r.backend, 'wasm');
    assert.ok(r.blue > 150 && r.blue < 250, 'output keeps the input color, got ' + r.blue);
    assert.deepEqual(env.errors, []);
});

test('model list: every entry has a file, a size and a license', async () => {
    await env.goto('pdf-upscale.html');
    const models = await env.page.evaluate(async () => (await fetch('models/models.json')).json());
    assert.ok(models.length >= 3);
    assert.equal(models.filter(m => m.default).length, 1);
    for (const m of models) {
        const res = await env.page.evaluate(async f => (await fetch('models/' + f)).status, m.file);
        assert.equal(res, 200, m.file);
        assert.ok(m.sizeBytes > 0 && m.sizeBytes < 12 * 1024 * 1024, m.id + ' stays small');
        assert.match(m.license, /^(CC-BY-4\.0|BSD-3-Clause|Apache-2\.0|MIT|CC0-1\.0)$/);
    }
});
