import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, attachVirtualAuthenticator } from './helpers.mjs';

let env, page;
before(async () => {
    env = await startEnv({ permissions: ['clipboard-read', 'clipboard-write'] });
    page = env.page;
});
after(async () => { await env.close(); });

const output = () => page.textContent('#sg-output');
const waitStatus = s => page.waitForFunction(
    expected => document.getElementById('sg-status').textContent === expected, s);
// [label, state] per checklist row, so a test can assert on grading, not just text.
const checks = () => page.$$eval('#sg-checks .sg-check', els => els.map(e => [
    e.querySelector('.sg-check-name').textContent,
    e.className.replace('sg-check ', '').replace(' key', ''),
]));
const failedChecks = async () => (await checks()).filter(([, k]) => k === 'fail').map(([n]) => n);

// A keypair generated in-page, the way a user would paste one in.
function makePems() {
    return page.evaluate(async () => {
        const W = window.LocalUtilWebAuthn;
        const mk = async () => {
            const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
            return {
                priv: W.pemWrap('PRIVATE KEY', new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))),
                pub: W.pemWrap('PUBLIC KEY', new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey))),
            };
        };
        const mine = await mk(), other = await mk();
        return { priv: mine.priv, pub: mine.pub, otherPub: other.pub };
    });
}

test('shows the hash that will actually be signed', async () => {
    await env.goto('sign.html');
    await page.fill('#sg-message', 'I authorise payment #42');
    await page.waitForFunction(() => /SHA-256: [0-9a-f]{64}/.test(document.getElementById('sg-msg-hash').textContent));
    assert.match(await page.textContent('#sg-msg-hash'), /SHA-256: [0-9a-f]{64} · 23 bytes/);
    assert.equal(await page.inputValue('#sg-row select'), 'webauthn');
    assert.ok(await page.isVisible('button[data-act="wa-create"]'),
        'a credential must exist first — its public key is only exposed at creation');
});

test('PEM signing produces a standard compact JWS, verified against a pinned key', async () => {
    await env.goto('sign.html');
    const pems = await makePems();
    await page.fill('#sg-message', 'I authorise payment #42');
    await page.selectOption('#sg-row select', 'pem');
    await page.fill('#sg-pem', pems.priv);
    await page.click('#sg-run');
    await waitStatus('Signed');
    const jws = (await output()).trim();

    // Standard JOSE, no invented marker.
    assert.equal(jws.split('.').length, 3);
    assert.ok(!/LUSIG/.test(jws));
    const header = await page.evaluate(t => JSON.parse(new TextDecoder().decode(
        window.LocalUtilWebAuthn.b64urlDecode(t.split('.')[0]))), jws);
    assert.deepEqual(header, { alg: 'ES256' });
    assert.match(await page.textContent('#sg-out-note'), /Compact JWS · ES256/);

    await page.click('#sg-mode button[data-mode="verify"]');
    assert.ok(await page.isVisible('#sg-sig-card'));
    // A private key must never linger in a field that now means "public key".
    assert.equal(await page.isVisible('#sg-pem'), false);
    assert.equal(await page.inputValue('#sg-row select'), 'auto');

    await page.fill('#sg-message', 'I authorise payment #42');
    await page.fill('#sg-sig-in', jws);
    await page.click('#sg-run');
    await waitStatus('Invalid');
    assert.ok((await failedChecks()).length, 'without a pinned key there is nothing to trust');

    await page.fill('#sg-pin', pems.pub);
    await page.click('#sg-run');
    await waitStatus('Valid');
    assert.match(await output(), /^VALID/);
    assert.match(await page.textContent('#sg-summary'), /✓ \d+ \/ \d+ passed/);

    // Wrong key, then wrong message.
    await page.fill('#sg-pin', pems.otherPub);
    await page.click('#sg-run');
    await waitStatus('Invalid');
    assert.ok((await failedChecks()).includes('Signature'));

    await page.fill('#sg-pin', pems.pub);
    await page.fill('#sg-message', 'I authorise payment #43');
    await page.click('#sg-run');
    await waitStatus('Invalid');
    assert.ok((await failedChecks()).includes('Payload matches the text you supplied'),
        'the payload travels in the token, so a mismatch is the named failure');
});

test('HS256 is offered and reported as a MAC, not a signature', async () => {
    await env.goto('sign.html');
    await page.fill('#sg-message', 'ping');
    await page.selectOption('#sg-row select', 'rawkey');
    await page.fill('#sg-rk', 'a'.repeat(64));
    assert.match(await page.textContent('#sg-row select option:checked'), /not a signature/);
    await page.click('#sg-run');
    await waitStatus('Signed');
    const mac = (await output()).trim();
    assert.match(await page.textContent('#sg-out-note'), /HS256 — a MAC/);

    await page.click('#sg-mode button[data-mode="verify"]');
    await page.fill('#sg-message', 'ping');
    await page.fill('#sg-sig-in', mac);
    await page.selectOption('#sg-row select', 'rawkey');
    await page.fill('#sg-rk', 'a'.repeat(64));
    await page.click('#sg-run');
    await waitStatus('Valid');
    assert.match(await page.textContent('#sg-out-note'), /not who wrote it/);

    await page.fill('#sg-rk', 'b'.repeat(64));
    await page.click('#sg-run');
    await waitStatus('Invalid');
    assert.match(await output(), /^INVALID/);
});

