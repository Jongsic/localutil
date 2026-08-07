// The crypto layer behind encrypt.html / sign.html, driven directly. The UI
// tests cover the wiring; these cover the container formats, the tamper
// properties they promise, and both WebAuthn PRF ceremonies.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, attachVirtualAuthenticator } from './helpers.mjs';

let env;
// encrypt.html loads webauthn-core.js + keysource.js, and gives us a secure
// context on a real origin — everything WebAuthn needs.
before(async () => { env = await startEnv(); await env.goto('encrypt.html'); });
after(async () => { await env.close(); });

const run = fn => env.page.evaluate(fn);

test('password round-trip; the ciphertext alone reveals nothing about the KDF', async () => {
    const r = await run(async () => {
        const K = window.LocalUtilKeySource;
        const res = await K.encrypt(new TextEncoder().encode('hello 안녕 🔐'),
            { type: 'password', password: 'correct horse' });
        const out = await K.decrypt(res.ciphertext, res.paramsText, { type: 'password', password: 'correct horse' });
        let wrong = null;
        try {
            await K.decrypt(res.ciphertext, res.paramsText, { type: 'password', password: 'wrong' });
        } catch (e) { wrong = e.message; }
        return {
            text: new TextDecoder().decode(out.plaintext), wrong,
            ctB64: res.ciphertextB64, ctLen: res.ciphertext.length,
            paramsText: res.paramsText, plainLen: new TextEncoder().encode('hello 안녕 🔐').length,
        };
    });
    assert.equal(r.text, 'hello 안녕 🔐', 'UTF-8 survives intact');
    assert.match(r.wrong, /wrong password/);

    // The ciphertext is exactly the plaintext plus the 16-byte GCM tag: no
    // header, no marker, no salt, nothing naming the algorithm.
    assert.equal(r.ctLen, r.plainLen + 16);
    assert.ok(!/LUENC|PBKDF2|salt|iter/i.test(r.ctB64), 'no parameter leaks into the ciphertext');

    // The parameters are readable and complete, and live only here.
    assert.match(r.paramsText, /^v=1\nenc=A256GCM\nkdf=PBKDF2-SHA256\niv=[\w-]+\niters=600000\nsalt=[\w-]+$/);
});

test('raw keys must be exactly 32 bytes, hex or base64', async () => {
    const r = await run(async () => {
        const K = window.LocalUtilKeySource;
        const hex = 'a'.repeat(64);
        const res = await K.encrypt(new TextEncoder().encode('raw'), { type: 'rawkey', key: hex });
        const out = await K.decrypt(res.ciphertextB64, res.paramsText, { type: 'rawkey', key: hex });
        const errs = {};
        for (const [name, val] of [['short', 'abcd'], ['odd', 'abc'], ['garbage', '!!!!']]) {
            try { K.parseRawKey(val); errs[name] = null; } catch (e) { errs[name] = e.message; }
        }
        const b64 = K.parseRawKey(btoa(String.fromCharCode.apply(null, new Uint8Array(32))));
        return { text: new TextDecoder().decode(out.plaintext), errs, b64len: b64.length };
    });
    assert.equal(r.text, 'raw');
    assert.equal(r.b64len, 32, 'base64 input is accepted too');
    assert.match(r.errs.short, /exactly 32 bytes/);
    assert.match(r.errs.short, /Password Generator/, 'points somewhere useful');
    assert.ok(r.errs.odd, 'odd-length hex rejected');
    assert.ok(r.errs.garbage, 'non hex/base64 rejected');
});

test('parameters round-trip through their text form, and are order-insensitive', async () => {
    const r = await run(async () => {
        const K = window.LocalUtilKeySource;
        const enc = new TextEncoder();
        const res = await K.encrypt(enc.encode('shuffle me'), { type: 'password', password: 'pw' });

        // Reordered, re-spaced, commented — the canonical form is built from a
        // fixed field order, so none of this matters.
        const lines = res.paramsText.split('\n');
        const messy = '# handed over by hand\n' + lines.slice().reverse().map(l => '  ' + l + ' ').join('\n');
        const viaMessy = await K.decrypt(res.ciphertextB64, messy, { type: 'password', password: 'pw' });

        const errs = {};
        const grab = async fn => { try { await fn(); return null; } catch (e) { return e.message; } };
        errs.missing = await grab(() => K.decrypt(res.ciphertextB64, 'kdf=PBKDF2-SHA256', { type: 'password', password: 'pw' }));
        errs.empty = await grab(() => K.decrypt(res.ciphertextB64, '   ', { type: 'password', password: 'pw' }));
        errs.badLine = await grab(() => K.decrypt(res.ciphertextB64, 'nonsense', { type: 'password', password: 'pw' }));
        errs.unknownKdf = await grab(() => K.decrypt(res.ciphertextB64, 'v=1\nenc=A256GCM\nkdf=ROT13\niv=AA', { type: 'password', password: 'pw' }));
        errs.noParams = await grab(() => K.decrypt(res.ciphertextB64, res.paramsText, { type: 'rawkey', key: 'c'.repeat(64) }));
        return { messy: new TextDecoder().decode(viaMessy.plaintext), errs };
    });
    assert.equal(r.messy, 'shuffle me');
    assert.match(r.errs.missing, /missing: /);
    assert.match(r.errs.empty, /No decryption parameters/);
    assert.match(r.errs.badLine, /not name=value/);
    assert.match(r.errs.unknownKdf, /Unknown kdf/);
    assert.match(r.errs.noParams, /locked with a password — unlock it with the same thing/);
});

