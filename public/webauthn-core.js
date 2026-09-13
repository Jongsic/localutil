// WebAuthn/FIDO2 primitives shared by the passkey debugger and the signing
// tools: base64url/hex helpers, a minimal CBOR decoder, the authenticatorData
// binary layout, COSE key → JWK conversion, and assertion signature
// verification (including the DER→P1363 fixup ECDSA needs).
//
// Extracted from passkey.html so sign.html verifies signatures with exactly the
// same code the debugger does — there must be one implementation of this.
// Exposed as window.LocalUtilWebAuthn.
(function () {
    'use strict';

    /* ============================================================
       utils — base64url / hex / bytes
       ============================================================ */
    function bytesOf(buf) { return buf instanceof Uint8Array ? buf : new Uint8Array(buf); }

    function b64urlEncode(buf) {
        const b = bytesOf(buf);
        let s = '';
        for (let i = 0; i < b.length; i += 0x4000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x4000));
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function b64urlDecode(str) {
        let s = String(str).trim().replace(/-/g, '+').replace(/_/g, '/');
        if (/[^A-Za-z0-9+/=]/.test(s)) throw new Error('not valid base64url');
        while (s.length % 4) s += '=';
        const bin = atob(s);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    // RFC 7515 §2 allows exactly the base64url alphabet, unpadded, with no
    // whitespace. b64urlDecode above is deliberately forgiving (PEM bodies and
    // hand-pasted values need that); JWS segments must not be, or this verifier
    // would accept tokens that every conformant JOSE library rejects.
    function b64urlDecodeStrict(str, what) {
        const s = String(str);
        if (!/^[A-Za-z0-9_-]*$/.test(s)) {
            throw new Error((what || 'value') + ' is not strict base64url '
                + '(RFC 7515 §2 allows only A–Z a–z 0–9 - _, unpadded, no whitespace).');
        }
        const bytes = b64urlDecode(s);
        // Reject non-canonical trailing bits: re-encoding must be a fixed point.
        if (b64urlEncode(bytes) !== s) {
            throw new Error((what || 'value') + ' has non-canonical base64url padding bits.');
        }
        return bytes;
    }

    function toHex(buf) { return Array.from(bytesOf(buf), b => b.toString(16).padStart(2, '0')).join(''); }
    function fromHex(str) {
        const s = str.replace(/\s+/g, '');
        if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2) throw new Error('not valid hex');
        const out = new Uint8Array(s.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
        return out;
    }

    function bytesEqual(a, b) {
        a = bytesOf(a); b = bytesOf(b);
        if (a.length !== b.length) return false;
        let diff = 0;
        for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
        return diff === 0;
    }

    function randomBytes(n) { return crypto.getRandomValues(new Uint8Array(n)); }
    async function sha256(buf) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytesOf(buf))); }

    function concatBytes() {
        const parts = Array.from(arguments).map(bytesOf);
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let off = 0;
        parts.forEach(p => { out.set(p, off); off += p.length; });
        return out;
    }

    /* ============================================================
       cbor — minimal decoder (definite-length only; enough for
       attestationObject / COSE keys / authData extensions)
       ============================================================ */
    function cborItem(bytes, offset) {
        if (offset >= bytes.length) throw new Error('CBOR: unexpected end of data');
        const ib = bytes[offset];
        const major = ib >> 5;
        const info = ib & 0x1f;
        let len, off = offset + 1;

        // Past-the-end reads yield undefined, which would make len NaN and slip
        // through the overrun guards below as an empty slice instead of an error.
        const need = n => { if (off + n > bytes.length) throw new Error('CBOR: truncated length field'); };
        if (info < 24) len = info;
        else if (info === 24) { need(1); len = bytes[off]; off += 1; }
        else if (info === 25) { need(2); len = (bytes[off] << 8) | bytes[off + 1]; off += 2; }
        else if (info === 26) { need(4); len = (bytes[off] * 0x1000000) + (bytes[off + 1] << 16 | bytes[off + 2] << 8 | bytes[off + 3]); off += 4; }
        else if (info === 27) throw new Error('CBOR: 64-bit lengths not supported');
        else if (info === 31) throw new Error('CBOR: indefinite length not supported');
        else throw new Error('CBOR: reserved length encoding');

        switch (major) {
            case 0: return [len, off];                       // unsigned int
            case 1: return [-1 - len, off];                  // negative int
            case 2: {                                        // byte string
                if (off + len > bytes.length) throw new Error('CBOR: byte string overruns data');
                return [bytes.slice(off, off + len), off + len];
            }
            case 3: {                                        // text string
                if (off + len > bytes.length) throw new Error('CBOR: text string overruns data');
                return [new TextDecoder().decode(bytes.slice(off, off + len)), off + len];
            }
            case 4: {                                        // array
                const arr = [];
                for (let i = 0; i < len; i++) { const [v, next] = cborItem(bytes, off); arr.push(v); off = next; }
                return [arr, off];
            }
            case 5: {                                        // map
                const map = new Map();
                for (let i = 0; i < len; i++) {
                    const [k, koff] = cborItem(bytes, off);
                    const [v, voff] = cborItem(bytes, koff);
                    map.set(k, v); off = voff;
                }
                return [map, off];
            }
            case 6: return cborItem(bytes, off);             // tag: unwrap
            case 7: {                                        // simple values
                if (info === 20) return [false, off];
                if (info === 21) return [true, off];
                if (info === 22) return [null, off];
                throw new Error('CBOR: floats / simple value ' + info + ' not supported');
            }
        }
        throw new Error('CBOR: unreachable');
    }

    function cborDecode(bytes) {
        const [value, end] = cborItem(bytesOf(bytes), 0);
        if (end !== bytes.length) throw new Error('CBOR: ' + (bytes.length - end) + ' trailing bytes');
        return value;
    }

    /* ============================================================
       authData — binary layout parser
       ============================================================ */
    function parseAuthenticatorData(bytes) {
        bytes = bytesOf(bytes);
        if (bytes.length < 37) throw new Error('authenticatorData must be at least 37 bytes (got ' + bytes.length + ')');
        const flagsByte = bytes[32];
        const flags = {
            up: !!(flagsByte & 0x01), uv: !!(flagsByte & 0x04),
            be: !!(flagsByte & 0x08), bs: !!(flagsByte & 0x10),
            at: !!(flagsByte & 0x40), ed: !!(flagsByte & 0x80),
        };
        const out = {
            rpIdHash: bytes.slice(0, 32),
            flagsByte, flags,
            signCount: new DataView(bytes.buffer, bytes.byteOffset + 33, 4).getUint32(0),
        };
        let off = 37;
        if (flags.at) {
            if (bytes.length < off + 18) throw new Error('authenticatorData: attested credential data truncated');
            out.aaguid = bytes.slice(off, off + 16);
            const idLen = (bytes[off + 16] << 8) | bytes[off + 17];
            off += 18;
            // WebAuthn L3 §6.5.1 caps a credential ID at 1023 bytes.
            if (idLen > 1023) throw new Error('authenticatorData: credential ID length ' + idLen + ' exceeds 1023');
            if (bytes.length < off + idLen) throw new Error('authenticatorData: credential ID truncated');
            out.credentialId = bytes.slice(off, off + idLen);
            off += idLen;
            const [coseKey, next] = cborItem(bytes, off);
            out.cosePublicKey = coseKey;
            off = next;
        }
        if (flags.ed) {
            const [ext, next] = cborItem(bytes, off);
            out.extensions = ext;
            off = next;
        }
        if (off !== bytes.length) {
            throw new Error('authenticatorData: ' + (bytes.length - off) + ' trailing bytes');
        }
        return out;
    }

    /* ============================================================
       cose — COSE key → JWK / algorithm names
       ============================================================ */
    const ALG_NAMES = { '-7': 'ES256', '-35': 'ES384', '-36': 'ES512', '-8': 'EdDSA', '-257': 'RS256' };
    // COSE elliptic-curve identifiers (RFC 9053 §7.1). Each carries the ECDSA
    // hash the curve is paired with and the r/s width a DER signature unpacks to.
    const COSE_EC_CURVES = {
        1: { crv: 'P-256', hash: 'SHA-256', size: 32 },
        2: { crv: 'P-384', hash: 'SHA-384', size: 48 },
        3: { crv: 'P-521', hash: 'SHA-512', size: 66 },
    };
    const JWK_EC_CURVES = {
        'P-256': { hash: 'SHA-256', size: 32 },
        'P-384': { hash: 'SHA-384', size: 48 },
        'P-521': { hash: 'SHA-512', size: 66 },
    };
    function algName(alg) { return ALG_NAMES[String(alg)] || ('COSE alg ' + alg); }

    function coseToJwk(cose) {
        if (!(cose instanceof Map)) throw new Error('COSE key must be a CBOR map');
        const kty = cose.get(1), alg = cose.get(3);
        if (kty === 2) { // EC2
            const c = COSE_EC_CURVES[cose.get(-1)];
            if (!c) throw new Error('unsupported EC curve (COSE crv ' + cose.get(-1) + ')');
            const x = cose.get(-2), y = cose.get(-3);
            // RFC 7518 §6.2.1.2: each coordinate is the full field size, padded.
            if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== c.size || y.length !== c.size) {
                throw new Error('COSE EC key coordinates must each be ' + c.size + ' bytes for ' + c.crv);
            }
            return {
                jwk: { kty: 'EC', crv: c.crv, x: b64urlEncode(x), y: b64urlEncode(y) },
                kty: 'EC2', crv: c.crv, alg,
            };
        }
        if (kty === 3) { // RSA
            return { jwk: { kty: 'RSA', n: b64urlEncode(cose.get(-1)), e: b64urlEncode(cose.get(-2)) }, kty: 'RSA', crv: null, alg };
        }
        if (kty === 1) { // OKP
            const crv = cose.get(-1);
            if (crv !== 6) throw new Error('unsupported OKP curve (COSE crv ' + crv + ')');
            const x = cose.get(-2);
            if (!(x instanceof Uint8Array) || x.length !== 32) {
                throw new Error('COSE Ed25519 public key must be 32 bytes');
            }
            return { jwk: { kty: 'OKP', crv: 'Ed25519', x: b64urlEncode(x) }, kty: 'OKP', crv: 'Ed25519', alg };
        }
        throw new Error('unsupported COSE key type ' + kty);
    }

    function importParamsFor(jwk) {
        if (jwk.kty === 'EC') {
            const c = JWK_EC_CURVES[jwk.crv];
            if (!c) throw new Error('unsupported EC curve ' + jwk.crv);
            return {
                imp: { name: 'ECDSA', namedCurve: jwk.crv },
                ver: { name: 'ECDSA', hash: c.hash }, size: c.size,
            };
        }
        if (jwk.kty === 'RSA') return { imp: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, ver: { name: 'RSASSA-PKCS1-v1_5' } };
        if (jwk.kty === 'OKP') return { imp: { name: 'Ed25519' }, ver: { name: 'Ed25519' } };
        throw new Error('unsupported key type ' + jwk.kty);
    }

    function pemWrap(label, der) {
        const b = bytesOf(der);
        let s = '';
        for (let i = 0; i < b.length; i += 0x4000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x4000));
        const b64 = btoa(s);
        let pem = '-----BEGIN ' + label + '-----\n';
        for (let i = 0; i < b64.length; i += 64) pem += b64.slice(i, i + 64) + '\n';
        return pem + '-----END ' + label + '-----';
    }

    async function jwkToPem(jwk) {
        const { imp } = importParamsFor(jwk);
        const key = await crypto.subtle.importKey('jwk', jwk, imp, true, ['verify']);
        const spki = new Uint8Array(await crypto.subtle.exportKey('spki', key));
        return pemWrap('PUBLIC KEY', spki);
    }

    // COSE key (as found in authData) → SPKI bytes, so a signature blob can
    // carry a public key in the one format WebCrypto imports directly.
    async function coseToSpki(cose) {
        const { jwk } = coseToJwk(cose);
        const { imp } = importParamsFor(jwk);
        const key = await crypto.subtle.importKey('jwk', jwk, imp, true, ['verify']);
        return new Uint8Array(await crypto.subtle.exportKey('spki', key));
    }

    /* ============================================================
       verify — DER→P1363 + WebCrypto signature check
       ============================================================ */
    // Strict, because a lenient parser makes signatures malleable: padded
    // integers, long-form lengths and trailing bytes would all re-encode the
    // same signature into different blobs that still verify, so the bytes stop
    // being a usable identity for dedup or replay caches. X.690 DER requires
    // minimal-length encodings and no trailing data; enforce both.
    function derToP1363(der, size) {
        der = bytesOf(der); size = size || 32;
        let off = 0;
        if (der[off++] !== 0x30) throw new Error('DER: expected SEQUENCE');
        let seqLen = der[off++];
        if (seqLen === undefined) throw new Error('DER: truncated');
        if (seqLen & 0x80) {
            const n = seqLen & 0x7f;
            if (n < 1 || n > 2) throw new Error('DER: unsupported SEQUENCE length form');
            seqLen = 0;
            for (let i = 0; i < n; i++) {
                if (der[off] === undefined) throw new Error('DER: truncated');
                seqLen = (seqLen << 8) | der[off++];
            }
            if (seqLen < 0x80) throw new Error('DER: non-minimal SEQUENCE length');
        }
        if (off + seqLen !== der.length) {
            throw new Error('DER: SEQUENCE length does not cover the data exactly');
        }
        function readInt() {
            if (der[off++] !== 0x02) throw new Error('DER: expected INTEGER');
            const len = der[off++];
            if (len === undefined) throw new Error('DER: truncated INTEGER');
            if (len & 0x80) throw new Error('DER: INTEGER length must be short form');
            if (len === 0) throw new Error('DER: empty INTEGER');
            if (off + len > der.length) throw new Error('DER: INTEGER overruns data');
            const v = der.slice(off, off + len); off += len;
            if (v[0] & 0x80) throw new Error('DER: negative INTEGER');
            if (v[0] === 0x00) {
                if (v.length === 1) throw new Error('DER: INTEGER is zero');
                if (!(v[1] & 0x80)) throw new Error('DER: non-minimal INTEGER');
            }
            const stripped = v[0] === 0x00 ? v.subarray(1) : v;
            if (stripped.length > size) throw new Error('DER: integer larger than curve size');
            const out = new Uint8Array(size);
            out.set(stripped, size - stripped.length);
            return out;
        }
        const r = readInt(), s = readInt();
        if (off !== der.length) throw new Error('DER: trailing bytes after SEQUENCE');
        const sig = new Uint8Array(size * 2);
        sig.set(r, 0); sig.set(s, size);
        return sig;
    }

    // The bytes a WebAuthn assertion actually signs. Every verifier needs this
    // exact concatenation — an assertion never signs your message directly,
    // which is why arbitrary-data signing has to smuggle a hash through the
    // challenge (see sign.html).
    async function assertionSignedBytes(authData, clientDataJSON) {
        return concatBytes(authData, await sha256(clientDataJSON));
    }

    async function verifyAssertionSignature(jwk, authData, clientDataJSON, signature) {
        const { imp, ver } = importParamsFor(jwk);
        let key;
        try {
            key = await crypto.subtle.importKey('jwk', jwk, imp, false, ['verify']);
        } catch (e) {
            return { supported: false, valid: false, reason: (jwk.kty === 'OKP' ? 'Ed25519 not supported by this browser’s WebCrypto' : e.message) };
        }
        const signed = await assertionSignedBytes(authData, clientDataJSON);
        // Only ECDSA is DER-wrapped in WebAuthn, and its r/s width follows the curve.
        const sig = jwk.kty === 'EC'
            ? derToP1363(signature, JWK_EC_CURVES[jwk.crv].size) : bytesOf(signature);
        const valid = await crypto.subtle.verify(ver, key, sig, signed);
        return { supported: true, valid };
    }

    window.LocalUtilWebAuthn = {
        bytesOf, b64urlEncode, b64urlDecode, b64urlDecodeStrict, toHex, fromHex, bytesEqual,
        randomBytes, sha256, concatBytes,
        cborDecode, parseAuthenticatorData,
        ALG_NAMES, JWK_EC_CURVES, algName, coseToJwk, importParamsFor, jwkToPem, pemWrap, coseToSpki,
        derToP1363, assertionSignedBytes, verifyAssertionSignature,
    };
})();
