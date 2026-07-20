import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startEnv } from './helpers.mjs';

const JKS = fileURLToPath(new URL('./fixtures/test.jks', import.meta.url));
const P12 = fileURLToPath(new URL('./fixtures/test.p12', import.meta.url));

// Reference SHA-256 fingerprints straight from `keytool -list`.
const JKS_UPLOAD_SHA256 = '92:29:64:1E:3C:5B:FA:74:C1:85:EB:5A:ED:6A:6E:9F:33:4E:8C:44:CC:93:9B:15:23:31:32:59:E9:32:70:7B';
const P12_KEY0_SHA256 = '7C:2A:40:A8:31:FA:FB:05:85:FF:01:AF:5E:6A:1A:F1:5F:BC:74:87:B0:12:AB:43:E5:5D:BE:7B:B4:B4:C9:8D';
const P12_ECKEY_SHA256 = '0C:28:5E:03:42:96:F9:B3:99:D3:17:AE:1C:2B:C0:AC:A7:BC:79:89:C4:D5:08:39:62:8D:29:C3:30:72:96:EC';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

async function inspect(file, password) {
    await env.goto('keystore.html');
    await env.page.setInputFiles('#ks-file-input', file);
    if (password !== undefined) await env.page.fill('#ks-password', password);
    await env.page.click('#btn-ks-inspect');
    await env.page.waitForSelector('#ks-results', { state: 'visible' });
    return env.page.$eval('#ks-results', e => e.innerText);
}

test('JKS: reads certificate without a password and shows SHA-256 fingerprint', async () => {
    const out = await inspect(JKS);
    assert.match(out, /JKS \(Java KeyStore\)/);
    assert.match(out, /upload/);
    assert.match(out, /PrivateKeyEntry|Private key entry/);
    assert.match(out, /RSA 2048 bit/);
    assert.ok(out.includes(JKS_UPLOAD_SHA256), 'SHA-256 fingerprint should match keytool');
});

test('PKCS12: reads both RSA and EC entries with the password', async () => {
    const out = await inspect(P12, 'android');
    assert.match(out, /PKCS#12/);
    assert.match(out, /key0/);
    assert.match(out, /eckey/);
    assert.match(out, /RSA 2048 bit/);
    assert.match(out, /EC — P-256/);
    assert.ok(out.includes(P12_KEY0_SHA256), 'RSA entry SHA-256 should match keytool');
    assert.ok(out.includes(P12_ECKEY_SHA256), 'EC entry SHA-256 should match keytool');
});

test('PKCS12: wrong password gives a clear error', async () => {
    await env.goto('keystore.html');
    await env.page.setInputFiles('#ks-file-input', P12);
    await env.page.fill('#ks-password', 'nope');
    await env.page.click('#btn-ks-inspect');
    await env.page.waitForSelector('#ks-error', { state: 'visible' });
    const err = await env.page.$eval('#ks-error', e => e.innerText);
    assert.match(err, /Wrong password/i);
});

test('PKCS12: prompts for a password when none is given', async () => {
    await env.goto('keystore.html');
    await env.page.setInputFiles('#ks-file-input', P12);
    await env.page.click('#btn-ks-inspect');
    await env.page.waitForSelector('#ks-error', { state: 'visible' });
    const err = await env.page.$eval('#ks-error', e => e.innerText);
    assert.match(err, /store password/i);
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
