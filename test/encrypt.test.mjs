import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, attachVirtualAuthenticator } from './helpers.mjs';

let env, page;
before(async () => {
    env = await startEnv({ permissions: ['clipboard-read', 'clipboard-write'] });
    page = env.page;
});
after(async () => { await env.close(); });

const output = () => page.textContent('#ec-output');
const waitStatus = s => page.waitForFunction(
    expected => document.getElementById('ec-status').textContent === expected, s);
const rowTypes = () => page.$$eval('#ec-rows select', els => els.map(e => e.value));

test('exactly one source, and it is what unlocks the result', async () => {
    await env.goto('encrypt.html');
    assert.deepEqual(await rowTypes(), ['webauthn'], 'one source, not a list');
    assert.equal(await page.textContent('#ec-run'), 'Encrypt');
    assert.match(await page.textContent('#ec-src-title'), /Lock with/);
    assert.match(await page.textContent('#ec-src-sub'), /what unlocks it/);
    // Browser-level capability is never presented as proof about the key itself.
    const cap = await page.textContent('#ec-rows .ks-cap');
    assert.match(cap, /confirmed when you register|not supported here|no WebAuthn/);
});

test('password round-trip: ciphertext and parameters stay separate', async () => {
    await env.goto('encrypt.html');
    await page.selectOption('#ec-rows .ks-row:first-child select', 'password');
    await page.fill('#ec-rows .ks-row:first-child input[data-f="password"]', 'pw-one');
    assert.deepEqual(await rowTypes(), ['password']);

    await page.fill('#ec-input', 'attack at dawn 새벽에');
    await page.click('#ec-run');
    await waitStatus('Encrypted');
    const ct = (await output()).trim();
    const params = (await page.textContent('#ec-params-out')).trim();

    // The ciphertext box holds nothing but ciphertext.
    assert.ok(/^[A-Za-z0-9_-]+$/.test(ct), 'plain base64url, no envelope: ' + ct.slice(0, 40));
    assert.ok(!/LUENC|=|\./.test(ct), 'no marker, no parameters');
    assert.match(await page.textContent('#ec-out-note'), /^\d+ bytes of ciphertext$/);

    // The parameters are shown separately, and are readable.
    assert.ok(await page.isVisible('#ec-params-out-wrap'));
    assert.match(params, /kdf=PBKDF2-SHA256/);
    assert.match(params, /iters=600000/);
    assert.match(params, /^v=1$/m);

    await page.click('#ec-mode button[data-mode="decrypt"]');
    assert.equal(await page.textContent('#ec-in-title'), 'Ciphertext');
    assert.ok(await page.isVisible('#ec-params-in'), 'decrypting asks for the parameters');
    assert.equal(await page.isVisible('#ec-params-out-wrap'), false);

    // Ciphertext without parameters is not enough.
    await page.fill('#ec-input', ct);
    await page.selectOption('#ec-rows .ks-row:first-child select', 'password');
    await page.fill('#ec-rows .ks-row:first-child input[data-f="password"]', 'pw-one');
    await page.click('#ec-run');
    await page.waitForFunction(() => /parameters/.test(document.getElementById('ec-output').textContent));
    assert.match(await output(), /Paste the decryption parameters first/);

    await page.fill('#ec-params-in', params);
    await page.click('#ec-run');
    await waitStatus('Decrypted');
    assert.equal(await output(), 'attack at dawn 새벽에');
    assert.match(await page.textContent('#ec-out-note'), /bytes recovered/);

    // A single edited parameter must fail, not silently weaken anything.
    await page.fill('#ec-params-in', params.replace(/iters=\d+/, 'iters=1000'));
    await page.click('#ec-run');
    await page.waitForFunction(() => /Could not decrypt/.test(document.getElementById('ec-output').textContent));
    assert.match(await output(), /altered parameters, or altered ciphertext/);

    await page.fill('#ec-params-in', params);
    await page.fill('#ec-rows .ks-row:first-child input[data-f="password"]', 'nope');
    await page.click('#ec-run');
    await page.waitForFunction(() => /Could not decrypt/.test(document.getElementById('ec-output').textContent));
    assert.match(await output(), /wrong password/);
});