test('the authenticated parameter form is unambiguous across field boundaries', async () => {
    // Regression: joining values with a separator let a character be moved from
    // one field into the next without changing the authenticated bytes, so a
    // parameter could be rewritten while decryption still succeeded.
    const r = await run(async () => {
        const K = window.LocalUtilKeySource, W = window.LocalUtilWebAuthn;
        const enc = new TextEncoder();
        const res = await K.encrypt(enc.encode('boundary'), { type: 'password', password: 'pw' });

        // Craft two parameter sets that differ only in where a '|' sits.
        const shift = (text, fromKey, toKey) => {
            const o = {};
            text.split('\n').forEach(l => { const i = l.indexOf('='); o[l.slice(0, i)] = l.slice(i + 1); });
            o[fromKey] = o[fromKey] + '|Z';
            return Object.keys(o).map(k => k + '=' + o[k]).join('\n');
        };
        const attempt = async params => {
            try { await K.decrypt(res.ciphertextB64, params, { type: 'password', password: 'pw' }); return 'DECRYPTED'; }
            catch (e) { return 'failed'; }
        };
        return {
            intact: await attempt(res.paramsText),
            shifted: await attempt(shift(res.paramsText, 'salt')),
            kdfPipe: await attempt(res.paramsText.replace('kdf=PBKDF2-SHA256', 'kdf=PBKDF2-SHA256')),
        };
    });
    assert.equal(r.intact, 'DECRYPTED');
    assert.equal(r.shifted, 'failed', 'appending to a field must break the tag');
});

test('any password length works; HS256 accepts keys of 32 bytes or more', async () => {
    const r = await run(async () => {
        const K = window.LocalUtilKeySource;
        const enc = new TextEncoder(), dec = new TextDecoder();
        const out = {};
        const grab = async fn => { try { await fn(); return 'ok'; } catch (e) { return 'ERR: ' + e.message; } };

        // This is a testing tool: a one-character password must not be refused.
        const tiny = await K.encrypt(enc.encode('x'), { type: 'password', password: 'a' });
        out.tinyRoundTrip = dec.decode((await K.decrypt(tiny.ciphertext, tiny.paramsText,
            { type: 'password', password: 'a' })).plaintext);
        out.empty = await grab(() => K.encrypt(enc.encode('x'), { type: 'password', password: '' }));

        // The estimate is information only, never a gate.
        out.bits = {
            one: K.passwordStrength('a').bits,
            repeated: K.passwordStrength('a'.repeat(20)).bits,
            varied: K.passwordStrength('Tr0ub4dor&3-xK9zQmW!').bits,
        };

        // RFC 7518 §3.2 allows "or larger"; a long secret from another tool must work.
        const long = 'a'.repeat(128);
        const token = await K.signJws(enc.encode('interop'), { type: 'rawkey', key: long });
        out.longMac = (await K.verifyJws(token, { algorithms: ['HS256'], key: long, message: enc.encode('interop') })).valid;
        out.tooShortMac = await grab(() => K.signJws(enc.encode('x'), { type: 'rawkey', key: 'aa' }));
        return out;
    });
    assert.equal(r.tinyRoundTrip, 'x', 'a 1-character password must still encrypt and decrypt');
    assert.match(r.empty, /Password is empty/, 'only an entirely empty password is refused');
    assert.ok(r.bits.one > 0 && r.bits.repeated < r.bits.varied,
        'the estimate is reported, and repetition does not read as strength');
    assert.equal(r.longMac, true, 'a 128-byte HS256 key must verify (RFC 7518 §3.2 "or larger")');
    assert.match(r.tooShortMac, /at least 32 bytes/, 'but below the hash size is a real spec floor');
});

test('PBKDF2 iteration counts from elsewhere are bounded and strictly parsed', async () => {
    const r = await run(() => {
        const K = window.LocalUtilKeySource;
        const base = 'v=1\nenc=A256GCM\nkdf=PBKDF2-SHA256\niv=AAAAAAAAAAAAAAAA\nsalt=AAAAAAAAAAAAAAAAAAAAAA\n';
        const out = {};
        for (const it of ['600000', '1', '1e9', '0x10', ' 600000 ', '999999999', '-5', 'abc', '']) {
            try { out[JSON.stringify(it)] = K.paramsFromText(base + 'iters=' + it).iters; }
            catch (e) { out[JSON.stringify(it)] = 'ERR: ' + e.message; }
        }
        return out;
    });
    assert.equal(r['"600000"'], 600000);
    assert.equal(r['"1"'], 1);
    assert.equal(r['" 600000 "'], 600000, 'surrounding whitespace is trimmed, not rejected');
    // parseInt would have read these as 1 and 0x10 as 0/16 — silently weakening the KDF.
    assert.match(r['"1e9"'], /^ERR: iters must be a whole number/);
    assert.match(r['"0x10"'], /^ERR: iters must be a whole number/);
    assert.match(r['"abc"'], /^ERR: iters must be a whole number/);
    assert.match(r['"-5"'], /^ERR: iters must be a whole number/);
    assert.match(r['""'], /^ERR: iters must be a whole number/);
    // Unbounded counts freeze the tab: PBKDF2 runs on the main thread.
    assert.match(r['"999999999"'], /above the 10,000,000 limit/);
});

