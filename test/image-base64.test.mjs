import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { startEnv } from './helpers.mjs';

// --- Minimal PNG writer, so the tests feed the page real image bytes ---
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
}

// 'noise' resists compression (big files), 'gradient' compresses away to nothing, and
// 'photo' sits in between — detailed enough that the JPEG quality knob moves real bytes.
// extra chunks are inserted before IDAT, which is where PNG metadata lives.
function makePng(w, h, kind, extra = []) {
    let seed = 0x2f6bff;
    const rows = Buffer.alloc((w * 4 + 1) * h);
    let p = 0;
    for (let y = 0; y < h; y++) {
        rows[p++] = 0;                       // filter: none
        for (let x = 0; x < w; x++) {
            if (kind === 'noise') {
                seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                rows[p++] = seed & 0xff;
                rows[p++] = (seed >> 8) & 0xff;
                rows[p++] = (seed >> 16) & 0xff;
            } else if (kind === 'photo') {
                rows[p++] = Math.floor(x / w * 200 + Math.sin(x * 0.7) * 20 + 20);
                rows[p++] = Math.floor(y / h * 200 + Math.cos(y * 0.9) * 20 + 20);
                rows[p++] = 90 + ((x * y) % 40);
            } else {
                rows[p++] = Math.floor(x / w * 255);
                rows[p++] = Math.floor(y / h * 255);
                rows[p++] = 128;
            }
            rows[p++] = 255;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;    // bit depth
    ihdr[9] = 6;    // colour type: RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        ...extra,
        chunk('IDAT', deflateSync(rows)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// A little-endian TIFF block whose IFD0 holds only a GPS IFD pointer (tag 0x8825) —
// the exact shape a camera writes when it stamps a photo with coordinates.
function tiffWithGps() {
    const b = Buffer.alloc(26);
    b.write('II', 0, 'ascii');
    b.writeUInt16LE(42, 2);
    b.writeUInt32LE(8, 4);        // IFD0 offset
    b.writeUInt16LE(1, 8);        // one entry
    b.writeUInt16LE(0x8825, 10);  // GPS IFD pointer
    b.writeUInt16LE(4, 12);       // type: LONG
    b.writeUInt32LE(1, 14);       // count
    b.writeUInt32LE(26, 18);      // value (offset to the GPS IFD; unread by the sniffer)
    b.writeUInt32LE(0, 22);       // no next IFD
    return b;
}

function jpegAppSegment(marker, payload) {
    const head = Buffer.alloc(4);
    head[0] = 0xff;
    head[1] = marker;
    head.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([head, payload]);
}

// Splice an EXIF APP1 segment carrying GPS in right after the JPEG's SOI marker.
function jpegWithGpsExif(jpegBytes) {
    const app1 = jpegAppSegment(0xe1, Buffer.concat([
        Buffer.from('Exif\0\0', 'latin1'),
        tiffWithGps(),
    ]));
    return Buffer.concat([jpegBytes.subarray(0, 2), app1, jpegBytes.subarray(2)]);
}

const SVG = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">\n'
    + '  <rect width="24" height="24" fill="#2f6bff"/>\n  <circle cx="12" cy="12" r="6" fill="#fff"/>\n</svg>\n';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

function pngFile(w, h, kind, name, extra) {
    return { name: name || 'sample.png', mimeType: 'image/png', buffer: makePng(w, h, kind, extra) };
}

async function open(files) {
    await env.goto('image-base64.html');
    if (files) await upload(files);
}

async function upload(files) {
    await env.page.setInputFiles('#ib-file-input', files);
    await env.page.waitForFunction(
        n => document.getElementById('ib-stat-src').textContent !== '—'
            && (n < 2 || document.querySelectorAll('.ib-strip-item').length === n),
        [].concat(files).length);
}

const snippets = () => env.page.$$eval('.ib-block-code', els => els.map(e => e.textContent));
// mirrors fmtBytes() on the page, so byte readouts are pinned to an exact string
const fmtBytes = n => n < 1024 ? n + ' B'
    : n < 1048576 ? (n / 1024).toFixed(1) + ' KB'
        : (n / 1048576).toFixed(2) + ' MB';
const notes = () => env.page.textContent('#ib-notes');

// ---------------------------------------------------------------- encoding

test('an image under the max box is encoded verbatim as a data URI', async () => {
    const file = pngFile(64, 64, 'gradient');
    await open(file);
    const uri = await env.page.inputValue('#ib-datauri');
    assert.match(uri, /^data:image\/png;base64,/);
    // No resize and no format change means the original file bytes are reused as-is.
    assert.equal(uri.slice('data:image/png;base64,'.length), file.buffer.toString('base64'));
    assert.equal(await env.page.getAttribute('#ib-preview', 'src'), uri);
    assert.match(await notes(), /original file bytes are used as-is/);
    assert.match(await env.page.textContent('#ib-stat-src'), /64 × 64 · PNG/);
});

test('a larger image is fitted into the max box before it is encoded', async () => {
    await open(pngFile(1024, 768, 'gradient'));
    await env.page.selectOption('#ib-limit', '0');        // judge the resize, not the cap
    await env.page.waitForFunction(() => document.getElementById('ib-stat-out').textContent.startsWith('512'));
    assert.match(await env.page.textContent('#ib-stat-out'), /^512 × 384 · PNG/);
    assert.match((await snippets())[0], /width="512" height="384"/);

    const before = (await env.page.inputValue('#ib-datauri')).length;
    await env.page.selectOption('#ib-maxdim', '256');
    await env.page.waitForFunction(() => document.getElementById('ib-stat-out').textContent.startsWith('256'));
    assert.ok((await env.page.inputValue('#ib-datauri')).length < before);
});

test('an image kept at its original size skips the resize entirely', async () => {
    await open(pngFile(1024, 768, 'gradient'));
    await env.page.selectOption('#ib-limit', '0');
    await env.page.selectOption('#ib-maxdim', 'original');
    await env.page.waitForFunction(() => document.getElementById('ib-stat-out').textContent.startsWith('1024'));
    assert.match(await env.page.textContent('#ib-stat-out'), /^1024 × 768 · PNG/);
});

test('JPEG re-encodes through the canvas, with quality and a flatten colour', async () => {
    await open(pngFile(400, 300, 'gradient'));
    await env.page.selectOption('#ib-format', 'image/jpeg');
    await env.page.waitForFunction(() => document.getElementById('ib-stat-out').textContent.includes('JPEG'));
    assert.equal(await env.page.isVisible('#ib-quality-row'), true);
    assert.equal(await env.page.isVisible('#ib-bg-row'), true);
    assert.match(await env.page.inputValue('#ib-datauri'), /^data:image\/jpeg;base64,/);
    assert.match(await notes(), /no alpha channel — transparent pixels were flattened onto #ffffff/);

    const high = (await env.page.inputValue('#ib-datauri')).length;
    await env.page.fill('#ib-quality', '20');
    await env.page.dispatchEvent('#ib-quality', 'input');
    await env.page.waitForFunction(len => document.getElementById('ib-datauri').value.length < len, high);
});

// ---------------------------------------------------------------- size cap

test('output over the size cap is withheld, and shrink-to-fit brings it under', async () => {
    await open(pngFile(512, 512, 'noise'));
    // 512×512 of noise cannot come anywhere near the default 100 KB cap.
    assert.equal(await env.page.isVisible('#ib-warn'), true);
    assert.equal(await env.page.inputValue('#ib-datauri'), '');
    assert.equal(await env.page.isDisabled('#ib-download-btn'), true);
    assert.deepEqual(await snippets(), ['—']);

    await env.page.click('#ib-shrink-btn');
    await env.page.waitForFunction(() => document.getElementById('ib-warn').classList.contains('hidden'));
    const uri = await env.page.inputValue('#ib-datauri');
    assert.ok(uri.length > 0 && uri.length <= 102400, `data URI is ${uri.length} chars`);
    assert.equal(await env.page.isDisabled('#ib-download-btn'), false);
    // A lossless PNG has no quality to give up, so the pixels had to go.
    assert.equal(await env.page.inputValue('#ib-maxdim'), 'custom');
});

test('shrink-to-fit spends quality before pixels on a lossy format', async () => {
    // 512x512 of this lands around 52 KB as JPEG at 85% and 22 KB at 40%, so a 25 KB
    // cap is reachable by lowering quality alone.
    await open(pngFile(512, 512, 'photo'));
    await env.page.selectOption('#ib-format', 'image/jpeg');
    await env.page.selectOption('#ib-limit', '25600');
    await env.page.waitForFunction(() => !document.getElementById('ib-warn').classList.contains('hidden'));

    await env.page.click('#ib-shrink-btn');
    await env.page.waitForFunction(() => document.getElementById('ib-warn').classList.contains('hidden'));
    const uri = await env.page.inputValue('#ib-datauri');
    assert.ok(uri.length <= 25600, `data URI is ${uri.length} chars`);
    // Full resolution kept; only the quality slider moved.
    assert.equal(await env.page.inputValue('#ib-maxdim'), '512');
    assert.match(await env.page.textContent('#ib-stat-out'), /^512 × 512 · JPEG/);
    assert.ok(parseInt(await env.page.inputValue('#ib-quality'), 10) < 85);
});

test('lifting the cap releases the same output unchanged', async () => {
    await open(pngFile(512, 512, 'noise'));
    assert.equal(await env.page.inputValue('#ib-datauri'), '');
    await env.page.click('#ib-uncap-btn');
    await env.page.waitForFunction(() => document.getElementById('ib-warn').classList.contains('hidden'));
    assert.equal(await env.page.inputValue('#ib-limit'), '0');
    assert.match(await env.page.inputValue('#ib-datauri'), /^data:image\/png;base64,/);
});

// ---------------------------------------------------------------- comparison

test('the format comparison sizes every candidate and switches on click', async () => {
    await open(pngFile(300, 300, 'gradient'));
    await env.page.selectOption('#ib-limit', '0');
    await env.page.waitForSelector('#ib-compare button');
    const labels = await env.page.$$eval('#ib-compare button', bs => bs.map(b => b.textContent));
    assert.deepEqual(labels.map(l => l.replace(/[\d.]+ [KM]?B$/, '').trim()), ['Original', 'PNG', 'JPEG', 'WebP']);
    labels.forEach(l => assert.match(l, /[\d.]+ [KM]?B$/));
    // Untouched bytes are what "Keep original" produces here, so that button is the active one.
    assert.equal(await env.page.$eval('#ib-compare button.selected', b => b.dataset.format), 'auto');

    await env.page.click('#ib-compare button[data-format="image/webp"]');
    await env.page.waitForFunction(() => document.getElementById('ib-stat-out').textContent.includes('WebP'));
    assert.equal(await env.page.inputValue('#ib-format'), 'image/webp');
});

// ---------------------------------------------------------------- metadata

test('EXIF with GPS in the original bytes is reported, and stripping removes it', async () => {
    // Chromium makes the JPEG; the EXIF segment is spliced in on this side.
    await open();
    const jpegB64 = await env.page.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = c.height = 48;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#2f6bff';
        ctx.fillRect(0, 0, 48, 48);
        return c.toDataURL('image/jpeg', 0.9).split(',')[1];
    });
    const withExif = jpegWithGpsExif(Buffer.from(jpegB64, 'base64'));
    await upload({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: withExif });

    assert.match(await notes(), /original bytes carry EXIF, including GPS coordinates/);
    assert.equal(await env.page.isVisible('#ib-strip-row'), true);
    const kept = await env.page.inputValue('#ib-datauri');
    assert.equal(kept.slice(kept.indexOf(',') + 1), withExif.toString('base64'));

    await env.page.check('#ib-strip-meta');
    await env.page.waitForFunction(() => /dropped all of it/.test(document.getElementById('ib-notes').textContent));
    const stripped = await env.page.inputValue('#ib-datauri');
    assert.notEqual(stripped, kept);
    assert.ok(!Buffer.from(stripped.slice(stripped.indexOf(',') + 1), 'base64').includes(Buffer.from('Exif')));
});

test('a PNG with no metadata never offers the strip option', async () => {
    await open(pngFile(64, 64, 'gradient'));
    assert.equal(await env.page.isVisible('#ib-strip-row'), false);
    assert.doesNotMatch(await notes(), /carry/);
});

test('PNG text chunks count as metadata too', async () => {
    const text = chunk('tEXt', Buffer.from('Software\0LocalUtil test', 'latin1'));
    await open(pngFile(64, 64, 'gradient', 'tagged.png', [text]));
    assert.match(await notes(), /original bytes carry text chunks/);
});

// ---------------------------------------------------------------- SVG

test('an SVG can be percent-encoded instead of Base64, and stays vector', async () => {
    await open({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(SVG) });
    await env.page.selectOption('#ib-format', 'svg-url');
    await env.page.waitForFunction(() => document.getElementById('ib-datauri').value.startsWith('data:image/svg+xml,'));

    const uri = await env.page.inputValue('#ib-datauri');
    assert.doesNotMatch(uri, /base64/);
    assert.match(uri, /%3Csvg/);            // the markup is escaped, not encoded
    assert.doesNotMatch(uri, /"/);          // double quotes swapped for single
    assert.match(await env.page.textContent('#ib-stat-out'), /SVG \(vector\)/);
    assert.match(await notes(), /Percent-encoding this SVG is \d+% smaller than Base64/);
    assert.match(await notes(), /switched to single quotes/);

    // It has to survive a round trip through the browser as a real image.
    const rendered = await env.page.evaluate(u => new Promise(res => {
        const i = new Image();
        i.onload = () => res(i.naturalWidth + 'x' + i.naturalHeight);
        i.onerror = () => res('failed');
        i.src = u;
    }), uri);
    assert.equal(rendered, '24x24');
});

test('the vector option is only offered for a vector source', async () => {
    await open(pngFile(64, 64, 'gradient'));
    assert.equal(await env.page.$eval('#ib-format option[value="svg-url"]', o => o.disabled), true);
    await open({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(SVG) });
    assert.equal(await env.page.$eval('#ib-format option[value="svg-url"]', o => o.disabled), false);
});

// ---------------------------------------------------------------- snippets

test('each usage tab renders the snippets it promises', async () => {
    await open(pngFile(64, 64, 'gradient'));
    const uri = await env.page.inputValue('#ib-datauri');

    let blocks = await snippets();
    assert.equal(blocks.length, 2);
    assert.match(blocks[0], /^<img src="data:image\/png;base64,\S+" width="64" height="64" alt="">$/);
    assert.match(blocks[1], /^<link rel="icon" href="data:image\/png;base64,/);

    await env.page.click('#ib-tabs button[data-tab="css"]');
    blocks = await snippets();
    assert.match(blocks[0], /background-image: url\("data:image\/png;base64,/);
    assert.match(blocks[0], /background-size: contain;/);
    assert.match(blocks[1], /--sample: url\("data:image\/png;base64,/);
    assert.match(blocks[1], /background-image: var\(--sample\);/);
    assert.equal(await env.page.isVisible('#ib-css-demo'), true);
    assert.match(
        await env.page.$eval('#ib-css-demo-box', el => el.style.backgroundImage),
        /^url\("data:image\/png;base64,/);

    await env.page.click('#ib-tabs button[data-tab="jsx"]');
    blocks = await snippets();
    assert.match(blocks[0], /width=\{64\} height=\{64\} alt="" \/>$/);
    assert.match(blocks[1], /^export const sample = "data:image\/png;base64,/);
    assert.equal(await env.page.isVisible('#ib-css-demo'), false);

    await env.page.click('#ib-tabs button[data-tab="md"]');
    assert.match((await snippets())[0], /^!\[alt text\]\(data:image\/png;base64,/);

    await env.page.click('#ib-tabs button[data-tab="raw"]');
    const payload = uri.slice(uri.indexOf(',') + 1);
    assert.deepEqual(await snippets(), [payload.slice(0, 40) + '…']);
});

test('the snippet abbreviates a long data URI but copies it in full', async () => {
    await open(pngFile(64, 64, 'gradient'));
    const uri = await env.page.inputValue('#ib-datauri');
    const shown = (await snippets())[0];
    assert.ok(shown.length < uri.length, 'the displayed snippet must be shorter than the data URI');
    assert.match(shown, /…/);
    assert.match(await env.page.textContent('#ib-blocks'), /Copy hands over the full [\d,]+ characters/);

    await env.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await env.page.click('.ib-block button[data-copy-idx="0"]');
    const copied = await env.page.evaluate(() => navigator.clipboard.readText());
    assert.equal(copied, `<img src="${uri}" width="64" height="64" alt="">`);
});

// ---------------------------------------------------------------- batch

test('several images share the options and export as one CSS and JSON map', async () => {
    await open([pngFile(64, 64, 'gradient', 'blue-logo.png'), pngFile(80, 40, 'gradient', '2nd icon.png')]);
    assert.equal(await env.page.isVisible('#ib-strip'), true);
    assert.equal((await env.page.$$('.ib-strip-item')).length, 2);
    // The most recently added image is the one on screen.
    assert.equal(await env.page.textContent('#ib-source-name'), '2nd icon.png');

    await env.page.click('#ib-tabs button[data-tab="batch"]');
    const [css, json] = await snippets();
    assert.match(css, /^\.blue-logo \{/);
    assert.match(css, /\.img-2nd-icon \{/);
    assert.match(css, /width: 80px;\n  height: 40px;/);
    assert.match(json, /"blue-logo": "data:image\/png;base64,/);
    assert.match(json, /"img-2nd-icon": "data:image\/png;base64,/);
    assert.match(await env.page.textContent('.ib-block-title'), /CSS — 2 of 2/);

    // Selecting the other thumbnail swaps what the single-image panes describe.
    await env.page.click('.ib-strip-item[data-idx="0"]');
    await env.page.waitForFunction(() => document.getElementById('ib-source-name').textContent === 'blue-logo.png');
    assert.match(await env.page.textContent('#ib-stat-out'), /^64 × 64/);

    // Removing one collapses the strip and retires the batch tab.
    await env.page.click('.ib-strip-item[data-idx="1"] [data-del]');
    await env.page.waitForFunction(() => document.querySelectorAll('.ib-strip-item').length === 0);
    assert.equal(await env.page.isVisible('#ib-strip'), false);
    assert.equal(await env.page.isVisible('#ib-tabs button[data-tab="batch"]'), false);
});

test('a batch calls out the images that blow the cap instead of dropping them silently', async () => {
    await open([pngFile(64, 64, 'gradient', 'small.png'), pngFile(512, 512, 'noise', 'huge.png')]);
    await env.page.click('#ib-tabs button[data-tab="batch"]');
    const [css, json] = await snippets();
    assert.match(css, /\/\* huge\.png skipped: [\d.]+ KB is over the cap \*\//);
    assert.match(css, /\.small \{/);
    assert.doesNotMatch(json, /huge/);
    assert.match(await env.page.textContent('.ib-block-title'), /CSS — 1 of 2/);
});

// ---------------------------------------------------------------- decode

async function decode(text) {
    await env.goto('image-base64.html');
    await env.page.click('#ib-mode button[data-mode="decode"]');
    await env.page.fill('#ib-decode-input', text);
    await env.page.waitForFunction(() =>
        !document.getElementById('ib-decode-preview-wrap').classList.contains('hidden')
        || !document.getElementById('ib-decode-error').classList.contains('hidden'));
}

test('a pasted data URI is decoded, described, and rendered', async () => {
    const png = makePng(48, 24, 'gradient');
    await decode('data:image/png;base64,' + png.toString('base64'));
    assert.equal(await env.page.isVisible('#ib-decode-error'), false);
    assert.match(await env.page.textContent('#ib-dstat-input'), /chars · data: URI, Base64$/);
    assert.match(await env.page.textContent('#ib-dstat-type'), /^PNG · image\/png$/);
    assert.equal(await env.page.textContent('#ib-dstat-dim'), '48 × 24 px');
    assert.equal(await env.page.textContent('#ib-dstat-size'), fmtBytes(png.length));
    assert.equal(await env.page.isDisabled('#ib-decode-download'), false);
});

test('bare Base64 is identified from its leading bytes', async () => {
    await decode(makePng(32, 32, 'gradient').toString('base64'));
    assert.match(await env.page.textContent('#ib-dstat-input'), /bare Base64$/);
    assert.match(await env.page.textContent('#ib-dstat-type'), /^PNG/);
    assert.match(await env.page.textContent('#ib-decode-notes'), /No data: prefix, so PNG was identified/);
});

test('a percent-encoded SVG data URI decodes without Base64', async () => {
    await decode('data:image/svg+xml,' + encodeURIComponent(SVG));
    assert.match(await env.page.textContent('#ib-dstat-input'), /percent-encoded$/);
    assert.match(await env.page.textContent('#ib-dstat-type'), /^SVG/);
    assert.match(await env.page.textContent('#ib-decode-notes'), /normal for inline SVG/);
});

test('decoding rejects what it cannot make an image out of', async () => {
    await decode('not a data uri and not base64 either!!');
    assert.match(await env.page.textContent('#ib-decode-error'), /neither a data: URI nor Base64/);

    await env.page.fill('#ib-decode-input', 'data:text/plain;base64,' + Buffer.from('hello').toString('base64'));
    await env.page.waitForFunction(() => /not an image/.test(document.getElementById('ib-decode-error').textContent));

    await env.page.fill('#ib-decode-input', 'data:image/png;base64,' + Buffer.from('definitely not a png').toString('base64'));
    await env.page.waitForFunction(() => /could not render an image/.test(document.getElementById('ib-decode-error').textContent));
});

test('a decoded image can be handed straight back to the encoder', async () => {
    const png = makePng(400, 400, 'gradient');
    await decode('data:image/png;base64,' + png.toString('base64'));
    await env.page.click('#ib-decode-toencode');
    await env.page.waitForFunction(() => document.getElementById('ib-stat-src').textContent !== '—');
    assert.equal(await env.page.isVisible('#ib-encode-view'), true);
    assert.match(await env.page.textContent('#ib-stat-src'), /^400 × 400 · PNG/);
    assert.match(await env.page.textContent('#ib-source-name'), /^decoded\.png$/);
});

test('the page raises no console or page errors', () => {
    assert.deepEqual(env.errors, []);
});