test('a JSON-payload JWS is a JWT, and the repo’s JWT Decode reads it', async () => {
    // JWT requires a JSON payload; a JWS does not. Signing JSON therefore yields
    // a token that ordinary JWT tooling accepts — which is the interop payoff of
    // using RFC 7515 instead of an invented container.
    await env.goto('sign.html');
    const pems = await makePems();
    await page.fill('#sg-message', '{"sub":"alice","act":"transfer"}');
    await page.selectOption('#sg-row select', 'pem');
    await page.fill('#sg-pem', pems.priv);
    await page.click('#sg-run');
    await waitStatus('Signed');
    const jws = (await output()).trim();

    await env.goto('jwt.html');
    await page.fill('#jwt-input', jws);
    await page.click('#btn-jwt-decode');
    await page.waitForFunction(() => document.getElementById('jwt-header').value.includes('ES256'));
    assert.match(await page.inputValue('#jwt-header'), /"alg":\s*"ES256"/);
    assert.match(await page.inputValue('#jwt-payload'), /"sub":\s*"alice"/,
        'the payload decodes as JSON, so the token is a valid JWT too');
});

test('security key: standard response JSON, verified property by property', async () => {
    const auth = await attachVirtualAuthenticator(page, {
        hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
    });
    try {
        await env.goto('sign.html');
        await page.fill('#sg-message', 'transfer 100 to alice');
        await page.click('button[data-act="wa-create"]');
        await page.waitForSelector('#sg-row .sg-badge-alg');
        assert.match(await page.textContent('#sg-row .sg-badge-alg'), /ES256|EdDSA/);
        await page.click('#sg-run');
        await waitStatus('Signed');
        const sig = (await output()).trim();
        assert.ok(sig.startsWith('{'), 'the artefact is WebAuthn response JSON, not a custom format');
        assert.ok(!/LUSIG/.test(sig));
        const parsedResp = JSON.parse(sig);
        assert.equal(parsedResp.type, 'public-key');
        assert.deepEqual(Object.keys(parsedResp.response).sort(),
            ['authenticatorData', 'clientDataJSON', 'signature'],
            'userHandle is optional and non-nullable — omitted, not null');
        assert.match(await page.textContent('#sg-out-note'), /message hash travels in the challenge/);

        // The public key has to be handed over separately.
        const pubPem = await page.evaluate(() => {
            const s = JSON.parse(localStorage.getItem('localutil-sign-credential'));
            return window.LocalUtilWebAuthn.pemWrap('PUBLIC KEY', window.LocalUtilWebAuthn.b64urlDecode(s.spki));
        });
        assert.match(pubPem, /BEGIN PUBLIC KEY/);

        // Without persistence the public key would be lost and past signatures
        // could no longer be produced for the same credential.
        await env.goto('sign.html');
        assert.ok(await page.isVisible('#sg-row .sg-badge-alg'), 'credential survives a reload');

        await page.click('#sg-mode button[data-mode="verify"]');
        await page.fill('#sg-message', 'transfer 100 to alice');
        await page.fill('#sg-sig-in', sig);
        await page.click('#sg-run');
        await waitStatus('Invalid');
        assert.ok((await failedChecks()).includes('Public key'),
            'a WebAuthn response carries no key, so verification must demand one');

        await page.fill('#sg-pin', pubPem);
        await page.click('#sg-run');
        await waitStatus('Valid');
        const rows = await checks();
        for (const name of ['clientDataJSON', 'Ceremony type', 'Challenge ⇄ message binding',
            'RP ID hash', 'User presence (UP)', 'Signature']) {
            assert.deepEqual(rows.find(r => r[0] === name), [name, 'pass'], name + ' must be graded and pass');
        }
        assert.ok(rows.some(([n, k]) => n === 'Signature counter' && k === 'info'),
            'signCount is informational — it is clone detection, not non-repudiation');
        assert.match(await page.$eval('#sg-checks .sg-check.key .sg-check-detail', e => e.textContent),
            /challenge equals SHA-256\(message\)/);
        assert.match(await page.textContent('#sg-out-note'), /bound to rpId/);

        // Domain binding: the same response must not verify as made elsewhere.
        await page.fill('#sg-rpid', 'evil.example');
        await page.click('#sg-run');
        await waitStatus('Invalid');
        assert.ok((await failedChecks()).includes('RP ID hash'));
        await page.fill('#sg-rpid', '');

        // The signature is cryptographically fine but was made over other
        // content: the binding check is what must catch it.
        await page.fill('#sg-message', 'transfer 900 to alice');
        await page.click('#sg-run');
        await waitStatus('Invalid');
        const failed = await failedChecks();
        assert.ok(failed.includes('Challenge ⇄ message binding'),
            'the binding must be the named failure');
        assert.ok(!failed.includes('Signature'),
            'the assertion signature itself is still valid — that is the whole subtlety');
    } finally { await auth.remove(); }
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