test('separating the parameters costs no integrity: altering one still fails', async () => {
    const r = await run(async () => {
        const K = window.LocalUtilKeySource, W = window.LocalUtilWebAuthn;
        const enc = new TextEncoder();
        const res = await K.encrypt(enc.encode('tamper me'), { type: 'password', password: 'pw' });
        const attempt = async (ct, params) => {
            try { await K.decrypt(ct, params, { type: 'password', password: 'pw' }); return null; }
            catch (e) { return e.message; }
        };
        const edit = (k, v) => res.paramsText.replace(new RegExp('^' + k + '=.*$', 'm'), k + '=' + v);
        const ctB = res.ciphertext.slice(); ctB[0] ^= 1;
        return {
            downgrade: await attempt(res.ciphertextB64, edit('iters', '1000')),
            saltSwap: await attempt(res.ciphertextB64, edit('salt', W.b64urlEncode(new Uint8Array(16)))),
            ivSwap: await attempt(res.ciphertextB64, edit('iv', W.b64urlEncode(new Uint8Array(12)))),
            bitFlip: await attempt(ctB, res.paramsText),
            truncated: await attempt(res.ciphertext.slice(0, 4), res.paramsText),
            intact: await attempt(res.ciphertextB64, res.paramsText),
        };
    });
    assert.ok(r.downgrade, 'lowering the PBKDF2 iteration count must fail');
    assert.ok(r.saltSwap, 'swapping the KDF salt must fail');
    assert.ok(r.ivSwap, 'swapping the IV must fail');
    assert.ok(r.bitFlip, 'a flipped ciphertext bit must fail');
    assert.ok(r.truncated, 'a truncated ciphertext must fail');
    assert.equal(r.intact, null, 'and the untouched pair still works');
});

test('RSA-OAEP and ECDH-ES public keys, with unusable keys explained', async () => {
    const r = await run(async () => {
        const K = window.LocalUtilKeySource, W = window.LocalUtilWebAuthn;
        const enc = new TextEncoder(), dec = new TextDecoder();
        async function pair(algo, usages) {
            const kp = await crypto.subtle.generateKey(algo, true, usages);
            return {
                pub: W.pemWrap('PUBLIC KEY', new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey))),
                priv: W.pemWrap('PRIVATE KEY', new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))),
            };
        }
        const rsa = await pair({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, ['encrypt', 'decrypt']);
        const ec = await pair({ name: 'ECDH', namedCurve: 'P-384' }, ['deriveBits']);
        const ed = await pair({ name: 'Ed25519' }, ['sign', 'verify']);

        const boxR = await K.encrypt(enc.encode('to rsa'), { type: 'pem', pem: rsa.pub });
        const boxE = await K.encrypt(enc.encode('to ec'), { type: 'pem', pem: ec.pub });
        const paramsR = boxR.params, paramsE = boxE.params;
        const errs = {};
        const grab = async fn => { try { await fn(); return null; } catch (e) { return e.message; } };
        errs.ed = await grab(() => K.encrypt(enc.encode('x'), { type: 'pem', pem: ed.pub }));
        errs.pkcs1 = await grab(() => K.parsePem('-----BEGIN RSA PUBLIC KEY-----\nAAAA\n-----END RSA PUBLIC KEY-----'));
        errs.sec1 = await grab(() => K.parsePem('-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----'));
        errs.encrypted = await grab(() => K.parsePem('-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----'));
        errs.privAsRecipient = await grab(() => K.encrypt(enc.encode('x'), { type: 'pem', pem: rsa.priv }));
        errs.notPem = await grab(() => K.parsePem('just some text'));

        return {
            rsa: dec.decode((await K.decrypt(boxR.ciphertext, boxR.paramsText, { type: 'pem', pem: rsa.priv })).plaintext),
            ec: dec.decode((await K.decrypt(boxE.ciphertext, boxE.paramsText, { type: 'pem', pem: ec.priv })).plaintext),
            errs, crv: paramsE.crv, hasEpk: !!paramsE.epk,
            ecHasWrappedKey: 'ek' in paramsE, rsaHasWrappedKey: 'ek' in paramsR,
        };
    });
    assert.equal(r.rsa, 'to rsa');
    assert.equal(r.ec, 'to ec', 'P-384 ECDH-ES round-trips');
    assert.equal(r.crv, 'P-384');
    assert.ok(r.hasEpk, 'the ephemeral public key travels in the header');
    assert.equal(r.ecHasWrappedKey, false,
        'ECDH agrees on a key, so nothing key-shaped is stored');
    assert.equal(r.rsaHasWrappedKey, true,
        'RSA-OAEP cannot agree on a key — it is the one source that transports one');
    assert.match(r.errs.ed, /cannot do key agreement/, 'Ed25519 explains itself instead of a raw DOM error');
    assert.match(r.errs.pkcs1, /openssl rsa -pubin/, 'PKCS#1 gives the conversion command');
    assert.match(r.errs.sec1, /openssl pkcs8 -topk8/);
    assert.match(r.errs.encrypted, /passphrase-encrypted/);
    assert.match(r.errs.privAsRecipient, /This is a PRIVATE key/);
    assert.match(r.errs.notPem, /Not a PEM block/);
});