test('the PEM field asks for the public key to encrypt, the private key to decrypt', async () => {
    await env.goto('encrypt.html');
    await page.selectOption('#ec-rows .ks-row:first-child select', 'pem');
    assert.match(await page.textContent('#ec-rows .ks-row:first-child label'), /PUBLIC key \(SPKI\)/);
    await page.click('#ec-mode button[data-mode="decrypt"]');
    await page.selectOption('#ec-rows .ks-row:first-child select', 'pem');
    assert.match(await page.textContent('#ec-rows .ks-row:first-child label'), /PRIVATE key \(PKCS#8\)/);
});

test('security key: register, encrypt, then unlock with the same key', async () => {
    const auth = await attachVirtualAuthenticator(page, {
        hasPrf: true, hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
    });
    try {
        await env.goto('encrypt.html');
        await page.fill('#ec-input', 'sealed by yubikey');
        await page.click('#ec-rows button[data-act="wa-register"]');
        await page.waitForSelector('#ec-rows .ks-badge-mode');
        assert.equal((await page.textContent('#ec-rows .ks-badge-mode')).trim(), 'one-shot');
        assert.match(await page.textContent('#ec-rows .ks-badge:not(.ks-badge-mode):not(.on)'), /slot-free/,
            'the default must not consume a credential slot on the key');
        assert.match(await page.textContent('#ec-rows .ks-row-note.ok'), /hmac-secret-mc|firmware 5\.8/,
            'the UI says why it only needed one touch');

        await page.click('#ec-run');
        await waitStatus('Encrypted');
        const ct = (await output()).trim();
        const params = (await page.textContent('#ec-params-out')).trim();
        assert.match(await page.textContent('#ec-out-note'), /bytes of ciphertext/);
        assert.match(params, /kdf=WEBAUTHN-PRF/);
        assert.match(params, /cred=/, 'the credential id is a published parameter');
        assert.ok(!/ek=/.test(params), 'no wrapped key rides along');
        assert.ok(!/LUENC|kdf/.test(ct), 'the ciphertext itself stays bare');

        // Fresh load, nothing in memory: the credential id comes from the
        // parameters, so a slot-free credential is still usable.
        await env.goto('encrypt.html');
        await page.click('#ec-mode button[data-mode="decrypt"]');
        await page.selectOption('#ec-rows .ks-row:first-child select', 'webauthn');
        await page.click('#ec-rows button[data-act="wa-register"]');
        await page.waitForSelector('#ec-rows .ks-row-note.err');
        assert.match(await page.textContent('#ec-rows .ks-row-note.err'),
            /Paste the decryption parameters first/, 'it needs the credential id before it can ask the key');

        await page.fill('#ec-input', ct);
        await page.fill('#ec-params-in', params);
        await page.click('#ec-rows button[data-act="wa-register"]');
        await page.waitForSelector('#ec-rows .ks-badge-mode');
        await page.click('#ec-run');
        await waitStatus('Decrypted');
        assert.equal(await output(), 'sealed by yubikey');

        // A password cannot open key-locked data, and the message says so.
        await page.selectOption('#ec-rows .ks-row:first-child select', 'password');
        await page.fill('#ec-rows .ks-row:first-child input[data-f="password"]', 'guess');
        await page.click('#ec-run');
        await page.waitForFunction(() => /locked with/.test(document.getElementById('ec-output').textContent));
        assert.match(await output(), /locked with a security key — unlock it with the same thing/);
    } finally { await auth.remove(); }
});

test('an authenticator without PRF explains itself in the row', async () => {
    const auth = await attachVirtualAuthenticator(page, {
        hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
    });
    try {
        await env.goto('encrypt.html');
        await page.click('#ec-rows button[data-act="wa-register"]');
        await page.waitForSelector('#ec-rows .ks-row-note.err');
        assert.match(await page.textContent('#ec-rows .ks-row-note.err'),
            /does not support the PRF extension|hmac-secret/);
    } finally { await auth.remove(); }
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
