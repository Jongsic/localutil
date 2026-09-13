import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startEnv } from './helpers.mjs';

const JKS = fileURLToPath(new URL('./fixtures/test.jks', import.meta.url));
const P12 = fileURLToPath(new URL('./fixtures/test.p12', import.meta.url));
const CRT = fileURLToPath(new URL('./fixtures/test.crt', import.meta.url));
const CSR = fileURLToPath(new URL('./fixtures/test.csr', import.meta.url));
const DER = fileURLToPath(new URL('./fixtures/test.der', import.meta.url));
const P7B = fileURLToPath(new URL('./fixtures/test.p7b', import.meta.url));
const KEY = fileURLToPath(new URL('./fixtures/test.key.pem', import.meta.url));

// Reference SHA-256 fingerprints straight from `keytool -list`.
const JKS_UPLOAD_SHA256 = '92:29:64:1E:3C:5B:FA:74:C1:85:EB:5A:ED:6A:6E:9F:33:4E:8C:44:CC:93:9B:15:23:31:32:59:E9:32:70:7B';
const P12_KEY0_SHA256 = '7C:2A:40:A8:31:FA:FB:05:85:FF:01:AF:5E:6A:1A:F1:5F:BC:74:87:B0:12:AB:43:E5:5D:BE:7B:B4:B4:C9:8D';
const P12_ECKEY_SHA256 = '0C:28:5E:03:42:96:F9:B3:99:D3:17:AE:1C:2B:C0:AC:A7:BC:79:89:C4:D5:08:39:62:8D:29:C3:30:72:96:EC';
// From `openssl x509 -in test.crt -noout -fingerprint -sha256`.
const CRT_SHA256 = '28:FE:B4:60:01:E4:48:89:18:5E:23:1C:86:B2:13:D2:89:AD:A5:A5:E2:03:1C:D4:3A:13:A2:8C:D0:A1:2B:ED';

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

// Certificate-family files auto-inspect on drop — no button click needed.
async function autoInspect(file) {
    await env.goto('keystore.html');
    await env.page.setInputFiles('#ks-file-input', file);
    await env.page.waitForSelector('#ks-results', { state: 'visible' });
    return env.page.$eval('#ks-results', e => e.innerText);
}

test('fingerprints are shown both with and without colons', async () => {
    const out = await autoInspect(CRT);
    assert.ok(out.includes(CRT_SHA256), 'colon-separated SHA-256 shown');
    assert.ok(out.includes(CRT_SHA256.replaceAll(':', '')), 'bare-hex SHA-256 shown');
});

test('PEM certificate (.crt): parses without a password, shows subject and SANs', async () => {
    const out = await autoInspect(CRT);
    assert.match(out, /PEM \(text\)/);
    assert.match(out, /CN=localutil\.test/);
    assert.match(out, /DNS:localutil\.test/);
    assert.match(out, /DNS:\*\.localutil\.test/);
    assert.match(out, /IP:127\.0\.0\.1/);
    assert.match(out, /RSA 2048 bit/);
});

test('CSR (.csr): parses without a password, shows subject and requested SANs', async () => {
    const out = await autoInspect(CSR);
    assert.match(out, /certificate request/i);
    assert.match(out, /PKCS#10/);
    assert.match(out, /CN=csr\.localutil\.test/);
    assert.match(out, /DNS:csr\.localutil\.test/);
});

test('DER certificate (.der): detected and parsed as a certificate, not PKCS#12', async () => {
    const out = await autoInspect(DER);
    assert.match(out, /DER \(binary\)/);
    assert.match(out, /CN=localutil\.test/);
    assert.ok(out.includes(CRT_SHA256), 'same fingerprint as the PEM form');
});

test('PKCS#7 bundle (.p7b): certificates are extracted', async () => {
    const out = await autoInspect(P7B);
    assert.match(out, /CN=localutil\.test/);
    assert.ok(out.includes(CRT_SHA256));
});

test('PEM private key: described without exposing the key', async () => {
    const out = await autoInspect(KEY);
    assert.match(out, /Private key/);
    assert.match(out, /PKCS#8/);
    assert.match(out, /RSA 2048 bit/);
});

test('JKS still auto-inspects on drop without a password', async () => {
    const out = await autoInspect(JKS);
    assert.match(out, /JKS \(Java KeyStore\)/);
    assert.ok(out.includes(JKS_UPLOAD_SHA256));
    assert.ok(out.includes(JKS_UPLOAD_SHA256.replaceAll(':', '')), 'bare-hex JKS fingerprint shown');
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