test('JWS: EC / Ed25519 / RSA produce standard compact tokens', async () => {
    const r = await run(async () => {
        const K = window.LocalUtilKeySource, W = window.LocalUtilWebAuthn;
        const enc = new TextEncoder();
        const msg = enc.encode('sign this exact text');
        const out = {};
        for (const [name, algo, wantAlg] of [
            ['p256', { name: 'ECDSA', namedCurve: 'P-256' }, 'ES256'],
            ['p384', { name: 'ECDSA', namedCurve: 'P-384' }, 'ES384'],
            ['p521', { name: 'ECDSA', namedCurve: 'P-521' }, 'ES512'],
            ['ed25519', { name: 'Ed25519' }, 'EdDSA'],
            ['rsa', { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, 'RS256'],
        ]) {
            const kp = await crypto.subtle.generateKey(algo, true, ['sign', 'verify']);
            const priv = W.pemWrap('PRIVATE KEY', new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey)));
            const pub = W.pemWrap('PUBLIC KEY', new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey)));
            const token = await K.signJws(msg, { type: 'pem', pem: priv });
            const parsed = K.parseJws(token);
            const good = await K.verifyJws(token, { pinnedPem: pub, message: msg });
            const badMsg = await K.verifyJws(token, { pinnedPem: pub, message: enc.encode('sign this exact texT') });
            const noKey = await K.verifyJws(token, {});
            out[name] = {
                wantAlg, alg: parsed.alg, header: JSON.stringify(parsed.header),
                segments: token.split('.').length,
                payloadIsMessage: new TextDecoder().decode(parsed.payload) === 'sign this exact text',
                valid: good.valid,
                badValid: badMsg.valid,
                badFailed: badMsg.checks.filter(c => !c.ok).map(c => c.label),
                noKeyValid: noKey.valid,
                noKeyFailed: noKey.checks.filter(c => !c.ok).map(c => c.detail),
            };
        }
        return out;
    });
    for (const name of ['p256', 'p384', 'p521', 'ed25519', 'rsa']) {
        const v = r[name];
        assert.equal(v.alg, v.wantAlg, name + ' must map to the standard JWS alg');
        assert.equal(v.header, JSON.stringify({ alg: v.wantAlg }), name + ' header is minimal and standard');
        assert.equal(v.segments, 3, name + ' is compact serialization');
        assert.ok(v.payloadIsMessage, name + ' carries the message as the payload, per RFC 7515');
        assert.ok(v.valid, name + ' must verify');
        assert.equal(v.badValid, false, name + ' must reject an edited message');
        assert.ok(v.badFailed.length, name + ' must name what failed');
        assert.equal(v.noKeyValid, false, 'without a pinned key there is nothing to verify against');
        assert.ok(v.noKeyFailed.some(d => /public key/i.test(d)));
    }
});

test('JWS: HS256 works but is reported as a MAC', async () => {
    const r = await run(async () => {
        const K = window.LocalUtilKeySource;
        const msg = new TextEncoder().encode('ping');
        const key = 'a'.repeat(64);
        const token = await K.signJws(msg, { type: 'rawkey', key });
        const good = await K.verifyJws(token, { key, message: msg });
        const wrong = await K.verifyJws(token, { key: 'b'.repeat(64), message: msg });
        const noKey = await K.verifyJws(token, { message: msg });
        return {
            alg: K.parseJws(token).alg, valid: good.valid, mac: good.mac,
            note: good.checks.find(c => c.label === 'Secret').detail,
            wrongValid: wrong.valid, noKeyValid: noKey.valid,
        };
    });
    assert.equal(r.alg, 'HS256');
    assert.ok(r.valid && r.mac);
    assert.match(r.note, /symmetric/, 'the caveat travels with the result');
    assert.equal(r.wrongValid, false);
    assert.equal(r.noKeyValid, false);
});

test('JWS: the spec-required rejections that were previously accepted', async () => {
    const r = await run(async () => {
        const K = window.LocalUtilKeySource, W = window.LocalUtilWebAuthn;
        const enc = new TextEncoder();
        const msg = enc.encode('conformance');
        const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        const priv = W.pemWrap('PRIVATE KEY', new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey)));
        const pub = W.pemWrap('PUBLIC KEY', new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey)));
        const token = await K.signJws(msg, { type: 'pem', pem: priv });
        const [h, pl, sg] = token.split('.');
        const reheader = obj => W.b64urlEncode(enc.encode(JSON.stringify(obj))) + '.' + pl + '.' + sg;
        const grab = async (t, o) => {
            try { const r = await K.verifyJws(t, o || { pinnedPem: pub, message: msg }); return r.valid ? 'VALID' : 'invalid'; }
            catch (e) { return 'ERR: ' + e.message; }
        };
        return {
            baseline: await grab(token),
            // RFC 7515 §4.1.11 — crit listing anything unknown MUST be rejected.
            crit: await grab(reheader({ alg: 'ES256', crit: ['exp'], exp: 0 })),
            // §5.2 step 4 — duplicate header names are invalid.
            dupe: await grab(W.b64urlEncode(enc.encode('{"alg":"ES256","alg":"HS256"}')) + '.' + pl + '.' + sg),
            // §5.2 step 3 — the header must be a JSON object.
            array: await grab(W.b64urlEncode(enc.encode('[1,2]')) + '.' + pl + '.' + sg),
            // §2 — segments must be unpadded base64url, no whitespace, no +/.
            padded: await grab(h + '.' + pl + '.' + sg + '='),
            spaced: await grab(h + '. ' + pl + '.' + sg),
            // RFC 8725 §3.1 — the caller's algorithm allow-list must be honoured.
            algNotAllowed: await grab(token, { pinnedPem: pub, message: msg, algorithms: ['RS256'] }),
            algAllowed: await grab(token, { pinnedPem: pub, message: msg, algorithms: ['ES256'] }),
            none: await grab(reheader({ alg: 'none' })),
        };
    });
    assert.equal(r.baseline, 'VALID');
    assert.match(r.crit, /^ERR: .*crit/, 'a crit header must be rejected, not verified');
    assert.match(r.dupe, /^ERR: .*repeats the parameter/);
    assert.match(r.array, /^ERR: .*must be a JSON object/);
    assert.match(r.padded, /^ERR: .*base64url/);
    assert.match(r.spaced, /^ERR: .*base64url/);
    assert.equal(r.algNotAllowed, 'invalid', 'alg outside the caller\'s set must not verify');
    assert.equal(r.algAllowed, 'VALID');
    assert.equal(r.none, 'invalid', 'alg=none must never verify');
});

