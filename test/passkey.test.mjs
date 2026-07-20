// Passkey / WebAuthn Debugger — real create()/get() ceremonies against a CDP
// virtual authenticator, plus direct checks of the page's parsers via window.PK.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { startEnv, attachVirtualAuthenticator } from './helpers.mjs';

let env;

before(async () => {
    env = await startEnv();
    await attachVirtualAuthenticator(env.page);
    await env.goto('passkey.html');
});
after(async () => { await env.close(); });

// ---------------------------------------------------------------- environment

test('environment: capability chips and RP ID reflect the test origin', async () => {
    await env.page.waitForSelector('#pk-chip-secure.on');
    await env.page.waitForSelector('#pk-chip-webauthn.on');
    await env.page.waitForSelector('#pk-chip-platform.on'); // virtual authenticator is internal + UV
    const rpid = await env.page.$eval('#pk-env-rpid', e => e.textContent);
    assert.equal(rpid, 'localhost');
    const origin = await env.page.$eval('#pk-env-origin', e => e.textContent);
    assert.equal(origin, env.server.base);
});

test('options JSON preview: platform preset defaults', async () => {
    const json = await env.page.$eval('#pk-json-register-out', e => e.textContent);
    const obj = JSON.parse(json);
    assert.equal(obj.publicKey.rp.id, 'localhost');
    assert.equal(obj.publicKey.authenticatorSelection.residentKey, 'required');
    assert.equal(obj.publicKey.authenticatorSelection.userVerification, 'preferred');
    assert.equal(obj.publicKey.authenticatorSelection.authenticatorAttachment, 'platform');
    assert.equal(obj.publicKey.attestation, 'none');
    assert.deepEqual(obj.publicKey.pubKeyCredParams.map(p => p.alg), [-7, -257]);
    assert.equal(typeof obj.publicKey.challenge, 'string'); // base64url
    // syntax highlighting present (keys/strings wrapped in spans)
    const spans = await env.page.$eval('#pk-json-register-out', e => e.querySelectorAll('.pk-j-key, .pk-j-str').length);
    assert.ok(spans > 5, 'JSON preview is syntax-highlighted');
});

// ---------------------------------------------------------------- registration

test('register: default preset creates a passkey, checklist all PASS', async () => {
    await env.page.click('#pk-btn-create');
    await env.page.waitForSelector('#pk-reg-result [data-pk="checklist"]', { timeout: 15000 });
    const summary = await env.page.$eval('#pk-reg-result .pk-check-summary', e => e.textContent);
    assert.match(summary, /✓ 5 \/ 5 passed/);
    const checklist = await env.page.$eval('#pk-reg-result [data-pk="checklist"]', e => e.innerText);
    for (const row of ['Type', 'Challenge', 'Origin', 'RP ID hash', 'User Present']) {
        assert.ok(checklist.includes(row), `checklist row: ${row}`);
    }
});

test('register: authenticatorData decoded — rpIdHash, flags, credential ID, public key', async () => {
    const card = await env.page.$eval('#pk-reg-result [data-pk="reg-authdata"]', e => e.innerText);
    assert.match(card, /rpIdHash/);
    assert.match(card, /UP✓/);
    assert.match(card, /AT✓/);
    assert.match(card, /Credential ID/);
    assert.match(card, /ES256/);
    const attCard = await env.page.$eval('#pk-reg-result [data-pk="attestation"]', e => e.innerText);
    assert.match(attCard, /none/);
});

