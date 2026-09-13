import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

// RFC 6238 test secret: ASCII "12345678901234567890" in Base32.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const code = () => env.page.$eval('#totp-code', e => e.textContent);

test('RFC 6238 SHA-1 vectors', async () => {
    await env.goto('totp.html');
    await env.page.clock.setFixedTime(59_000);
    await env.page.selectOption('#totp-digits', '8');
    await env.page.fill('#totp-secret', RFC_SECRET);
    await env.page.waitForFunction(() => document.getElementById('totp-code-raw').value !== '');
    assert.equal(await env.page.$eval('#totp-code-raw', e => e.value), '94287082');

    await env.page.clock.setFixedTime(1_111_111_109_000);
    await env.page.fill('#totp-secret', RFC_SECRET + ' '); // retrigger input
    await env.page.waitForFunction(() => document.getElementById('totp-code-raw').value === '07081804');
});

test('otpauth:// URI fills digits, period, and algorithm', async () => {
    await env.goto('totp.html');
    await env.page.fill('#totp-secret',
        'otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&digits=8&period=60&algorithm=SHA256');
    await env.page.waitForFunction(() => document.getElementById('totp-code-raw').value !== '');
    assert.equal(await env.page.$eval('#totp-digits', e => e.value), '8');
    assert.equal(await env.page.$eval('#totp-period', e => e.value), '60');
    assert.equal(await env.page.$eval('#totp-algo', e => e.value), 'SHA-256');
    assert.match(await env.page.$eval('#totp-code-raw', e => e.value), /^\d{8}$/);
    assert.match(await env.page.$eval('#totp-meta', e => e.textContent), /Example:alice/);
});

test('invalid secret shows an error', async () => {
    await env.goto('totp.html');
    await env.page.fill('#totp-secret', 'not!base32');
    assert.match(await code(), /Invalid Base32 character/);
});

// Build a QR PNG inside the page (with the same library qr-generator.html ships)
// and hand it to the paste handler as a synthetic clipboard image.
async function pasteQrImage(data) {
    await env.page.addScriptTag({ url: '/vendor/qr-code-styling.js' });
    await env.page.evaluate(async (data) => {
        const qr = new QRCodeStyling({
            width: 300, height: 300, type: 'canvas', data, margin: 8,
            dotsOptions: { color: '#000000', type: 'square' },
            backgroundOptions: { color: '#ffffff' },
        });
        const blob = await qr.getRawData('png');
        const dt = new DataTransfer();
        dt.items.add(new File([blob], 'qr.png', { type: 'image/png' }));
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }));
    }, data);
}

test('pasting a QR image extracts the otpauth URI and generates a code', async () => {
    await env.goto('totp.html');
    await pasteQrImage('otpauth://totp/LocalUtil:qa?secret=JBSWY3DPEHPK3PXP&digits=7&period=60&algorithm=SHA512');
    await env.page.waitForFunction(() => document.getElementById('totp-code-raw').value !== '');
    assert.match(await env.page.$eval('#totp-secret', e => e.value), /^otpauth:\/\/totp\/LocalUtil/);
    assert.equal(await env.page.$eval('#totp-digits', e => e.value), '7');
    assert.equal(await env.page.$eval('#totp-period', e => e.value), '60');
    assert.equal(await env.page.$eval('#totp-algo', e => e.value), 'SHA-512');
    assert.match(await env.page.$eval('#totp-code-raw', e => e.value), /^\d{7}$/);
});

test('pasting a QR image with a bare secret works too', async () => {
    await env.goto('totp.html');
    await pasteQrImage(RFC_SECRET);
    await env.page.waitForFunction(() => document.getElementById('totp-code-raw').value !== '');
    assert.equal(await env.page.$eval('#totp-secret', e => e.value), RFC_SECRET);
    assert.match(await env.page.$eval('#totp-code-raw', e => e.value), /^\d{6}$/);
});

test('pasting an image without a QR code reports it', async () => {
    await env.goto('totp.html');
    await env.page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 120;
        canvas.getContext('2d').fillRect(0, 0, 120, 120);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
        const dt = new DataTransfer();
        dt.items.add(new File([blob], 'blank.png', { type: 'image/png' }));
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }));
    });
    await env.page.waitForFunction(() =>
        document.getElementById('totp-code').textContent.includes('No QR code'));
});

test('pasting a Google Authenticator migration QR is rejected with a hint', async () => {
    await env.goto('totp.html');
    await pasteQrImage('otpauth-migration://offline?data=abc123');
    await env.page.waitForFunction(() =>
        document.getElementById('totp-code').textContent.includes('not supported'));
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