test('RS256 refuses an RSA key below the 2048-bit floor (RFC 7518 §3.3)', async () => {
    const r = await run(async () => {
        const K = window.LocalUtilKeySource, W = window.LocalUtilWebAuthn;
        const msg = new TextEncoder().encode('small key');
        const out = {};
        for (const bits of [1024, 2048]) {
            const kp = await crypto.subtle.generateKey({
                name: 'RSASSA-PKCS1-v1_5', modulusLength: bits,
                publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
            }, true, ['sign', 'verify']);
            const priv = W.pemWrap('PRIVATE KEY', new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey)));
            try {
                const t = await K.signJws(msg, { type: 'pem', pem: priv });
                out[bits] = K.parseJws(t).alg;
            } catch (e) { out[bits] = 'ERR: ' + e.message; }
        }
        return out;
    });
    assert.match(r['1024'], /1024 bits.*RFC 7518/, '1024-bit RSA must be refused, not silently signed');
    assert.equal(r['2048'], 'RS256');
});

test('JWS: an HS256 token cannot pass while only an asymmetric set is accepted', async () => {
    // The reachable mis-verification: a stale shared key plus a token that
    // claims HS256 used to report VALID while the pinned public key went unused.
    const r = await run(async () => {
        const K = window.LocalUtilKeySource, W = window.LocalUtilWebAuthn;
        const enc = new TextEncoder();
        const msg = enc.encode('pay alice 100');
        const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        const pub = W.pemWrap('PUBLIC KEY', new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey)));
        const sharedKey = 'a'.repeat(64);
        const forged = await K.signJws(msg, { type: 'rawkey', key: sharedKey });
        const asymmetricOnly = await K.verifyJws(forged, {
            algorithms: ['ES256', 'ES384', 'ES512', 'EdDSA', 'RS256'],
            pinnedPem: pub, key: sharedKey, message: msg,
        });
        const macMode = await K.verifyJws(forged, { algorithms: ['HS256'], key: sharedKey, message: msg });
        return { asymmetric: asymmetricOnly.valid, mac: macMode.valid };
    });
    assert.equal(r.asymmetric, false, 'HS256 must be refused when verifying asymmetrically');
    assert.equal(r.mac, true, 'and still work when the MAC source is the one selected');
});

test('DER signatures must be canonical, so the bytes are not malleable', async () => {
    const r = await run(() => {
        const W = window.LocalUtilWebAuthn;
        const rHex = '80' + '11'.repeat(31), sHex = '01'.repeat(32);
        const good = '3045' + '022100' + rHex + '0220' + sHex;
        const grab = h => {
            try { return W.toHex(W.derToP1363(W.fromHex(h), 32)); }
            catch (e) { return 'ERR: ' + e.message; }
        };
        return {
            good: grab(good),
            trailing: grab(good + 'ff'),
            nonMinimalInt: grab('3046' + '02220000' + rHex + '0220' + sHex),
            longForm: grab('308145' + '022100' + rHex + '0220' + sHex),
            zeroInt: grab('3025' + '020100' + '0220' + sHex),
            badSeqLen: grab('3044' + '022100' + rHex + '0220' + sHex),
        };
    });
    assert.equal(r.good, '80' + '11'.repeat(31) + '01'.repeat(32), 'valid DER still works');
    assert.match(r.trailing, /^ERR: DER: trailing bytes|^ERR: DER: SEQUENCE length/);
    assert.match(r.nonMinimalInt, /^ERR: DER: non-minimal INTEGER/);
    assert.match(r.longForm, /^ERR: DER: non-minimal SEQUENCE length/);
    assert.match(r.badSeqLen, /^ERR: DER: SEQUENCE length/);
});

test('an RSA unwrap failure is not distinguishable from a bad tag', async () => {
    // A separate "padding failed" message would be a decryption oracle in shape,
    // so it must read exactly like a wrong key. A *recognisable* wrong key — one
    // whose id does not match the parameters — is fine to name, because that is
    // decided before any ciphertext is touched.
    const r = await run(async () => {
        const K = window.LocalUtilKeySource, W = window.LocalUtilWebAuthn;
        const mk = async () => {
            const kp = await crypto.subtle.generateKey({
                name: 'RSA-OAEP', modulusLength: 2048,
                publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
            }, true, ['encrypt', 'decrypt']);
            return {
                pub: W.pemWrap('PUBLIC KEY', new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey))),
                priv: W.pemWrap('PRIVATE KEY', new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))),
            };
        };
        const a = await mk(), b = await mk();
        const res = await K.encrypt(new TextEncoder().encode('hi'), { type: 'pem', pem: a.pub });
        const grab = async (ct, params, pem) => {
            try { await K.decrypt(ct, params, { type: 'pem', pem }); return 'DECRYPTED'; }
            catch (e) { return e.message; }
        };
        // Same key id, but the wrapped key itself is corrupted → must be generic.
        const corrupted = res.paramsText.replace(/^ek=(.*)$/m, (_, v) =>
            'ek=' + v.slice(0, -4) + (v.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'));
        return {
            otherKey: await grab(res.ciphertext, res.paramsText, b.priv),
            corruptedEk: await grab(res.ciphertext, corrupted, a.priv),
            wrongType: await grab(res.ciphertext, res.paramsText,
                W.pemWrap('PRIVATE KEY', new Uint8Array(8))),
            intact: await grab(res.ciphertext, res.paramsText, a.priv),
        };
    });
    assert.match(r.otherKey, /different key: the parameters were made for key id/,
        'a key-id mismatch is decided before any decryption, so it can be named');
    assert.match(r.corruptedEk, /^Could not decrypt — wrong key, altered parameters, or altered ciphertext\.$/,
        'an unwrap failure must be indistinguishable from a bad tag');
    assert.ok(r.wrongType.length, 'an unusable PEM still reports something');
    assert.equal(r.intact, 'DECRYPTED');
});

