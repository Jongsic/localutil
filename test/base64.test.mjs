import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startEnv } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => {
    assert.deepEqual(env.errors, []);
    await env.close();
});

const MB = 1048576;
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
// Bytes that are neither text nor a known format, so sniffing lands on "Binary data".
const binary = n => Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff));

async function drop(input, name, buffer, mimeType = 'application/octet-stream') {
    await env.goto('base64.html');
    await env.page.setInputFiles(input, { name, mimeType, buffer });
    await env.page.waitForFunction(() =>
        !document.getElementById('bf-result').classList.contains('hidden')
        || !document.getElementById('bf-error').classList.contains('hidden'));
}
const encode = (name, buf) => drop('#bf-enc-input', name, buf);
const decode = (name, text) => drop('#bf-dec-input', name, Buffer.from(text), 'text/plain');
const text = sel => env.page.textContent(sel);
const visible = sel => env.page.isVisible(sel);

async function downloaded(expectedName) {
    const [dl] = await Promise.all([env.page.waitForEvent('download'), env.page.click('#bf-download')]);
    assert.equal(dl.suggestedFilename(), expectedName);
    const chunks = [];
    for await (const c of await dl.createReadStream()) chunks.push(c);
    return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- encode

test('a dropped file is encoded, with the SHA-256 of the original bytes', async () => {
    const buf = binary(5000);
    await encode('blob.dat', buf);
    assert.equal(await env.page.inputValue('#bf-output'), buf.toString('base64'));
    assert.equal(await env.page.inputValue('#bf-sha256'), sha256(buf));
    assert.equal(await text('#bf-name'), 'blob.dat');
    assert.equal(await text('#bf-orig-size'), '5,000 B (4.9 KB)');
    assert.equal(await text('#bf-b64-size'), buf.toString('base64').length.toLocaleString('en-US') + ' B');
    assert.equal(await visible('#bf-type'), false);
    assert.equal((await downloaded('blob.dat.b64')).toString(), buf.toString('base64'));
});

test('encoding a file of exactly 1 MB works; one byte more is refused unread', async () => {
    const buf = binary(MB);
    await encode('max.bin', buf);
    assert.equal(await env.page.inputValue('#bf-output'), buf.toString('base64'));
    assert.equal(await env.page.inputValue('#bf-sha256'), sha256(buf));

    await encode('big.bin', binary(MB + 1));
    assert.equal(await visible('#bf-result'), false);
    assert.equal(await text('#bf-error-msg'), 'File is larger than 1 MB.');
    assert.equal(await text('#bf-error-detail'), 'big.bin: 1,048,577 B');
});

test('an empty file encodes to empty Base64', async () => {
    await encode('empty', Buffer.alloc(0));
    assert.equal(await env.page.inputValue('#bf-output'), '');
    assert.equal(await env.page.inputValue('#bf-sha256'), sha256(Buffer.alloc(0)));
});

// ---------------------------------------------------------------- decode

test('a Base64 file decodes back to the original, wrapped lines and BOM included', async () => {
    const buf = binary(3000);
    const wrapped = '﻿' + buf.toString('base64').replace(/.{76}/g, '$&\r\n') + '\n';
    await decode('blob.b64', wrapped);
    assert.equal(await env.page.inputValue('#bf-sha256'), sha256(buf));
    assert.equal(await text('#bf-orig-size'), '3,000 B (2.9 KB)');
    assert.equal(await text('#bf-type'), 'Binary data');
    assert.equal(await visible('#bf-output'), false);
    assert.equal(await visible('#bf-output-hint'), true);
    assert.deepEqual(await downloaded('blob.bin'), buf);
});

test('decoded UTF-8 text is shown, and the inner name is kept for the download', async () => {
    const body = 'hello, 세계\nline two\n';
    await decode('notes.txt.b64', Buffer.from(body).toString('base64'));
    assert.equal(await text('#bf-type'), 'UTF-8 text');
    assert.equal(await env.page.inputValue('#bf-output'), body);
    assert.equal(await env.page.inputValue('#bf-sha256'), sha256(Buffer.from(body)));
    assert.equal((await downloaded('notes.txt')).toString(), body);
});

test('known formats are recognised and named; URL-safe and unpadded input decodes too', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), binary(61)]);
    await decode('logo.txt', png.toString('base64url'));     // no padding, - and _
    assert.equal(await text('#bf-type'), 'PNG image');
    assert.equal(await env.page.inputValue('#bf-sha256'), sha256(png));
    assert.deepEqual(await downloaded('logo.png'), png);
});

test('decoding stops at the first character that is not Base64', async () => {
    await decode('mixed.txt', 'QUJD\nRE#GRkdI' + 'x'.repeat(100));
    assert.equal(await visible('#bf-result'), false);
    assert.equal(await text('#bf-error-msg'), 'Not Base64 — stopped at the first invalid character.');
    assert.equal(await text('#bf-error-detail'), "mixed.txt: line 2, col 3 (byte 7): '#' 0x23");
});

test('a binary file fails on its first bytes', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), binary(MB * 4)]);
    await drop('#bf-dec-input', 'photo.png', png, 'image/png');
    assert.equal(await text('#bf-error-detail'), 'photo.png: line 1, col 1 (byte 0): 0x89');
});

test('decoded data over 1 MB is refused', async () => {
    await decode('huge.b64', binary(MB + 3).toString('base64'));
    assert.equal(await text('#bf-error-msg'), 'Decoded data would be larger than 1 MB.');

    // exactly 1 MB still decodes
    const buf = binary(MB);
    await decode('max.b64', buf.toString('base64'));
    assert.equal(await env.page.inputValue('#bf-sha256'), sha256(buf));
});

test('broken padding and truncated data are reported', async () => {
    await decode('a.b64', 'QUJD=RA==');
    assert.equal(await text('#bf-error-msg'), 'Not Base64 — data continues after the = padding.');
    await decode('b.b64', 'QUJDR');
    assert.equal(await text('#bf-error-msg'), 'Not Base64 — the data is truncated (one character too many or too few).');
    await decode('c.b64', 'QUI===');
    assert.equal(await text('#bf-error-msg'), 'Not Base64 — too much padding.');
    await decode('d.b64', 'QUJ==');
    assert.equal(await text('#bf-error-msg'), 'Not Base64 — the = padding does not line up with the data.');
    await decode('e.b64', ' \n\n');
    assert.equal(await text('#bf-error-msg'), 'No Base64 data in this file.');
});

test('the text encoder above is untouched by the file tools', async () => {
    await env.goto('base64.html');
    await env.page.fill('#b64-input', 'héllo');
    await env.page.click('#btn-b64-encode');
    assert.equal(await env.page.inputValue('#b64-output'), Buffer.from('héllo').toString('base64'));
});
