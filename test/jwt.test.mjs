// jwt.html — encode/decode direction buttons, algorithm-aware signature UI,
// and real WebCrypto sign/verify round-trips.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env, page;
before(async () => {
    env = await startEnv();
    page = env.page;
    await env.goto('jwt.html');
});
after(async () => { await env.close(); });

const status = () => page.textContent('#jwt-sig-status');
const waitStatus = re => page.waitForFunction(
    src => new RegExp(src).test(document.getElementById('jwt-sig-status').textContent), re.source);

test('HS256: encode from claims, decode back, signature verifies', async () => {
    await page.fill('#jwt-secret', 'top-secret');
    await page.click('#btn-jwt-encode');
    await waitStatus(/Token signed\. \(HS256\)/);
    const token = await page.inputValue('#jwt-input');
    assert.equal(token.split('.').length, 3);
    assert.match(token, /^eyJ/);

    await page.click('#btn-jwt-decode');
    await waitStatus(/Signature verified \(HS256\)/);
    assert.match(await page.inputValue('#jwt-payload'), /"sub": "1234567890"/);

    // and the same token with the wrong secret must fail verification
    await page.fill('#jwt-secret', 'wrong');
    await page.click('#btn-jwt-verify');
    await waitStatus(/INVALID/);
});

test('algorithm select drives which key input is shown', async () => {
    assert.equal(await page.isVisible('#jwt-sec-hmac'), true);
    assert.equal(await page.isVisible('#jwt-sec-asym'), false);

    await page.selectOption('#jwt-alg', 'RS256');
    assert.equal(await page.isVisible('#jwt-sec-hmac'), false);
    assert.equal(await page.isVisible('#jwt-sec-asym'), true);

    await page.selectOption('#jwt-alg', 'none');
    assert.equal(await page.isVisible('#jwt-sec-none'), true);

    // Custom mode edits the raw header JSON; typ selects hide.
    await page.selectOption('#jwt-alg', 'custom');
    assert.equal(await page.isVisible('#jwt-header-raw'), true);
    assert.equal(await page.isVisible('#jwt-typ-group'), false);

    await page.selectOption('#jwt-alg', 'HS256');
    assert.equal(await page.isVisible('#jwt-header-raw'), false);
    assert.equal(await page.isVisible('#jwt-typ-group'), true);
});

test('ES256: signs with a private JWK, verifies with a public SPKI PEM', async () => {
    const keys = await page.evaluate(async () => {
        const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
        const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
        const b64 = btoa(String.fromCharCode(...spki));
        return {
            jwk: JSON.stringify(jwk),
            pem: '-----BEGIN PUBLIC KEY-----\n' + b64.replace(/(.{64})/g, '$1\n') + '\n-----END PUBLIC KEY-----',
        };
    });
    await page.selectOption('#jwt-alg', 'ES256');
    await page.fill('#jwt-privkey', keys.jwk);
    await page.fill('#jwt-pubkey', keys.pem);
    await page.click('#btn-jwt-encode');
    await waitStatus(/Token signed\. \(ES256\)/);

    await page.click('#btn-jwt-decode');
    await waitStatus(/Signature verified \(ES256\)/);
    // decode reflected the token header back into the select
    assert.equal(await page.inputValue('#jwt-alg'), 'ES256');

    // pasting the private key where the public key belongs is caught
    await page.fill('#jwt-pubkey', keys.jwk);
    await page.click('#btn-jwt-verify');
    await waitStatus(/Signature verified \(ES256\)/); // private JWK is stripped to its public part
});

test('mismatched public/private keys are flagged, and verification says why it failed', async () => {
    const pems = await page.evaluate(async () => {
        const mk = async () => {
            const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
            const wrap = (label, bytes) => '-----BEGIN ' + label + '-----\n'
                + btoa(String.fromCharCode(...bytes)).replace(/(.{64})/g, '$1\n').trim()
                + '\n-----END ' + label + '-----';
            return {
                priv: wrap('PRIVATE KEY', new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))),
                pub: wrap('PUBLIC KEY', new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey))),
            };
        };
        const a = await mk(), b = await mk();
        return { priv: a.priv, pub: a.pub, otherPub: b.pub };
    });
    await page.selectOption('#jwt-alg', 'ES256');
    await page.fill('#jwt-privkey', pems.priv);
    await page.fill('#jwt-pubkey', pems.pub);
    await page.waitForFunction(() => document.getElementById('jwt-key-match').classList.contains('ok'));
    assert.match(await page.textContent('#jwt-key-match'), /matching pair/);

    // swap in an unrelated public key → live mismatch warning
    await page.fill('#jwt-pubkey', pems.otherPub);
    await page.waitForFunction(() => document.getElementById('jwt-key-match').classList.contains('warn'));
    assert.match(await page.textContent('#jwt-key-match'), /NOT a matching pair/);

    // and verifying a token against the wrong public key explains the cause
    await page.click('#btn-jwt-encode');
    await waitStatus(/Token signed\. \(ES256\)/);
    await page.click('#btn-jwt-decode');
    await waitStatus(/INVALID — the token decoded, but this public key does not match its signature/);
    const cls = await page.getAttribute('#jwt-sig-status', 'class');
    assert.match(cls, /\bbad\b/);
});