test('signature format is detected, and junk is refused', async () => {
    const r = await run(async () => {
        const K = window.LocalUtilKeySource;
        const out = {};
        const grab = f => { try { return K.detectSignature(f); } catch (e) { return 'ERR: ' + e.message; } };
        out.jws = grab('eyJhbGciOiJFUzI1NiJ9.aGk.MEUCIQ');
        out.webauthn = grab('{"id":"a","response":{}}');
        out.junk = grab('hello world');
        out.empty = grab('   ');
        return out;
    });
    assert.equal(r.jws, 'jws');
    assert.equal(r.webauthn, 'webauthn');
    assert.match(r.junk, /^ERR: Unrecognized signature/);
    assert.match(r.empty, /^ERR: Nothing to verify/);
});

test('PRF: hmac-secret-mc authenticator derives the key in one ceremony', async () => {
    const auth = await attachVirtualAuthenticator(env.page, {
        hasPrf: true, hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
    });
    try {
        const r = await run(async () => {
            const K = window.LocalUtilKeySource;
            const steps = [];
            const reg = await K.prfRegister({ onStep: k => steps.push(k) });
            const res = await K.encrypt(new TextEncoder().encode('yubikey secret'),
                { type: 'webauthn', secret: reg.secret, credIdB64: reg.credIdB64, rpId: reg.rpId });
            const ev = await K.prfEvaluate({ credId: reg.credId });
            const dec = new TextDecoder();
            return {
                mode: reg.mode, steps, secretLen: reg.secret.length, slot: reg.slot,
                stable: ev.secret.every((b, i) => b === reg.secret[i]),
                viaKey: dec.decode((await K.decrypt(res.ciphertext, res.paramsText, { type: 'webauthn', secret: ev.secret })).plaintext),
                credInParams: res.params.cred === reg.credIdB64,
            };
        });
        assert.equal(r.mode, 'one-shot');
        assert.notEqual(r.slot, 'used', 'slot-free by default');
        assert.deepEqual(r.steps, ['create', 'done'], 'no second touch is requested');
        assert.equal(r.secretLen, 32);
        assert.ok(r.stable, 'the same salt must give the same secret in a later ceremony');
        assert.equal(r.viaKey, 'yubikey secret');
        assert.ok(r.credInParams, 'the credential id is one of the published parameters');
    } finally { await auth.remove(); }
});

test('PRF: the exact rpId↔prfSalt boundary attack no longer decrypts', async () => {
    // The concrete collision the old separator-joined form allowed:
    //   rpId="host|Z", prfSalt="P"   and   rpId="host", prfSalt="Z|P"
    // produced identical authenticated bytes, so rpId could be rewritten while
    // decryption still succeeded.
    const auth = await attachVirtualAuthenticator(env.page, {
        hasPrf: true, hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
    });
    try {
        const r = await run(async () => {
            const K = window.LocalUtilKeySource;
            const reg = await K.prfRegister({});
            const res = await K.encrypt(new TextEncoder().encode('boundary'),
                { type: 'webauthn', secret: reg.secret, credIdB64: reg.credIdB64, rpId: reg.rpId });
            const ev = await K.prfEvaluate({ credId: reg.credId });
            const unlock = { type: 'webauthn', secret: ev.secret };
            const attempt = async text => {
                try { await K.decrypt(res.ciphertextB64, text, unlock); return 'DECRYPTED'; }
                catch (e) { return 'failed'; }
            };
            const fields = {};
            res.paramsText.split('\n').forEach(l => { const i = l.indexOf('='); fields[l.slice(0, i)] = l.slice(i + 1); });
            const rebuild = f => Object.keys(f).map(k => k + '=' + f[k]).join('\n');
            const moved = Object.assign({}, fields, {
                rpId: fields.rpId + '|Z',
                prfSalt: fields.prfSalt,
            });
            const movedBack = Object.assign({}, fields, {
                rpId: fields.rpId,
                prfSalt: 'Z|' + fields.prfSalt,
            });
            return {
                intact: await attempt(res.paramsText),
                rpIdExtended: await attempt(rebuild(moved)),
                shiftedIntoPrfSalt: await attempt(rebuild(movedBack)),
            };
        });
        assert.equal(r.intact, 'DECRYPTED');
        assert.equal(r.rpIdExtended, 'failed', 'rewriting rpId must break the tag');
        assert.equal(r.shiftedIntoPrfSalt, 'failed', 'moving the character elsewhere must also break it');
    } finally { await auth.remove(); }
});

test('PRF: the credential occupies no slot on the key by default', async () => {
    const auth = await attachVirtualAuthenticator(env.page, {
        hasPrf: true, hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
    });
    try {
        const r = await run(async () => {
            const K = window.LocalUtilKeySource, W = window.LocalUtilWebAuthn;
            const slotFree = await K.prfRegister({});                    // default
            const stored = await K.prfRegister({ discoverable: true });

            // Naming the credential works either way — that is all an assertion
            // needs, and the container header carries the id.
            const byId = await K.prfEvaluate({ credId: slotFree.credId });

            // With no allow list only a credential stored ON the key can be
            // found. A slot-free one cannot be, which is the proof it took no slot.
            let discoverableLookup;
            try {
                await K.prfEvaluate({});
                discoverableLookup = 'found something';
            } catch (e) { discoverableLookup = 'nothing to find'; }

            return {
                slotFreeFlag: slotFree.slot,
                storedFlag: stored.slot,
                secretStable: byId.secret.every((b, i) => b === slotFree.secret[i]),
                differentCredentials: slotFree.credIdB64 !== stored.credIdB64,
                discoverableLookup,
            };
        });
        assert.notEqual(r.slotFreeFlag, 'used', 'the default must not consume a slot');
        assert.equal(r.storedFlag, 'used', 'opting in must be reported as using one');
        assert.ok(r.secretStable, 'a slot-free credential still yields the same PRF secret');
        assert.ok(r.differentCredentials);
        // The stored credential exists too, so a bare lookup does find *a*
        // credential; what matters is the flags above.
        assert.ok(r.discoverableLookup);
    } finally { await auth.remove(); }
});