test('register: credential auto-saved with a valid ES256 JWK', async () => {
    const creds = await env.page.evaluate(() => window.PK.loadCreds());
    assert.equal(creds.length, 1);
    assert.equal(creds[0].name, 'demo@localutil');
    assert.equal(creds[0].algName, 'ES256');
    // the exported JWK must import cleanly as a P-256 verification key
    await webcrypto.subtle.importKey('jwk', creds[0].jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const badge = await env.page.$eval('#pk-saved-count', e => e.textContent);
    assert.match(badge, /1/);
    // nothing hidden: the Saved card exposes the full stored entry as JSON
    await env.page.click('#pk-tabs button[data-tab="saved"]');
    const fullData = await env.page.$eval('.pk-cred details .pk-jsonbox', e => e.textContent);
    const entry = JSON.parse(fullData);
    for (const field of ['id', 'userId', 'jwk', 'aaguid', 'signCount', 'createdAt']) {
        assert.ok(field in entry, `stored field visible: ${field}`);
    }
    await env.page.click('#pk-tabs button[data-tab="register"]');
});

// ---------------------------------------------------------------- authentication

test('sign in: discoverable credential — signature verified, no failures', async () => {
    await env.page.click('#pk-tabs button[data-tab="signin"]');
    await env.page.click('#pk-btn-signin');
    await env.page.waitForSelector('#pk-signin-result [data-pk="checklist"]', { timeout: 15000 });
    const summary = await env.page.$eval('#pk-signin-result .pk-check-summary', e => e.textContent);
    assert.match(summary, /✓ \d+ \/ \d+ passed/);
    const checklist = await env.page.$eval('#pk-signin-result [data-pk="checklist"]', e => e.innerText);
    assert.match(checklist, /Signature/);
    assert.match(checklist, /verified with the saved public key/);
    assert.match(checklist, /Sign counter/);
    assert.doesNotMatch(checklist, /went backwards/);
});

test('sign in: "Use for sign-in" drives a specific-credential assertion', async () => {
    await env.page.click('#pk-tabs button[data-tab="saved"]');
    await env.page.click('.pk-cred button[data-act="use"]');
    // now on the sign-in tab with source = specific
    const src = await env.page.$eval('#pk-signin-source button.active', e => e.textContent);
    assert.equal(src, 'Specific credential');
    const json = JSON.parse(await env.page.$eval('#pk-json-signin-out', e => e.textContent));
    assert.equal(json.publicKey.allowCredentials.length, 1);
    await env.page.click('#pk-btn-signin');
    await env.page.waitForSelector('#pk-signin-result [data-pk="checklist"]', { timeout: 15000 });
    const checklist = await env.page.$eval('#pk-signin-result [data-pk="checklist"]', e => e.innerText);
    assert.match(checklist, /verified with the saved public key/);
    // store bookkeeping
    const creds = await env.page.evaluate(() => window.PK.loadCreds());
    assert.ok(creds[0].authCount >= 2, 'authCount should count both sign-ins');
    assert.ok(creds[0].lastUsedAt, 'lastUsedAt set');
});

// ---------------------------------------------------------------- advanced UX

test('advanced edit flips the scenario chip to Custom and updates the JSON', async () => {
    await env.page.click('#pk-tabs button[data-tab="register"]');
    const adv = await env.page.$('#pk-adv-register');
    if (!(await adv.evaluate(e => e.open))) await env.page.click('#pk-adv-register summary');
    await env.page.click('#pk-adv-register .segmented[data-field="attestation"] button[data-val="direct"]');
    const active = await env.page.$eval('#pk-presets button.active', e => e.textContent);
    assert.equal(active, 'Custom');
    const json = JSON.parse(await env.page.$eval('#pk-json-register-out', e => e.textContent));
    assert.equal(json.publicKey.attestation, 'direct');
    // option description updated in place
    const desc = await env.page.$eval('#pk-optdesc-attestation', e => e.textContent);
    assert.match(desc, /as-is/);
    // selecting a preset again overwrites the custom edit
    await env.page.click('#pk-presets button[data-preset="platform"]');
    const json2 = JSON.parse(await env.page.$eval('#pk-json-register-out', e => e.textContent));
    assert.equal(json2.publicKey.attestation, 'none');
});

// ---------------------------------------------------------------- parsers (window.PK)

test('derToP1363: handles sign-padding and left-pads r/s to 32 bytes', async () => {
    // r starts with 0x80 (needs 0x00 sign pad in DER), s is 32 bytes of 0x01
    const rHex = '80' + '11'.repeat(31);
    const sHex = '01'.repeat(32);
    const derHex = '3045' + '022100' + rHex + '0220' + sHex;
    const out = await env.page.evaluate(h => {
        const sig = window.PK.derToP1363(window.PK.fromHex(h), 32);
        return window.PK.toHex(sig);
    }, derHex);
    assert.equal(out, rHex + sHex);
});

test('cborDecode + coseToJwk: EC2 COSE key maps to a P-256 JWK', async () => {
    const xHex = '22'.repeat(32), yHex = '33'.repeat(32);
    const coseHex = 'a5010203262001215820' + xHex + '225820' + yHex;
    const res = await env.page.evaluate(h => {
        const cose = window.PK.cborDecode(window.PK.fromHex(h));
        const info = window.PK.coseToJwk(cose);
        return { jwk: info.jwk, alg: info.alg };
    }, coseHex);
    assert.equal(res.jwk.kty, 'EC');
    assert.equal(res.jwk.crv, 'P-256');
    assert.equal(res.alg, -7);
    assert.equal(res.jwk.x, Buffer.from(xHex, 'hex').toString('base64url'));
    assert.equal(res.jwk.y, Buffer.from(yHex, 'hex').toString('base64url'));
});

test('cborDecode: garbage input throws instead of mis-decoding', async () => {
    const threw = await env.page.evaluate(() => {
        try { window.PK.cborDecode(window.PK.fromHex('ff00ff00')); return false; }
        catch { return true; }
    });
    assert.ok(threw);
});

// ---------------------------------------------------------------- inspect tab

function syncedPasskeyAuthDataHex(rpIdHashHex) {
    // 37-byte authenticatorData: rpIdHash ‖ flags(UP|UV) ‖ signCount 0
    return rpIdHashHex + '05' + '00000000';
}

test('inspect: counter-0 authenticatorData shows the "normal for platform passkeys" note', async () => {
    const rpIdHashHex = Buffer.from(
        await webcrypto.subtle.digest('SHA-256', Buffer.from('localhost'))
    ).toString('hex');
    const b64url = Buffer.from(syncedPasskeyAuthDataHex(rpIdHashHex), 'hex').toString('base64url');
    await env.page.click('#pk-tabs button[data-tab="inspect"]');
    await env.page.fill('#pk-inspect-input', b64url);
    await env.page.click('#pk-btn-decode');
    await env.page.waitForSelector('#pk-inspect-result [data-pk="insp-authdata"]');
    const card = await env.page.$eval('#pk-inspect-result [data-pk="insp-authdata"]', e => e.innerText);
    assert.match(card, /Sign count\s*0/);
    assert.match(card, /normal for platform passkeys/);
    assert.match(card, /UP✓/);
    assert.match(card, /UV✓/);
    assert.ok(card.includes(rpIdHashHex), 'decoded rpIdHash shown');
});

test('inspect: garbage input renders an inline error card (no page error)', async () => {
    await env.page.fill('#pk-inspect-input', '!!!not-base64url!!!');
    await env.page.click('#pk-btn-decode');
    await env.page.waitForSelector('#pk-inspect-result .pk-error');
    const err = await env.page.$eval('#pk-inspect-result .pk-error', e => e.innerText);
    assert.match(err, /Something went wrong|DecodeError/i);
});

// ---------------------------------------------------------------- saved tab

test('import: malformed JSON shows an error card and leaves the store unchanged', async () => {
    const beforeCreds = await env.page.evaluate(() => window.PK.loadCreds());
    await env.page.click('#pk-tabs button[data-tab="saved"]');
    await env.page.setInputFiles('#pk-import-file', {
        name: 'bad.json', mimeType: 'application/json',
        buffer: Buffer.from('{"nope": true}'),
    });
    await env.page.waitForSelector('#pk-tab-saved .pk-error');
    const afterCreds = await env.page.evaluate(() => window.PK.loadCreds());
    assert.deepEqual(afterCreds, beforeCreds);
});

test('delete: confirm warns the passkey stays on the device, then removes the entry', async () => {
    await env.page.click('.pk-cred button[data-act="delete"]');
    const confirmText = await env.page.$eval('.pk-cred-confirm', e => e.innerText);
    assert.match(confirmText, /does not delete the passkey from your device/);
    await env.page.click('.pk-cred-confirm button[data-confirm="yes"]');
    await env.page.waitForSelector('#pk-saved-list .pk-empty');
    const creds = await env.page.evaluate(() => window.PK.loadCreds());
    assert.equal(creds.length, 0);
    const empty = await env.page.$eval('#pk-saved-list .pk-empty', e => e.textContent);
    assert.match(empty, /No saved credentials yet/);
});

// ---------------------------------------------------------------- hygiene

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
