// keypair.html — key generation (RSA / EC / Ed25519 / secret), inspection of
// PEM / JWK / JWKS / raw secrets, and PEM / DER / JWK downloads.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env, page;
before(async () => {
    env = await startEnv();
    page = env.page;
    await env.goto('keypair.html');
});
after(async () => { await env.close(); });

const rows = () => page.$$eval('#kp-report .kp-row', els => Object.fromEntries(els.map(e => [
    e.querySelector('.kp-row-key').textContent,
    e.querySelector('.kp-row-val').textContent,
])));
const waitGenerated = () => page.waitForFunction(
    () => document.getElementById('kp-gen-status').classList.contains('ok'));
const waitReport = () => page.waitForFunction(
    () => document.querySelectorAll('#kp-report .kp-row').length > 0);

test('generates an EC P-256 pair, shows PEMs, and the inspector reports its properties', async () => {
    await page.selectOption('#kp-type', 'ec');
    await page.selectOption('#kp-param', 'P-256');
    await page.click('#btn-kp-generate');
    await waitGenerated();

    assert.match(await page.inputValue('#kp-priv'), /^-----BEGIN PRIVATE KEY-----\n[\s\S]+-----END PRIVATE KEY-----$/);
    assert.match(await page.inputValue('#kp-pub'), /^-----BEGIN PUBLIC KEY-----\n[\s\S]+-----END PUBLIC KEY-----$/);

    await waitReport();
    const r = await rows();
    assert.match(r['What it is'], /Private key · PKCS#8 PEM/);
    assert.equal(r['Algorithm'], 'EC (P-256)');
    assert.equal(r['Curve'], 'P-256');
    assert.equal(r['Key size'], '256 bits');
    assert.match(r['Usable as (JOSE)'], /ES256/);
    assert.match(r['SHA-256 fingerprint (SPKI)'], /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.match(r['JWK thumbprint (RFC 7638)'], /^[\w-]{43}$/);
});

test('inspecting the generated public key identifies it as public', async () => {
    const pub = await page.inputValue('#kp-pub');
    await page.fill('#kp-inspect', pub);
    await page.click('#btn-kp-analyze');
    await waitReport();
    const r = await rows();
    assert.match(r['What it is'], /Public key · SPKI PEM/);
    assert.equal(r['Curve'], 'P-256');
});

test('RSA-2048 reports modulus size and exponent, and downloads all formats', async () => {
    await page.selectOption('#kp-type', 'rsa');
    await page.selectOption('#kp-param', '2048');
    await page.click('#btn-kp-generate');
    await waitGenerated();
    await waitReport();
    const r = await rows();
    assert.equal(r['Algorithm'], 'RSA');
    assert.equal(r['Key size'], '2048 bits');
    assert.match(r['Public exponent'], /^65537/);
    assert.match(r['Usable as (JOSE)'], /RS256.*PS256.*RSA-OAEP/);

    // one download of each format, from the generated-key buttons
    for (const [sel, name] of [
        ['#kp-priv-dl button[data-fmt="pem"]', 'rsa-2048-private.pem'],
        ['#kp-priv-dl button[data-fmt="der"]', 'rsa-2048-private.der'],
        ['#kp-pub-dl button[data-fmt="jwk"]', 'rsa-2048-public.jwk.json'],
    ]) {
        const [dl] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
        assert.equal(dl.suggestedFilename(), name);
    }
});

test('a private JWK imports, and a JWKS renders one section per key', async () => {
    const jwks = await page.evaluate(async () => {
        const ec = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify']);
        const priv = await crypto.subtle.exportKey('jwk', ec.privateKey);
        const pub = await crypto.subtle.exportKey('jwk', ec.publicKey);
        return { priv: JSON.stringify(priv), jwks: JSON.stringify({ keys: [pub, { kty: 'oct', k: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', kid: 'sym1' }] }) };
    });
    await page.fill('#kp-inspect', jwks.priv);
    await page.click('#btn-kp-analyze');
    await waitReport();
    let r = await rows();
    assert.match(r['What it is'], /Private key · JWK/);
    assert.equal(r['Curve'], 'P-384');

    await page.fill('#kp-inspect', jwks.jwks);
    await page.click('#btn-kp-analyze');
    await page.waitForFunction(() => document.querySelectorAll('#kp-report .kp-heading').length === 2);
    const headings = await page.$$eval('#kp-report .kp-heading', els => els.map(e => e.textContent));
    assert.match(headings[0], /Key 1 \/ 2/);
    assert.match(headings[1], /kid: sym1/);
});

test('raw secrets and short keys: byte length, HS suitability, weak-key warning', async () => {
    await page.fill('#kp-inspect', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90');
    await page.click('#btn-kp-analyze');
    await waitReport();
    let r = await rows();
    assert.match(r['What it is'], /32 bytes/);
    assert.equal(r['Key size'], '256 bits');
    assert.match(r['Usable as (JOSE)'], /HS256/);
    assert.equal(r['Warning'], undefined);

    await page.fill('#kp-inspect', 'deadbeef');
    await page.click('#btn-kp-analyze');
    await waitReport();
    r = await rows();
    assert.match(r['Warning'], /RFC 7518/);
});

test('unsupported inputs get a specific explanation, not a generic failure', async () => {
    const cases = [
        ['-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----', /PKCS#1\/SEC1/],
        ['-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----', /Keystore Inspector/],
        ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB me@host', /SSH Key Converter/],
        ['{"kty":"EC","crv":"secp256k1","x":"","y":""}', /secp256k1.*P-256, P-384/s],
        ['not a key at all!!', /Unrecognized input/],
    ];
    for (const [input, re] of cases) {
        await page.fill('#kp-inspect', input);
        await page.click('#btn-kp-analyze');
        await page.waitForSelector('#kp-report .kp-error');
        assert.match(await page.textContent('#kp-report .kp-error'), re, 'for input: ' + input.slice(0, 40));
    }
});

test('symmetric generation shows hex and hides the public block', async () => {
    await page.selectOption('#kp-type', 'oct');
    await page.selectOption('#kp-param', '32');
    await page.click('#btn-kp-generate');
    await waitGenerated();
    assert.match(await page.inputValue('#kp-priv'), /^[0-9a-f]{64}$/);
    assert.equal(await page.isVisible('#kp-pub-block'), false);
    await waitReport();
    const r = await rows();
    assert.match(r['Usable as (JOSE)'], /HS256.*A256GCM/);
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