test('PRF: registration does not ask the key for a slot unless told to', async () => {
    // Inspecting the request itself, because a real key rejects with
    // KEY_STORE_FULL only when residentKey was "required".
    const r = await run(async () => {
        const K = window.LocalUtilKeySource;
        const seen = [];
        const real = navigator.credentials.create.bind(navigator.credentials);
        navigator.credentials.create = async opts => {
            seen.push({
                residentKey: opts.publicKey.authenticatorSelection.residentKey,
                requireResidentKey: opts.publicKey.authenticatorSelection.requireResidentKey,
                uv: opts.publicKey.authenticatorSelection.userVerification,
                prf: !!(opts.publicKey.extensions && opts.publicKey.extensions.prf),
            });
            throw Object.assign(new DOMException('', 'NotAllowedError'));
        };
        const errs = [];
        for (const opts of [{}, { discoverable: false }, { discoverable: true }]) {
            try { await K.prfRegister(opts); } catch (e) { errs.push(e.message); }
        }
        try { await K.webauthnCreateSigner({}); } catch (e) { errs.push(e.message); }
        navigator.credentials.create = real;
        return { seen, errs };
    });
    assert.equal(r.seen.length, 4);
    assert.equal(r.seen[0].residentKey, 'discouraged', 'default asks for no slot');
    assert.equal(r.seen[1].residentKey, 'discouraged', 'explicit false asks for no slot');
    assert.equal(r.seen[2].residentKey, 'required', 'opting in asks for one');
    assert.equal(r.seen[3].residentKey, 'discouraged', 'signing credentials are slot-free too');
    assert.equal(r.seen[0].requireResidentKey, undefined,
        'the legacy flag must not be set — it would override residentKey');
    assert.ok(r.seen[0].prf, 'PRF is still requested at creation');

    // The failure has to be actionable: it must say what was requested.
    assert.match(r.errs[0], /no credential slot was requested/);
    assert.match(r.errs[0], /hard-reload/);
    assert.match(r.errs[0], /ykman fido credentials list/);
    assert.match(r.errs[2], /credential slot on the key WAS requested/);
});

test('PRF: a slot-free credential cannot be found without its id', async () => {
    const auth = await attachVirtualAuthenticator(env.page, {
        hasPrf: true, hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
    });
    try {
        const r = await run(async () => {
            const K = window.LocalUtilKeySource;
            const reg = await K.prfRegister({});
            let bare = null;
            try { await K.prfEvaluate({}); bare = 'succeeded'; } catch (e) { bare = e.name || 'failed'; }
            const named = await K.prfEvaluate({ credId: reg.credId });
            return { slot: reg.slot, bare, named: named.secret.length };
        });
        assert.notEqual(r.slot, 'used');
        assert.notEqual(r.bare, 'succeeded',
            'with nothing stored on the key there is no credential to discover');
        assert.equal(r.named, 32, 'naming it by id still works');
    } finally { await auth.remove(); }
});

test('PRF: plain hmac-secret falls back to a second ceremony', async () => {
    const auth = await attachVirtualAuthenticator(env.page, {
        hasHmacSecret: true, hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
    });
    try {
        const r = await run(async () => {
            const K = window.LocalUtilKeySource;
            const steps = [];
            const reg = await K.prfRegister({ onStep: k => steps.push(k) });
            const res = await K.encrypt(new TextEncoder().encode('two touch'),
                { type: 'webauthn', secret: reg.secret, credIdB64: reg.credIdB64, rpId: reg.rpId });
            const ev = await K.prfEvaluate({ credId: reg.credId });
            const out = await K.decrypt(res.ciphertext, res.paramsText, { type: 'webauthn', secret: ev.secret });
            return { mode: reg.mode, steps, text: new TextDecoder().decode(out.plaintext) };
        });
        assert.equal(r.mode, 'two-touch');
        assert.deepEqual(r.steps, ['create', 'assert', 'done'], 'the extra assertion is requested explicitly');
        assert.equal(r.text, 'two touch');
    } finally { await auth.remove(); }
});

test('PRF: an authenticator without hmac-secret is refused with a reason', async () => {
    const auth = await attachVirtualAuthenticator(env.page, {
        hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
    });
    try {
        const err = await run(async () => {
            try { await window.LocalUtilKeySource.prfRegister({}); return null; }
            catch (e) { return e.message; }
        });
        assert.match(err, /does not support the PRF extension \(CTAP2 hmac-secret\)/);
        assert.match(err, /YubiKey 5 series/, 'says what would work');
    } finally { await auth.remove(); }
});