test('Generate key pair fills both boxes and the pair round-trips', async () => {
    await page.selectOption('#jwt-alg', 'ES384');
    await page.fill('#jwt-privkey', '');
    await page.fill('#jwt-pubkey', '');
    await page.click('#btn-jwt-genkey');
    await waitStatus(/Generated a new key pair\. \(ES384\)/);
    assert.match(await page.inputValue('#jwt-privkey'), /^-----BEGIN PRIVATE KEY-----\n[\s\S]+-----END PRIVATE KEY-----$/);
    assert.match(await page.inputValue('#jwt-pubkey'), /^-----BEGIN PUBLIC KEY-----\n[\s\S]+-----END PUBLIC KEY-----$/);

    // the generated pair actually signs and verifies
    await page.click('#btn-jwt-encode');
    await waitStatus(/Token signed\. \(ES384\)/);
    await page.click('#btn-jwt-decode');
    await waitStatus(/Signature verified \(ES384\)/);
});

test('a header beyond {alg, typ} falls back to Custom (raw JSON) mode', async () => {
    const token = await page.evaluate(() => {
        const enc = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return enc(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' })) + '.' + enc(JSON.stringify({ a: 1 })) + '.sig';
    });
    await page.fill('#jwt-input', token);
    await page.click('#btn-jwt-decode');
    await page.waitForFunction(() => document.getElementById('jwt-alg').value === 'custom');
    assert.equal(await page.isVisible('#jwt-header-raw'), true);
    assert.match(await page.inputValue('#jwt-header'), /"kid": "k1"/);
    // the alg inside the custom JSON still selects the asymmetric key UI
    assert.equal(await page.isVisible('#jwt-sec-asym'), true);
});

test('alg "none" and non-JSON payloads are reported, not signed', async () => {
    const unsigned = await page.evaluate(() => {
        const enc = s => btoa(s).replace(/=+$/, '');
        return enc(JSON.stringify({ alg: 'none' })) + '.' + enc(JSON.stringify({ a: 1 })) + '.';
    });
    await page.fill('#jwt-input', unsigned);
    await page.click('#btn-jwt-decode');
    await waitStatus(/unsigned/);
    assert.equal(await page.inputValue('#jwt-alg'), 'none');

    await page.selectOption('#jwt-alg', 'HS256');
    await page.fill('#jwt-payload', '{oops');
    await page.click('#btn-jwt-encode');
    await waitStatus(/Payload is not valid JSON/);
    await page.fill('#jwt-payload', '{"a":1}');
});

test('typ select round-trips through encode → decode', async () => {
    await page.selectOption('#jwt-alg', 'HS256');
    await page.selectOption('#jwt-typ', 'at+jwt');
    await page.fill('#jwt-secret', 's');
    await page.click('#btn-jwt-encode');
    await waitStatus(/Token signed\. \(HS256\)/);
    await page.click('#btn-jwt-decode');
    await page.waitForFunction(() => document.getElementById('jwt-typ').value === 'at+jwt');
    assert.match(await page.inputValue('#jwt-header'), /"typ": "at\+jwt"/);
});

test('narrow viewport: direction buttons go horizontal with rotated chevrons', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const dir = await page.evaluate(() => ({
        flex: getComputedStyle(document.querySelector('.jwt-dir')).flexDirection,
        svg: getComputedStyle(document.querySelector('.jwt-dir svg')).transform,
    }));
    assert.equal(dir.flex, 'row');
    assert.equal(dir.svg, 'matrix(0, 1, -1, 0, 0, 0)'); // rotate(90deg)
    await page.setViewportSize({ width: 1280, height: 720 });
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
