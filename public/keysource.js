// Key sources, ciphertext/parameter handling and signature formats shared by
// encrypt.html and sign.html.
//
// The unifying idea: every source derives the AES-256-GCM key itself, so whatever
// locked the data is exactly what unlocks it. Encryption hands back the
// ciphertext and the derivation parameters as two separate things — the
// ciphertext is pure AES-GCM output and says nothing about how it was made,
// while salt, iteration count and IV are agreed out of band. They stay
// cryptographically bound as the GCM additional data. (RSA-OAEP is the one
// source whose parameters must include a wrapped key; see sealKey.)
//
// Signatures use standard formats only: compact JWS (RFC 7515) for key-based
// signing, and the WebAuthn authentication response JSON for security keys.
//
// Exposed as window.LocalUtilKeySource.
(function () {
    'use strict';

    const W = window.LocalUtilWebAuthn;
    const { bytesOf, b64urlEncode, b64urlDecode, fromHex, sha256, randomBytes } = W;

    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const utf8 = s => enc.encode(s);

    /* ============================================================
       tunables — published with the ciphertext's parameters, so they can be raised
       ============================================================ */
    // Constant on purpose. Per-message separation is HKDF's salt, not this one;
    // a fixed PRF salt is what lets create() evaluate the PRF in the same
    // ceremony on hmac-secret-mc authenticators (YubiKey firmware 5.8+),
    // turning registration into a single touch.
    const PRF_SALT = utf8('localutil/prf/v1');
    const PBKDF2_ITERS = 600000;              // OWASP 2025 guidance, ~50ms
    // PBKDF2 runs on the main thread, so a count supplied by someone else is a
    // freeze risk. ~10M is roughly a second on current hardware.
    const MAX_PBKDF2_ITERS = 10000000;
    const ENC_INFO = 'localutil/encrypt/v1';
    // Domain-separation tag for the authenticated parameter form. It is never
    // emitted anywhere — it only keeps this tool's AAD distinct from anyone
    // else's, so it is not a format marker and not a claim of a standard.
    const AAD_TAG = 'LUENC1';

    /* ============================================================
       WebCrypto helpers. Three non-obvious constraints are load-bearing here:
       KDF key material must be extractable:false, HKDF requires BOTH salt and
       info, and ECDH public keys must be imported with usages:[].
       ============================================================ */
    async function hkdfKey(ikm, salt, info) {
        const base = await crypto.subtle.importKey('raw', bytesOf(ikm), 'HKDF', false, ['deriveKey']);
        return crypto.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt: bytesOf(salt), info: utf8(info) },
            base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }

    async function pbkdf2Key(password, salt, iters) {
        const base = await crypto.subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveKey']);
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', hash: 'SHA-256', salt: bytesOf(salt), iterations: iters },
            base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }

    // Only RSA-OAEP needs a transported content key; every other source derives
    // the body key directly, so there is no key-wrapping step to speak of.
    async function cekToKey(cekBytes) {
        return crypto.subtle.importKey('raw', bytesOf(cekBytes), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    }

    /* ============================================================
       raw key input — hex or base64(url), must land on 32 bytes
       ============================================================ */
    // HS256 accepts 32 bytes "or larger" (RFC 7518 §3.2), so a key produced by
    // another tool with a longer secret must still verify here. The AES-key
    // sources stay at exactly 32 — that is this tool's own choice, not the spec's.
    function parseMacKey(text) {
        const bytes = parseKeyBytes(text);
        if (bytes.length < 32) {
            throw new Error('An HS256 key must be at least 32 bytes (got ' + bytes.length
                + ') — RFC 7518 §3.2 requires at least the hash output size.');
        }
        return bytes;
    }

    function parseKeyBytes(text) {
        const s = String(text || '').trim().replace(/\s+/g, '');
        if (!s) throw new Error('Key is empty.');
        if (/^(0x)?[0-9a-fA-F]+$/.test(s) && s.replace(/^0x/, '').length % 2 === 0) {
            return fromHex(s.replace(/^0x/, ''));
        }
        try { return b64urlDecode(s); } catch (_) {
            throw new Error('Key must be hex or base64 — could not parse either.');
        }
    }

    function parseRawKey(text) {
        const s = String(text || '').trim().replace(/\s+/g, '');
        if (!s) throw new Error('Key is empty.');
        let bytes;
        if (/^(0x)?[0-9a-fA-F]+$/.test(s) && s.replace(/^0x/, '').length % 2 === 0) {
            bytes = fromHex(s.replace(/^0x/, ''));
        } else {
            try { bytes = b64urlDecode(s); } catch (_) {
                throw new Error('Key must be hex or base64 — could not parse either.');
            }
        }
        if (bytes.length !== 32) {
            throw new Error('Key must be exactly 32 bytes (got ' + bytes.length + '). '
                + 'Use the Password Generator in Hex 64 mode for a valid key.');
        }
        return bytes;
    }

    /* ============================================================
       PEM — only SPKI / PKCS#8 are importable by WebCrypto. The algorithm is
       identified by trial import rather than an ASN.1 OID parse: the set of
       candidates is small and a failed import is the same answer.
       ============================================================ */
    const PEM_RE = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/;

    function parsePem(text) {
        const m = PEM_RE.exec(String(text || '').trim());
        if (!m) throw new Error('Not a PEM block — expected -----BEGIN … ----- / -----END … -----.');
        const label = m[1].trim();
        let der;
        try {
            der = b64urlDecode(m[2].replace(/\s+/g, '').replace(/\+/g, '-').replace(/\//g, '_'));
        } catch (_) { throw new Error('PEM body is not valid base64.'); }
        if (label === 'RSA PUBLIC KEY') {
            throw new Error('PKCS#1 “RSA PUBLIC KEY” is not importable by WebCrypto. Convert it first: '
                + 'openssl rsa -pubin -RSAPublicKey_in -in key.pem -outform PEM -out spki.pem');
        }
        if (label === 'RSA PRIVATE KEY' || label === 'EC PRIVATE KEY') {
            throw new Error(label + ' (PKCS#1/SEC1) is not importable by WebCrypto. Convert to PKCS#8: '
                + 'openssl pkcs8 -topk8 -nocrypt -in key.pem -out pkcs8.pem');
        }
        if (label === 'ENCRYPTED PRIVATE KEY') {
            throw new Error('This private key is passphrase-encrypted. Decrypt it first: '
                + 'openssl pkcs8 -in key.pem -out plain.pem');
        }
        if (label !== 'PUBLIC KEY' && label !== 'PRIVATE KEY') {
            throw new Error('Unsupported PEM type “' + label + '” — expected PUBLIC KEY (SPKI) or PRIVATE KEY (PKCS#8).');
        }
        return { label, der, isPrivate: label === 'PRIVATE KEY' };
    }

    // RFC 7518 §3.3 (RS256) and §4.3 (RSA-OAEP) both require "a key of size 2048
    // bits or larger". WebCrypto happily imports a 512-bit key, so check here.
    function requireRsa2048(key) {
        const bits = key.algorithm && key.algorithm.modulusLength;
        if (typeof bits === 'number' && bits < 2048) {
            throw new Error('RSA key is ' + bits + ' bits. RFC 7518 §3.3 requires 2048 or more for RS256.');
        }
    }

    const EC_CURVES = [
        { crv: 'P-256', bits: 256 },
        { crv: 'P-384', bits: 384 },
        { crv: 'P-521', bits: 528 },   // 521 rounded up to a byte boundary
    ];

    // Identify a PEM and import it for the requested purpose.
    // purpose: 'encrypt' | 'decrypt' | 'sign' | 'verify'
    async function importPem(text, purpose) {
        const { der, isPrivate } = parsePem(text);
        const fmt = isPrivate ? 'pkcs8' : 'spki';
        const wantPrivate = purpose === 'decrypt' || purpose === 'sign';
        if (wantPrivate && !isPrivate) throw new Error('This is a PUBLIC key — ' + purpose + ' needs the PRIVATE key (PKCS#8).');
        if (!wantPrivate && isPrivate) throw new Error('This is a PRIVATE key — ' + purpose + ' needs the PUBLIC key (SPKI).');

        // RSA. The import is attempted inside the try (a failure just means "not
        // an RSA key, try the next type"), but the key-size rule is checked after
        // it — otherwise a real "1024 bits is too small" error would be swallowed
        // as if the PEM simply weren't RSA.
        let rsa = null;
        try {
            if (purpose === 'encrypt' || purpose === 'decrypt') {
                rsa = {
                    kind: 'rsa-oaep', hash: 'SHA-256', label: 'RSA-OAEP · SHA-256',
                    key: await crypto.subtle.importKey(fmt, der, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, [purpose]),
                };
            } else {
                rsa = {
                    kind: 'rsa-pkcs1', hash: 'SHA-256', label: 'RSASSA-PKCS1-v1_5 · SHA-256',
                    key: await crypto.subtle.importKey(fmt, der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, [purpose]),
                };
            }
        } catch (_) { rsa = null; }
        if (rsa) {
            requireRsa2048(rsa.key);
            rsa.der = der;
            return rsa;
        }

        // EC — ECDH for the encryption path, ECDSA for the signing path.
        for (const { crv, bits } of EC_CURVES) {
            try {
                if (purpose === 'encrypt' || purpose === 'decrypt') {
                    // An ECDH public key performs no operation itself; it is an
                    // argument to deriveBits, and any non-empty usage list throws.
                    const usages = isPrivate ? ['deriveBits'] : [];
                    const key = await crypto.subtle.importKey(fmt, der, { name: 'ECDH', namedCurve: crv }, true, usages);
                    return { kind: 'ecdh-es', key, der, crv, bits, label: 'ECDH-ES · ' + crv };
                }
                const hash = crv === 'P-256' ? 'SHA-256' : crv === 'P-384' ? 'SHA-384' : 'SHA-512';
                const key = await crypto.subtle.importKey(fmt, der, { name: 'ECDSA', namedCurve: crv }, true, [purpose]);
                return { kind: 'ecdsa', key, der, crv, bits, hash, label: 'ECDSA · ' + crv + ' · ' + hash };
            } catch (_) { /* try next curve */ }
        }

        // Ed25519 — signing only. There is no Ed25519 key agreement; the
        // equivalent encryption key is X25519, a different key entirely.
        try {
            // Import for a signing usage even on the encrypt/decrypt path, so an
            // Ed25519 key is *recognised* and can be explained, rather than
            // failing the usage check and falling through to a generic error.
            const key = await crypto.subtle.importKey(fmt, der, { name: 'Ed25519' }, true,
                [wantPrivate ? 'sign' : 'verify']);
            if (purpose === 'encrypt' || purpose === 'decrypt') throw new Error('ed25519-no-kex');
            return { kind: 'ed25519', key, der, label: 'Ed25519' };
        } catch (e) {
            if (e && e.message === 'ed25519-no-kex') {
                throw new Error('This is an Ed25519 key, which cannot do key agreement — Ed25519 signs only. '
                    + 'For encryption use an RSA or EC (P-256/384/521) key, or a different source.');
            }
        }

        throw new Error('Could not import this PEM for ' + purpose
            + ' — unsupported algorithm, or the key does not allow this operation.');
    }

    async function keyId(der) {
        return b64urlEncode((await sha256(der)).slice(0, 8));
    }

    /* ============================================================
       WebAuthn PRF ceremonies
       ============================================================ */
    function webauthnAvailable() {
        return typeof window.PublicKeyCredential !== 'undefined'
            && !!(navigator.credentials && navigator.credentials.create);
    }

    // WebKit does not pass extension data to roaming authenticators, so a
    // security key can never return PRF output there. That is a platform
    // capability gap, not a bug we can work around.
    function webkitLimitation() {
        const ua = navigator.userAgent || '';
        const isWebKit = /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
        if (!isWebKit) return null;
        const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
        return {
            engine: 'WebKit',
            ios: isIOS,
            reason: isIOS
                ? 'iOS / iPadOS does not pass WebAuthn extension data to or from external security keys at all, '
                  + 'so the PRF extension cannot be used with a YubiKey here.'
                : 'Safari supports the PRF extension only for platform passkeys (iCloud Keychain). It does not '
                  + 'deliver PRF results from external USB / NFC security keys (WebKit #311099, #314934).',
        };
    }

    async function browserPrfCapability() {
        const out = { webauthn: webauthnAvailable(), reported: null, webkit: webkitLimitation() };
        try {
            if (window.PublicKeyCredential && PublicKeyCredential.getClientCapabilities) {
                const caps = await PublicKeyCredential.getClientCapabilities();
                out.reported = !!caps['extension:prf'];
                out.capabilities = caps;
            }
        } catch (_) { /* capability probing is best-effort */ }
        return out;
    }

    // Did this credential consume one of the authenticator's credential slots?
    //   'used'        — stored on the key: it reported rk, or we asked for it
    //   'free'        — the browser explicitly reported rk:false
    //   'unconfirmed' — we asked for non-discoverable and the browser said nothing
    //
    // Chrome returns credProps as {} rather than {rk:false} for non-discoverable
    // credentials, so absence of rk is not proof of anything. The behavioural
    // test is the real one: a credential that isn't on the key cannot be found
    // without naming its id (see keysource.test.mjs).
    function slotUsage(cred, wantedDiscoverable) {
        const props = cred.getClientExtensionResults().credProps;
        const rk = props && typeof props.rk === 'boolean' ? props.rk : null;
        if (rk === true || wantedDiscoverable) return 'used';
        return rk === false ? 'free' : 'unconfirmed';
    }

    // WebAuthn rejects with bare DOMExceptions whose message is usually empty —
    // the browser puts the real reason ("your security key doesn't have enough
    // space") in its own UI, not in the exception. So say what we asked for, and
    // name the cases a user can act on.
    function registrationError(e, wantedDiscoverable) {
        const name = (e && e.name) || 'Error';
        const detail = (e && e.message || '').trim();
        const asked = wantedDiscoverable
            ? 'residentKey: "required" — a credential slot on the key WAS requested'
            : 'residentKey: "discouraged" — no credential slot was requested';
        if (name === 'InvalidStateError') {
            return new Error('This security key already has a credential for this site. Use that one, or remove it '
                + 'with: ykman fido credentials delete');
        }
        if (name === 'NotAllowedError') {
            return new Error('The key declined, or the ceremony was cancelled or timed out.'
                + (detail ? ' (' + detail + ')' : '')
                + ' If the browser said the key is out of space: this request used ' + asked
                + ', so storage should not have blocked it — a stale cached copy of this page is the likely cause, '
                + 'so hard-reload and try again. Otherwise list what the key is storing with '
                + '“ykman fido credentials list” and delete what you no longer need.');
        }
        return new Error(name + (detail ? ': ' + detail : '') + ' — request used ' + asked + '.');
    }

    // Registration. Asks for PRF at create() time — required both to make the
    // authenticator generate the PRF seed at all, and to give hmac-secret-mc
    // devices the chance to return the secret in this same ceremony.
    //
    // opts.discoverable (default false): a discoverable credential is stored on
    // the authenticator and consumes one of its limited slots. We don't need
    // that — the credential id travels in the container header, which is all an
    // assertion needs. PRF works either way (hmac-secret is not tied to
    // discoverability), so the default costs the key nothing.
    async function prfRegister(opts) {
        opts = opts || {};
        const onStep = opts.onStep || function () {};
        if (!webauthnAvailable()) throw new Error('This browser has no WebAuthn support.');

        onStep('create', 'Touch your security key to create a credential…');
        let cred;
        try {
            cred = await navigator.credentials.create({
            publicKey: {
                rp: { name: 'LocalUtil', id: opts.rpId || location.hostname },
                user: {
                    id: randomBytes(16),
                    name: opts.userName || 'localutil',
                    displayName: opts.userName || 'LocalUtil encryption key',
                },
                challenge: randomBytes(32),
                pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }],
                authenticatorSelection: {
                    authenticatorAttachment: opts.attachment || undefined,
                    residentKey: opts.discoverable ? 'required' : 'discouraged',
                    userVerification: 'required',
                },
                timeout: 120000,
                // credProps tells us what the authenticator actually did:
                // "discouraged" is a preference, and some devices store the
                // credential anyway.
                extensions: { prf: { eval: { first: PRF_SALT } }, credProps: true },
            },
            });
        } catch (e) { throw registrationError(e, !!opts.discoverable); }
        if (!cred) throw new Error('Registration was cancelled.');

        const ext = cred.getClientExtensionResults().prf;
        if (!ext || ext.enabled === false) {
            throw new Error('This authenticator does not support the PRF extension (CTAP2 hmac-secret), '
                + 'so it cannot derive an encryption key. YubiKey 5 series keys do support it.');
        }

        const credId = new Uint8Array(cred.rawId);
        const out = {
            credId, credIdB64: b64urlEncode(credId), rpId: opts.rpId || location.hostname,
            slot: slotUsage(cred, opts.discoverable),
        };

        if (ext.results && ext.results.first) {
            // hmac-secret-mc: the secret came back with the credential.
            out.secret = new Uint8Array(ext.results.first);
            out.mode = 'one-shot';
            onStep('done', 'Done in a single touch — this authenticator supports hmac-secret-mc (YubiKey firmware 5.8+).');
            return out;
        }

        // Plain hmac-secret returns the secret only during an assertion.
        out.mode = 'two-touch';
        onStep('assert', 'Key registered. Touch it once more to derive the encryption key…');
        const ev = await prfEvaluate({ credId, rpId: out.rpId, onStep: function () {} });
        out.secret = ev.secret;
        onStep('done', 'Done. This authenticator returns PRF output during assertions, so registration took two touches.');
        return out;
    }

    async function prfEvaluate(opts) {
        const onStep = (opts && opts.onStep) || function () {};
        if (!webauthnAvailable()) throw new Error('This browser has no WebAuthn support.');
        onStep('assert', 'Touch your security key…');
        const allow = opts && opts.credId ? [{ type: 'public-key', id: bytesOf(opts.credId) }] : [];
        const asr = await navigator.credentials.get({
            publicKey: {
                challenge: randomBytes(32),
                rpId: (opts && opts.rpId) || location.hostname,
                allowCredentials: allow,
                userVerification: 'required',
                timeout: 120000,
                extensions: { prf: { eval: { first: PRF_SALT } } },
            },
        });
        if (!asr) throw new Error('The ceremony was cancelled.');
        const ext = asr.getClientExtensionResults().prf;
        if (!ext || !ext.results || !ext.results.first) {
            const wk = webkitLimitation();
            throw new Error('No PRF output was returned. '
                + (wk ? wk.reason : 'The authenticator or browser did not evaluate the PRF extension.'));
        }
        if (opts && opts.expectCredId && !W.bytesEqual(new Uint8Array(asr.rawId), bytesOf(opts.expectCredId))) {
            throw new Error('A different credential was used than the one this container was locked with.');
        }
        return {
            secret: new Uint8Array(ext.results.first),
            credId: new Uint8Array(asr.rawId),
            credIdB64: b64urlEncode(new Uint8Array(asr.rawId)),
        };
    }

    // Signing needs no extensions at all — just a credential whose public key we
    // keep, so the signature can be verified by someone who wasn't there. The
    // public key is only ever exposed at creation time, which is why this is a
    // separate step from signing.
    async function webauthnCreateSigner(opts) {
        opts = opts || {};
        const onStep = opts.onStep || function () {};
        if (!webauthnAvailable()) throw new Error('This browser has no WebAuthn support.');
        onStep('create', 'Touch your security key to create a signing credential…');
        let cred;
        try {
            cred = await navigator.credentials.create({
            publicKey: {
                rp: { name: 'LocalUtil', id: opts.rpId || location.hostname },
                user: {
                    id: randomBytes(16),
                    name: opts.userName || 'localutil-signer',
                    displayName: opts.userName || 'LocalUtil signing key',
                },
                challenge: randomBytes(32),
                // ES256 first, Ed25519 second: both verify in WebCrypto, and a
                // modern YubiKey has no RSA in its FIDO2 applet anyway.
                pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }],
                authenticatorSelection: {
                    authenticatorAttachment: opts.attachment || undefined,
                    // Slot-free by default: the credential id and public key are
                    // kept by this page, which is all a signature needs.
                    residentKey: opts.discoverable ? 'required' : 'discouraged',
                    userVerification: 'required',
                },
                timeout: 120000,
                extensions: { credProps: true },
            },
            });
        } catch (e) { throw registrationError(e, !!opts.discoverable); }
        if (!cred) throw new Error('Registration was cancelled.');
        const att = W.cborDecode(new Uint8Array(cred.response.attestationObject));
        const parsed = W.parseAuthenticatorData(att.get('authData'));
        if (!parsed.cosePublicKey) throw new Error('The authenticator returned no public key.');
        const info = W.coseToJwk(parsed.cosePublicKey);
        const credId = new Uint8Array(cred.rawId);
        return {
            credId, credIdB64: b64urlEncode(credId),
            rpId: opts.rpId || location.hostname,
            spki: await W.coseToSpki(parsed.cosePublicKey),
            alg: info.alg, algName: W.algName(info.alg),
            slot: slotUsage(cred, opts.discoverable),
        };
    }

    /* ============================================================
       Ciphertext and parameters, kept apart
       ============================================================ */
    // The ciphertext is only the AES-256-GCM output. Everything needed to derive
    // the key again — KDF name, salt, iteration count, IV — is handed back
    // separately, so a stored or transmitted ciphertext carries no hint about how
    // it was made. Two systems agree the parameters out of band, as a contract.
    //
    // They are still cryptographically bound: the canonical form below is the
    // GCM additional data, so decryption fails if the parameters presented do
    // not match the ones used. Keeping them out of the blob costs no integrity.
    const PARAM_ORDER = {
        'WEBAUTHN-PRF': ['v', 'enc', 'kdf', 'iv', 'cred', 'rpId', 'prfSalt', 'hkdfSalt'],
        'PBKDF2-SHA256': ['v', 'enc', 'kdf', 'iv', 'iters', 'salt'],
        'HKDF-SHA256': ['v', 'enc', 'kdf', 'iv', 'hkdfSalt'],
        'ECDH-ES': ['v', 'enc', 'kdf', 'iv', 'crv', 'kid', 'epk', 'hkdfSalt'],
        'RSA-OAEP': ['v', 'enc', 'kdf', 'iv', 'kid', 'ek'],
    };
    const KDF_FOR_UNLOCK = {
        webauthn: ['WEBAUTHN-PRF'], password: ['PBKDF2-SHA256'],
        rawkey: ['HKDF-SHA256'], pem: ['ECDH-ES', 'RSA-OAEP'],
    };
    const KDF_LABELS = {
        'WEBAUTHN-PRF': 'a security key', 'PBKDF2-SHA256': 'a password',
        'HKDF-SHA256': 'a raw key', 'ECDH-ES': 'an EC key pair', 'RSA-OAEP': 'an RSA key pair',
    };

    function paramOrder(p) {
        const order = PARAM_ORDER[p && p.kdf];
        if (!order) throw new Error('Unknown kdf “' + (p && p.kdf) + '” in the parameters.');
        return order;
    }

    // Built from a fixed field order, never from the pasted text, so the ORDER
    // and layout of the lines are irrelevant. Values, however, are authenticated
    // exactly as written: `salt=AAAA` and `salt=AAAA=` decode to the same bytes
    // but are different AADs, so a round trip through a tool that re-pads base64
    // will fail to decrypt. Strict, not forgiving, and deliberately so.
    //
    // Every name and value is length-prefixed. Joining with a separator instead
    // would be ambiguous: rpId="a|b", prfSalt="c" and rpId="a", prfSalt="b|c"
    // serialize identically, which would let a value be moved across a field
    // boundary without changing the tag — breaking the very property this
    // function exists to provide.
    function paramsAad(p) {
        let s = AAD_TAG;
        paramOrder(p).forEach(k => {
            const v = String(p[k]);
            s += '|' + k.length + ':' + k + '=' + v.length + ':' + v;
        });
        return utf8(s);
    }

    // Readable, hand-editable, and stable: one field per line.
    function paramsToText(p) {
        return paramOrder(p).map(k => k + '=' + p[k]).join('\n');
    }

    function paramsFromText(text) {
        const out = {};
        String(text || '').split(/[\r\n;]+/).forEach(line => {
            const t = line.trim();
            if (!t || t.startsWith('#')) return;
            const eq = t.indexOf('=');
            if (eq < 1) throw new Error('Parameter line is not name=value: “' + t.slice(0, 40) + '”');
            out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
        });
        return validateParams(out);
    }

    // Every invariant lives here, so passing an object to decrypt() cannot skip
    // the checks that parsing text would have applied.
    function validateParams(out) {
        if (!out || typeof out !== 'object') throw new Error('No decryption parameters given.');
        if (!Object.keys(out).length) throw new Error('No decryption parameters given.');
        if (!out.kdf) throw new Error('Parameters are missing kdf=…');
        const order = paramOrder(out);
        const missing = order.filter(k => out[k] === undefined);
        if (missing.length) throw new Error('Parameters are missing: ' + missing.join(', '));
        if (out.v !== '1') throw new Error('Unsupported parameter version “' + out.v + '”.');
        if (out.enc !== 'A256GCM') throw new Error('Unsupported algorithm “' + out.enc + '”.');
        if (out.kdf === 'PBKDF2-SHA256') {
            // Strict digits: parseInt would read "1e9" as 1, silently running a
            // single iteration. And an unbounded count is a denial of service —
            // PBKDF2 runs on the main thread.
            if (!/^[0-9]+$/.test(String(out.iters))) {
                throw new Error('iters must be a whole number of decimal digits (got “' + out.iters + '”).');
            }
            const n = parseInt(out.iters, 10);
            if (n < 1) throw new Error('iters must be at least 1.');
            if (n > MAX_PBKDF2_ITERS) {
                throw new Error('iters=' + n + ' is above the ' + MAX_PBKDF2_ITERS.toLocaleString()
                    + ' limit this page will run — it would freeze the tab.');
            }
            out.iters = n;
        }
        return out;
    }

    // spec: {type:'password', password} | {type:'rawkey', key} |
    //       {type:'webauthn', secret, credIdB64, rpId} |
    //       {type:'pem', pem}   (public key — RSA-OAEP or ECDH-ES)
    // Returns {params, key}: params travel separately, key encrypts the body.
    async function sealKey(spec, iv) {
        const base = { v: '1', enc: 'A256GCM', iv: b64urlEncode(iv) };
        if (spec.type === 'webauthn') {
            const hkdfSalt = randomBytes(16);
            const params = Object.assign({}, base, {
                kdf: 'WEBAUTHN-PRF', cred: spec.credIdB64, rpId: spec.rpId,
                prfSalt: b64urlEncode(PRF_SALT), hkdfSalt: b64urlEncode(hkdfSalt),
            });
            return { params, key: await hkdfKey(spec.secret, hkdfSalt, ENC_INFO + ' webauthn') };
        }
        if (spec.type === 'password') {
            if (!spec.password) throw new Error('Password is empty.');
            const salt = randomBytes(16);
            const iters = spec.iters || PBKDF2_ITERS;
            if (!Number.isInteger(iters) || iters < 1 || iters > MAX_PBKDF2_ITERS) {
                throw new Error('iters must be a whole number between 1 and ' + MAX_PBKDF2_ITERS + '.');
            }
            const params = Object.assign({}, base, {
                kdf: 'PBKDF2-SHA256', iters, salt: b64urlEncode(salt),
            });
            return { params, key: await pbkdf2Key(spec.password, salt, params.iters) };
        }
        if (spec.type === 'rawkey') {
            const raw = parseRawKey(spec.key);
            const hkdfSalt = randomBytes(16);
            const params = Object.assign({}, base, { kdf: 'HKDF-SHA256', hkdfSalt: b64urlEncode(hkdfSalt) });
            return { params, key: await hkdfKey(raw, hkdfSalt, ENC_INFO + ' rawkey') };
        }
        if (spec.type === 'pem') {
            const pub = await importPem(spec.pem, 'encrypt');
            const kid = await keyId(pub.der);
            if (pub.kind === 'ecdh-es') {
                // Ephemeral-static agreement: only the ephemeral public key has
                // to be published, and the body key comes from the shared secret.
                const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: pub.crv }, true, ['deriveBits']);
                const epk = new Uint8Array(await crypto.subtle.exportKey('spki', eph.publicKey));
                const hkdfSalt = randomBytes(16);
                const params = Object.assign({}, base, {
                    kdf: 'ECDH-ES', crv: pub.crv, kid,
                    epk: b64urlEncode(epk), hkdfSalt: b64urlEncode(hkdfSalt),
                });
                // Explicit bit length — a null length is not portable.
                const z = new Uint8Array(await crypto.subtle.deriveBits(
                    { name: 'ECDH', public: pub.key }, eph.privateKey, pub.bits));
                return { params, key: await hkdfKey(z, hkdfSalt, ENC_INFO + ' ecdh-es') };
            }
            // RSA-OAEP cannot agree on a key, only transport one, so this is the
            // one source whose parameters include a wrapped key.
            const cekBytes = randomBytes(32);
            const params = Object.assign({}, base, { kdf: 'RSA-OAEP', kid, ek: '' });
            params.ek = b64urlEncode(new Uint8Array(await crypto.subtle.encrypt(
                { name: 'RSA-OAEP', label: utf8(AAD_TAG + '|RSA-OAEP|' + kid) }, pub.key, cekBytes)));
            return { params, key: await cekToKey(cekBytes) };
        }
        throw new Error('Unknown source type “' + spec.type + '”.');
    }

    // The parameters name which public key the data was locked to. Comparing it
    // to the private key offered turns "wrong key" into "that is the wrong key".
    async function requireKeyId(priv, kid) {
        if (!kid) return;
        let mine;
        try {
            const jwk = await crypto.subtle.exportKey('jwk', priv.key);
            ['d', 'p', 'q', 'dp', 'dq', 'qi'].forEach(k => delete jwk[k]);
            delete jwk.key_ops; delete jwk.ext;
            const pub = await crypto.subtle.importKey('jwk', jwk,
                priv.kind === 'ecdh-es' ? { name: 'ECDH', namedCurve: priv.crv } : { name: 'RSA-OAEP', hash: 'SHA-256' },
                true, []);
            mine = await keyId(new Uint8Array(await crypto.subtle.exportKey('spki', pub)));
        } catch (_) { return; }   // can't derive it — fall through to the tag check
        if (mine !== kid) {
            throw new Error('This is a different key: the parameters were made for key id ' + kid
                + ', yours is ' + mine + '.');
        }
    }

    async function openKey(params, unlock) {
        if (params.kdf === 'WEBAUTHN-PRF') {
            // The PRF salt is fixed for this tool; a different one means the
            // secret was evaluated elsewhere, which is worth saying plainly
            // rather than surfacing as an opaque "wrong key".
            if (params.prfSalt !== b64urlEncode(PRF_SALT)) {
                throw new Error('These parameters were made with a different PRF salt ('
                    + params.prfSalt + '), so this page cannot reproduce the key.');
            }
            return hkdfKey(unlock.secret, b64urlDecode(params.hkdfSalt), ENC_INFO + ' webauthn');
        }
        if (params.kdf === 'PBKDF2-SHA256') {
            return pbkdf2Key(unlock.password, b64urlDecode(params.salt), params.iters);
        }
        if (params.kdf === 'HKDF-SHA256') {
            return hkdfKey(parseRawKey(unlock.key), b64urlDecode(params.hkdfSalt), ENC_INFO + ' rawkey');
        }
        if (params.kdf === 'ECDH-ES') {
            const priv = await importPem(unlock.pem, 'decrypt');
            if (priv.kind !== 'ecdh-es') throw new Error('These parameters need an EC private key.');
            await requireKeyId(priv, params.kid);
            if (priv.crv !== params.crv) {
                throw new Error('Curve mismatch — encrypted to ' + params.crv + ', your key is ' + priv.crv + '.');
            }
            const epk = await crypto.subtle.importKey('spki', b64urlDecode(params.epk),
                { name: 'ECDH', namedCurve: params.crv }, false, []);
            const z = new Uint8Array(await crypto.subtle.deriveBits(
                { name: 'ECDH', public: epk }, priv.key, priv.bits));
            return hkdfKey(z, b64urlDecode(params.hkdfSalt), ENC_INFO + ' ecdh-es');
        }
        if (params.kdf === 'RSA-OAEP') {
            const priv = await importPem(unlock.pem, 'decrypt');
            if (priv.kind !== 'rsa-oaep') throw new Error('These parameters need an RSA private key.');
            await requireKeyId(priv, params.kid);
            let cek;
            try {
                cek = new Uint8Array(await crypto.subtle.decrypt(
                    { name: 'RSA-OAEP', label: utf8(AAD_TAG + '|RSA-OAEP|' + params.kid) },
                    priv.key, b64urlDecode(params.ek)));
            } catch (_) {
                // An RSA-OAEP unwrap failure is the one derivation error that must
                // not be distinguishable — reporting "padding failed" separately
                // from "tag failed" would be a decryption oracle in shape.
                throw new Error('Could not decrypt — wrong key, altered parameters, or altered ciphertext.');
            }
            return cekToKey(cek);
        }
        throw new Error('Unknown kdf “' + params.kdf + '”.');
    }

    // → { ciphertext: Uint8Array, ciphertextB64, params, paramsText }
    async function encrypt(plaintext, spec) {
        if (!spec || !spec.type) throw new Error('Choose how to lock this.');
        const iv = randomBytes(12);
        const { params, key } = await sealKey(spec, iv);
        const ct = new Uint8Array(await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, additionalData: paramsAad(params) }, key, bytesOf(plaintext)));
        return { ciphertext: ct, ciphertextB64: b64urlEncode(ct), params, paramsText: paramsToText(params) };
    }

    // ciphertext: Uint8Array, or a base64url / base64 string.
    // params: the object from encrypt(), or the text the user was given.
    async function decrypt(ciphertext, params, unlock) {
        const p = typeof params === 'string' ? paramsFromText(params)
            : validateParams(Object.assign({}, params));
        const wanted = KDF_FOR_UNLOCK[unlock.type] || [];
        if (wanted.indexOf(p.kdf) === -1) {
            throw new Error('These parameters say the data was locked with '
                + (KDF_LABELS[p.kdf] || p.kdf) + ' — unlock it with the same thing.');
        }
        const ct = typeof ciphertext === 'string' ? b64urlDecode(ciphertext) : bytesOf(ciphertext);
        if (!ct.length) throw new Error('The ciphertext is empty.');
        // Decode every base64 parameter before deriving, so a malformed value is
        // reported as a parse error rather than as "wrong key".
        let iv;
        try { iv = b64urlDecode(p.iv); } catch (_) { throw new Error('The iv parameter is not valid base64url.'); }
        if (iv.length !== 12) throw new Error('The iv parameter must be 12 bytes (got ' + iv.length + ').');
        // openKey's own failures are deterministic input problems — a wrong key
        // type, a curve mismatch, an unparseable PEM — and say nothing about the
        // ciphertext, so they are reported verbatim. The one exception that could
        // leak (the RSA-OAEP unwrap) is generalized where it happens.
        const key = await openKey(p, unlock);
        try {
            const pt = new Uint8Array(await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv, additionalData: paramsAad(p) }, key, ct));
            return { plaintext: pt, params: p };
        } catch (_) {
            // GCM cannot tell a wrong key from wrong parameters from edited
            // ciphertext, so name all three.
            throw new Error('Could not decrypt — wrong '
                + (p.kdf === 'PBKDF2-SHA256' ? 'password' : 'key')
                + ', altered parameters, or altered ciphertext.');
        }
    }


    /* ============================================================
       Signatures — standard formats only, no invented container
       ============================================================ */
    // Two artefacts, because they are genuinely two different things:
    //
    //   private key / raw key → JWS compact serialization (RFC 7515)
    //       base64url(header).base64url(payload).base64url(signature)
    //       Readable by jwt.html, jose, python-jwt, anything JOSE.
    //
    //   security key → WebAuthn authentication response JSON (WebAuthn L3
    //       AuthenticationResponseJSON) — exactly what a FIDO2 server receives.
    //       There is no standard "detached WebAuthn signature", and inventing
    //       one buys nothing: this shape is what every RP already parses.
    const JWS_ALG_FOR_CURVE = { 'P-256': 'ES256', 'P-384': 'ES384', 'P-521': 'ES512' };
    const JWS_ALG = {
        ES256: { imp: { name: 'ECDSA', namedCurve: 'P-256' }, op: { name: 'ECDSA', hash: 'SHA-256' } },
        ES384: { imp: { name: 'ECDSA', namedCurve: 'P-384' }, op: { name: 'ECDSA', hash: 'SHA-384' } },
        ES512: { imp: { name: 'ECDSA', namedCurve: 'P-521' }, op: { name: 'ECDSA', hash: 'SHA-512' } },
        EdDSA: { imp: { name: 'Ed25519' }, op: { name: 'Ed25519' } },
        RS256: { imp: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, op: { name: 'RSASSA-PKCS1-v1_5' } },
        HS256: { imp: { name: 'HMAC', hash: 'SHA-256' }, op: { name: 'HMAC' } },
    };

    function jwsAlgOf(priv) {
        if (priv.kind === 'ecdsa') return JWS_ALG_FOR_CURVE[priv.crv];
        if (priv.kind === 'ed25519') return 'EdDSA';
        return 'RS256';
    }

    // WebCrypto's ECDSA output is already the raw r‖s that JWS requires, so
    // unlike a WebAuthn assertion there is no DER unwrapping to do here.
    async function signJws(message, source) {
        let alg, key;
        if (source.type === 'rawkey') {
            alg = 'HS256';
            key = await crypto.subtle.importKey('raw', parseMacKey(source.key),
                { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        } else {
            const priv = await importPem(source.pem, 'sign');
            alg = jwsAlgOf(priv);
            if (!alg) throw new Error('Unsupported curve ' + priv.crv + ' for JWS.');
            key = priv.key;
        }
        const header = b64urlEncode(utf8(JSON.stringify({ alg })));
        const payload = b64urlEncode(bytesOf(message));
        const input = utf8(header + '.' + payload);
        const sig = new Uint8Array(await crypto.subtle.sign(JWS_ALG[alg].op, key, input));
        return header + '.' + payload + '.' + b64urlEncode(sig);
    }

    // Strict per RFC 7515 §5.2: a conformant verifier rejects a token with
    // whitespace, padding or standard-base64 characters rather than repairing it.
    // Being lenient here would mean accepting tokens that jose / python-jwt
    // reject — the opposite of the reason for using a standard format.
    function parseJws(token) {
        const raw = String(token || '').trim();
        const parts = raw.split('.');
        if (parts.length !== 3) {
            throw new Error('Not a compact JWS — expected three dot-separated segments.');
        }
        const rawHeader = W.b64urlDecodeStrict(parts[0], 'JWS header');
        let headerText;
        try {
            // §5.2 step 3 / RFC 8725 §3.7: the header MUST be valid UTF-8 JSON.
            headerText = new TextDecoder('utf-8', { fatal: true }).decode(rawHeader);
        } catch (_) {
            throw new Error('JWS header is not valid UTF-8.');
        }
        let header;
        try { header = JSON.parse(headerText); } catch (_) {
            throw new Error('JWS header is not valid JSON.');
        }
        if (header === null || typeof header !== 'object' || Array.isArray(header)) {
            throw new Error('JWS header must be a JSON object.');
        }
        // §5.2 step 4: duplicate header names are invalid. JSON.parse silently
        // keeps the last, so count them in the source text.
        const names = headerText.match(/"(?:[^"\\]|\\.)*"\s*:/g) || [];
        const seen = new Set();
        for (const n of names) {
            const key = n.replace(/\s*:$/, '');
            if (seen.has(key)) throw new Error('JWS header repeats the parameter ' + key + '.');
            seen.add(key);
        }
        if (typeof header.alg !== 'string' || !header.alg) throw new Error('JWS header has no "alg".');
        // §4.1.11: extensions listed in "crit" MUST be understood. None are.
        if (header.crit !== undefined) {
            throw new Error('JWS header marks extensions critical (crit=' + JSON.stringify(header.crit)
                + '), and this verifier understands none — RFC 7515 §4.1.11 requires rejecting it.');
        }
        return {
            header, alg: header.alg,
            payload: W.b64urlDecodeStrict(parts[1], 'JWS payload'),
            signature: W.b64urlDecodeStrict(parts[2], 'JWS signature'),
            signingInput: utf8(parts[0] + '.' + parts[1]),
        };
    }

    // Recursively base64url any buffers in the client extension outputs, per the
    // toJSON definition in WebAuthn L3 §5.1.
    function encodeExtensionResults(v) {
        if (v instanceof ArrayBuffer) return b64urlEncode(new Uint8Array(v));
        if (ArrayBuffer.isView(v)) return b64urlEncode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        if (Array.isArray(v)) return v.map(encodeExtensionResults);
        if (v && typeof v === 'object') {
            const out = {};
            Object.keys(v).forEach(k => { out[k] = encodeExtensionResults(v[k]); });
            return out;
        }
        return v;
    }

    // The WebAuthn hash-in-challenge trick: an assertion signs
    // authenticatorData ‖ SHA-256(clientDataJSON) and nothing else, so a message
    // can only be committed to through the challenge.
    async function signWebauthnAssertion(message, opts) {
        opts = opts || {};
        const onStep = opts.onStep || function () {};
        const msgHash = await sha256(message);
        onStep('assert', 'Touch your security key to sign…');
        const asr = await navigator.credentials.get({
            publicKey: {
                challenge: msgHash,                    // ← the message binding
                rpId: opts.rpId || location.hostname,
                allowCredentials: opts.credId ? [{ type: 'public-key', id: bytesOf(opts.credId) }] : [],
                userVerification: 'required',
                timeout: 120000,
            },
        });
        if (!asr) throw new Error('Signing was cancelled.');
        // The UA's own serializer is authoritative when it exists (Chrome 132+,
        // Safari 18+, Firefox 135+).
        let json;
        if (typeof asr.toJSON === 'function') {
            json = asr.toJSON();
        } else {
            const id = b64urlEncode(new Uint8Array(asr.rawId));
            const response = {
                clientDataJSON: b64urlEncode(new Uint8Array(asr.response.clientDataJSON)),
                authenticatorData: b64urlEncode(new Uint8Array(asr.response.authenticatorData)),
                signature: b64urlEncode(new Uint8Array(asr.response.signature)),
            };
            // AuthenticationResponseJSON declares userHandle and
            // authenticatorAttachment as OPTIONAL and NOT nullable, so absent
            // means omitted — emitting null makes `'userHandle' in response`
            // true for a value the dictionary does not allow.
            if (asr.response.userHandle) {
                response.userHandle = b64urlEncode(new Uint8Array(asr.response.userHandle));
            }
            json = {
                id, rawId: id, type: asr.type || 'public-key', response,
                // §5.1 requires ArrayBuffer values inside the extension results
                // to be base64url-encoded; JSON.stringify would emit {} for them.
                clientExtensionResults: encodeExtensionResults(asr.getClientExtensionResults()),
            };
            if (asr.authenticatorAttachment) json.authenticatorAttachment = asr.authenticatorAttachment;
        }
        return { json, text: JSON.stringify(json, null, 2) };
    }

    /* ============================================================
       verification — every step reported separately, because "valid" alone
       hides which property actually held
       ============================================================ */
    function chk(label, ok, detail, kind) {
        return { label, ok: !!ok, detail: detail || '', kind: kind || (ok ? 'pass' : 'fail') };
    }

    // 'jws' | 'webauthn' — so the page can accept either without asking.
    function detectSignature(text) {
        const t = String(text || '').trim();
        if (!t) throw new Error('Nothing to verify.');
        if (t.startsWith('{')) return 'webauthn';
        if (t.split('.').length === 3) return 'jws';
        throw new Error('Unrecognized signature — expected a compact JWS (three dot-separated segments) '
            + 'or a WebAuthn authentication response in JSON.');
    }

    // opts: { pinnedPem, key, message, algorithms }
    //   message    — optional; supplying it pins what the payload must contain.
    //   algorithms — the allow-list RFC 8725 §3.1 requires a library to accept
    //                from its caller ("MUST enable the caller to specify a
    //                supported set of algorithms"). Defaults to the closed table.
    async function verifyJws(token, opts) {
        opts = opts || {};
        const checks = [];
        const p = parseJws(token);
        const allowed = opts.algorithms && opts.algorithms.length
            ? opts.algorithms.filter(a => JWS_ALG[a])
            : Object.keys(JWS_ALG);
        const permitted = allowed.indexOf(p.alg) !== -1;
        const spec = permitted ? JWS_ALG[p.alg] : null;
        checks.push(chk('Algorithm', !!spec, permitted
            ? 'alg=' + p.alg
            : 'alg=' + p.alg + ' — not in the accepted set (' + allowed.join(', ') + ')'));
        if (!spec) return { checks, valid: false, alg: p.alg };

        let text = null;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(p.payload); } catch (_) { /* binary */ }
        checks.push(chk('Payload', true,
            p.payload.length + ' bytes' + (text === null ? ' (binary)' : ': ' + text.slice(0, 80)), 'info'));

        if (opts.message !== undefined && opts.message !== null && String(opts.message).length) {
            const want = bytesOf(typeof opts.message === 'string' ? utf8(opts.message) : opts.message);
            const same = W.bytesEqual(want, p.payload);
            checks.push(chk('Payload matches the text you supplied', same, same
                ? 'the token signs exactly this content'
                : 'the token signs different content than the text given'));
        }

        let key;
        try {
            if (p.alg === 'HS256') {
                if (!opts.key) throw new Error('HS256 is a MAC — supply the same 32-byte raw key to check it.');
                key = await crypto.subtle.importKey('raw', parseMacKey(opts.key),
                    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
                checks.push(chk('Secret', true, 'HS256 is symmetric: anyone with this key could have produced '
                    + 'the token, so it proves integrity, not authorship', 'info'));
            } else {
                if (!opts.pinnedPem) throw new Error('Paste the signer’s public key (PEM) to verify this.');
                const { der } = parsePem(opts.pinnedPem);
                key = await crypto.subtle.importKey('spki', der, spec.imp, true, ['verify']);
                if (p.alg === 'RS256') requireRsa2048(key);
                checks.push(chk('Public key', true, 'supplied by you, not by the token — which is what makes '
                    + 'the result say something about the signer', 'info'));
            }
        } catch (e) {
            checks.push(chk('Key', false, e.message));
            return { checks, valid: false, alg: p.alg, payload: p.payload, text };
        }

        let ok = false;
        try {
            ok = await crypto.subtle.verify(spec.op, key, p.signature, p.signingInput);
        } catch (e) {
            checks.push(chk('Signature', false, e.message));
            return { checks, valid: false, alg: p.alg, payload: p.payload, text };
        }
        checks.push(chk('Signature', ok, p.alg + ' over base64url(header).base64url(payload)'
            + (ok ? '' : ' — does not verify under this key')));
        return {
            checks, valid: checks.every(c => c.ok || c.kind === 'info'),
            alg: p.alg, payload: p.payload, text, mac: p.alg === 'HS256',
        };
    }

    // opts: { publicKeyPem, rpId }
    async function verifyWebauthnAssertion(responseText, message, opts) {
        opts = opts || {};
        const checks = [];
        let res;
        try {
            res = typeof responseText === 'string' ? JSON.parse(responseText) : responseText;
        } catch (_) {
            checks.push(chk('Response JSON', false, 'not valid JSON'));
            return { checks, valid: false };
        }
        const r = res && res.response;
        if (!r || !r.clientDataJSON || !r.authenticatorData || !r.signature) {
            checks.push(chk('Response JSON', false,
                'missing response.clientDataJSON / authenticatorData / signature'));
            return { checks, valid: false };
        }
        checks.push(chk('Response JSON', true,
            'WebAuthn authentication response' + (res.id ? ' · credential ' + String(res.id).slice(0, 16) + '…' : ''),
            'info'));

        const msgHash = await sha256(message);
        let clientData;
        try {
            clientData = JSON.parse(dec.decode(b64urlDecode(r.clientDataJSON)));
            checks.push(chk('clientDataJSON', true, 'parsed as JSON'));
        } catch (_) {
            checks.push(chk('clientDataJSON', false, 'not valid JSON'));
            return { checks, valid: false };
        }
        checks.push(chk('Ceremony type', clientData.type === 'webauthn.get',
            'type = "' + clientData.type + '"'
            + (clientData.type === 'webauthn.get' ? '' : ' — expected webauthn.get')));

        const bound = clientData.challenge === b64urlEncode(msgHash);
        checks.push(chk('Challenge ⇄ message binding', bound, bound
            ? 'challenge equals SHA-256(message) — the signature covers this exact content'
            : 'challenge is ' + String(clientData.challenge).slice(0, 24) + '…, expected '
              + b64urlEncode(msgHash).slice(0, 24) + '… — this signature is NOT over this message'));
        // §7.2 step 12: "Verify that the value of C.origin is an origin expected
        // by the Relying Party." rpIdHash below binds the host, but only origin
        // binds scheme and port — an assertion harvested from https://evil.example
        // must not pass just because the RP ID happens to match.
        const wantOrigin = opts.expectedOrigin || location.origin;
        const originOk = clientData.origin === wantOrigin;
        checks.push(chk('Origin', originOk, originOk
            ? clientData.origin
            : 'made on ' + (clientData.origin || '(absent)') + ', expected ' + wantOrigin));
        // §7.2 step 13: a true crossOrigin means the ceremony ran in an iframe.
        checks.push(chk('Cross-origin', clientData.crossOrigin !== true,
            clientData.crossOrigin === true
                ? 'the ceremony ran inside a cross-origin iframe'
                : 'not a cross-origin ceremony'));
        if (clientData.topOrigin !== undefined) {
            checks.push(chk('Top origin', false,
                'topOrigin=' + clientData.topOrigin + ' — present only for cross-origin ceremonies, '
                + 'which this verifier does not accept'));
        }

        let parsed;
        try {
            parsed = W.parseAuthenticatorData(b64urlDecode(r.authenticatorData));
        } catch (e) {
            checks.push(chk('authenticatorData', false, e.message));
            return { checks, valid: false };
        }
        const rpId = opts.rpId || location.hostname;
        const rpHash = await sha256(utf8(rpId));
        checks.push(chk('RP ID hash', W.bytesEqual(parsed.rpIdHash, rpHash),
            'SHA-256("' + rpId + '") vs authenticatorData — this signature is bound to that domain'));
        checks.push(chk('User presence (UP)', parsed.flags.up, parsed.flags.up
            ? 'the key was physically touched' : 'UP flag not set'));
        // §7.2 step 17. The signer here always requests userVerification:
        // "required", so a graded check is the only way to notice an assertion
        // produced with touch alone — e.g. by a stolen key with no PIN.
        if (opts.requireUserVerification === false) {
            checks.push(chk('User verification (UV)', true,
                parsed.flags.uv ? 'set' : 'not set — not required by this check', 'info'));
        } else {
            checks.push(chk('User verification (UV)', parsed.flags.uv, parsed.flags.uv
                ? 'set — PIN or biometric was checked'
                : 'not set — this credential was signed with touch alone'));
        }
        // §7.2 step 18: "If the BE bit ... is not set, verify that the BS bit is
        // not set." A non-backup-eligible credential cannot be backed up.
        const beBsOk = parsed.flags.be || !parsed.flags.bs;
        checks.push(chk('Backup flags', beBsOk,
            'BE=' + (parsed.flags.be ? 1 : 0) + ' BS=' + (parsed.flags.bs ? 1 : 0)
            + (beBsOk ? '' : ' — BS set without BE is an invalid combination')));
        checks.push(chk('Signature counter', true,
            String(parsed.signCount) + (parsed.signCount === 0 ? ' (0 is normal for platform passkeys)' : '')
            + ' — clone detection only, not proof of anything', 'info'));

        if (!opts.publicKeyPem) {
            checks.push(chk('Public key', false,
                'paste the credential’s public key (PEM) — a WebAuthn response does not carry one, '
                + 'which is exactly why an RP stores it at registration'));
            return { checks, valid: false };
        }
        // The curve is whatever the pinned key actually is — assuming P-256 would
        // make ES384 / ES512 credentials unverifiable.
        let imported = null, ecSize = 0, keyLabel = '';
        try {
            const { der } = parsePem(opts.publicKeyPem);
            const candidates = [];
            Object.keys(W.JWK_EC_CURVES).forEach(crv => candidates.push({
                label: 'ECDSA · ' + crv, size: W.JWK_EC_CURVES[crv].size,
                imp: { name: 'ECDSA', namedCurve: crv },
                op: { name: 'ECDSA', hash: W.JWK_EC_CURVES[crv].hash },
            }));
            candidates.push({ label: 'Ed25519', size: 0, imp: { name: 'Ed25519' }, op: { name: 'Ed25519' } });
            candidates.push({
                label: 'RSASSA-PKCS1-v1_5', size: 0,
                imp: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, op: { name: 'RSASSA-PKCS1-v1_5' },
            });
            for (const c of candidates) {
                try {
                    imported = { key: await crypto.subtle.importKey('spki', der, c.imp, true, ['verify']), op: c.op };
                    ecSize = c.size; keyLabel = c.label;
                    break;
                } catch (_) { /* next candidate */ }
            }
            if (!imported) throw new Error('unsupported public key type');
        } catch (e) {
            checks.push(chk('Public key', false, e.message));
            return { checks, valid: false };
        }
        checks.push(chk('Public key', true, keyLabel + ' — supplied by you', 'info'));

        let ok = false;
        try {
            const signed = await W.assertionSignedBytes(
                b64urlDecode(r.authenticatorData), b64urlDecode(r.clientDataJSON));
            // A WebAuthn ECDSA signature is DER, unlike JWS — hence the fixup, at
            // the r/s width the curve calls for.
            const sig = ecSize
                ? W.derToP1363(b64urlDecode(r.signature), ecSize) : b64urlDecode(r.signature);
            ok = await crypto.subtle.verify(imported.op, imported.key, sig, signed);
        } catch (e) {
            checks.push(chk('Signature', false, e.message));
            return { checks, valid: false };
        }
        checks.push(chk('Signature', ok, 'over authenticatorData ‖ SHA-256(clientDataJSON)'
            + (ok ? '' : ' — does not verify under this key')));
        return { checks, valid: checks.every(c => c.ok || c.kind === 'info'), rpId };
    }


    // Rough character-class estimate, shown as information only — nothing here
    // blocks or warns about a short password. This is a testing tool; refusing to
    // encrypt would just get in the way.
    function passwordStrength(pw) {
        const s = String(pw || '');
        if (!s) return { bits: 0 };
        let classes = 0;
        if (/[a-z]/.test(s)) classes += 26;
        if (/[A-Z]/.test(s)) classes += 26;
        if (/[0-9]/.test(s)) classes += 10;
        if (/[^A-Za-z0-9]/.test(s)) classes += 33;
        const unique = new Set(s.split('')).size;
        // Repetition adds little: "aaaaaaaaaaaa" is long but not varied.
        const effective = Math.min(s.length, unique + Math.floor((s.length - unique) / 2));
        return { bits: Math.floor(effective * Math.log2(classes || 1)) };
    }

    // Everything below this line is what the pages and tests call. The KDF and
    // AES-GCM helpers above stay private — they only make sense together with the
    // parameter form, which is this module's job.
    window.LocalUtilKeySource = {
        PBKDF2_ITERS,
        browserPrfCapability,
        prfRegister, prfEvaluate, webauthnCreateSigner,
        parseRawKey, parseMacKey, parsePem, passwordStrength,
        encrypt, decrypt, paramsToText, paramsFromText,
        signJws, parseJws, verifyJws,
        signWebauthnAssertion, verifyWebauthnAssertion,
        detectSignature,
    };
})();