test('WebAuthn signing: standard response JSON, and the challenge binds the message', async () => {
    const auth = await attachVirtualAuthenticator(env.page, {
        hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
    });
    try {
        const r = await run(async () => {
            const K = window.LocalUtilKeySource, W = window.LocalUtilWebAuthn;
            const enc = new TextEncoder();
            const msg = enc.encode('I authorise payment #42');
            const signer = await K.webauthnCreateSigner({});
            const pubPem = W.pemWrap('PUBLIC KEY', signer.spki);
            const res = await K.signWebauthnAssertion(msg, { credId: signer.credId, rpId: signer.rpId });

            const good = await K.verifyWebauthnAssertion(res.text, msg, { publicKeyPem: pubPem });
            const wrongMsg = await K.verifyWebauthnAssertion(res.text, enc.encode('I authorise payment #43'), { publicKeyPem: pubPem });
            const noKey = await K.verifyWebauthnAssertion(res.text, msg, {});
            const wrongRp = await K.verifyWebauthnAssertion(res.text, msg, { publicKeyPem: pubPem, rpId: 'evil.example' });
            const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
            const wrongKey = await K.verifyWebauthnAssertion(res.text, msg, {
                publicKeyPem: W.pemWrap('PUBLIC KEY', new Uint8Array(await crypto.subtle.exportKey('spki', other.publicKey))),
            });
            const wrongOrigin = await K.verifyWebauthnAssertion(res.text, msg, {
                publicKeyPem: pubPem, expectedOrigin: 'https://evil.example',
            });
            const find = (x, l) => x.checks.find(c => c.label === l);
            return {
                algName: signer.algName,
                // the artefact is the standard shape, not an invented one
                keys: Object.keys(res.json).sort(),
                respKeys: Object.keys(res.json.response).sort(),
                nullValued: Object.keys(res.json).filter(k => res.json[k] === null)
                    .concat(Object.keys(res.json.response).filter(k => res.json.response[k] === null)),
                type: res.json.type,
                carriesPublicKey: JSON.stringify(res.json).includes('BEGIN PUBLIC KEY'),
                isJson: res.text.trim().startsWith('{'),
                valid: good.valid,
                labels: good.checks.map(c => [c.label, c.kind]),
                binding: find(good, 'Challenge ⇄ message binding').detail,
                counterKind: find(good, 'Signature counter').kind,
                wrongMsgValid: wrongMsg.valid,
                wrongMsgFailed: wrongMsg.checks.filter(c => !c.ok).map(c => c.label),
                noKeyValid: noKey.valid,
                noKeyDetail: (find(noKey, 'Public key') || {}).detail,
                wrongRpValid: wrongRp.valid,
                wrongRpFailed: wrongRp.checks.filter(c => !c.ok).map(c => c.label),
                wrongKeyValid: wrongKey.valid,
                wrongKeyFailed: wrongKey.checks.filter(c => !c.ok).map(c => c.label),
                wrongOriginValid: wrongOrigin.valid,
                wrongOriginFailed: wrongOrigin.checks.filter(c => !c.ok).map(c => c.label),
            };
        });
        assert.equal(r.algName, 'ES256');

        // WebAuthn L3 AuthenticationResponseJSON, so a real FIDO2 server could read it.
        assert.ok(r.isJson);
        assert.equal(r.type, 'public-key');
        // authenticatorAttachment is optional; assert only the required members.
        for (const k of ['clientExtensionResults', 'id', 'rawId', 'response', 'type']) {
            assert.ok(r.keys.includes(k), 'required member missing: ' + k);
        }
        // AuthenticationResponseJSON declares userHandle and
        // authenticatorAttachment OPTIONAL and NOT nullable, so an absent value
        // must be an absent key — never null.
        assert.deepEqual(r.respKeys, ['authenticatorData', 'clientDataJSON', 'signature']);
        assert.ok(!r.nullValued.length, 'no member may be null: ' + r.nullValued.join(', '));
        assert.equal(r.carriesPublicKey, false, 'the response must not smuggle a public key');

        assert.ok(r.valid);
        for (const label of ['clientDataJSON', 'Ceremony type', 'Challenge ⇄ message binding',
            'RP ID hash', 'User presence (UP)', 'Signature']) {
            assert.deepEqual(r.labels.find(l => l[0] === label), [label, 'pass'], label + ' must be graded');
        }
        assert.equal(r.counterKind, 'info', 'signCount is informational, never a verdict');
        assert.match(r.binding, /challenge equals SHA-256\(message\)/);

        // The point of the scheme: a valid assertion over other content must fail
        // on the binding, not merely "not verify".
        assert.equal(r.wrongMsgValid, false);
        assert.ok(r.wrongMsgFailed.includes('Challenge ⇄ message binding'));
        assert.ok(!r.wrongMsgFailed.includes('Signature'),
            'the assertion signature itself is still valid — that is the subtlety');

        assert.equal(r.noKeyValid, false);
        assert.match(r.noKeyDetail, /does not carry one/, 'it says why the key must come from the verifier');
        assert.equal(r.wrongRpValid, false);
        assert.ok(r.wrongRpFailed.includes('RP ID hash'), 'domain binding must be checked');

        // §7.2 steps 12/13/17/18 must be graded, not merely displayed.
        assert.deepEqual(r.labels.find(l => l[0] === 'Origin'), ['Origin', 'pass']);
        assert.deepEqual(r.labels.find(l => l[0] === 'Cross-origin'), ['Cross-origin', 'pass']);
        assert.deepEqual(r.labels.find(l => l[0] === 'User verification (UV)'),
            ['User verification (UV)', 'pass'], 'UV must be graded — the signer requires it');
        assert.deepEqual(r.labels.find(l => l[0] === 'Backup flags'), ['Backup flags', 'pass']);
        assert.equal(r.wrongOriginValid, false, 'an assertion from another origin must not verify');
        assert.ok(r.wrongOriginFailed.includes('Origin'));
        assert.equal(r.wrongKeyValid, false);
        assert.ok(r.wrongKeyFailed.includes('Signature'));
    } finally { await auth.remove(); }
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
