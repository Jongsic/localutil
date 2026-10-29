// Reading and writing PHP serialize() output — a:2:{s:4:"name";…} — and
// drawing it as a collapsible tree.
//
// Shared by php-serialize.html and the URL breakdown in url-encode.html, so a
// value pulled out of a cookie or query string expands exactly the way the
// dedicated page shows it. Exposed as window.LocalUtilPHP.
//
// Values are read into typed nodes that keep what PHP wrote, so serializing a
// node gives back the same bytes:
//   { t: 'null' } { t: 'bool', v } { t: 'int', v } { t: 'float', v }
//   { t: 'string', v } { t: 'enum', v: 'Suit:Hearts' } { t: 'ref', v, byRef }
//   { t: 'array', items: [{ k, v }] }
//   { t: 'object', cls, items: [{ k, v }] }
//   { t: 'custom', cls, data }                      C:…  (Serializable)
// int and float keep their written text (v is a string), so a 64-bit int or
// a float like 0.1 never passes through a JS number. Keys are int or string
// nodes. Lengths in s:, O:, C: and E: count UTF-8 bytes, as PHP does.
(function () {
    'use strict';

    const enc = new TextEncoder();
    const dec = new TextDecoder('utf-8');
    const decStrict = new TextDecoder('utf-8', { fatal: true });
    const byteLen = s => enc.encode(s).length;

    class PhpError extends Error {
        constructor(message, offset) {
            super(message);
            this.offset = offset;
        }
    }

    // --- unserialize -------------------------------------------------------

    // opts.trailing: text after the value is returned as `rest` instead of
    // being an error — a signed cookie appends its signature that way.
    function unserialize(text, opts) {
        const b = enc.encode(text);
        const warnings = [];
        let pos = 0;

        const ch = () => String.fromCharCode(b[pos]);
        const fail = msg => { throw new PhpError(msg + ' at byte ' + pos, pos); };
        function expect(c) {
            if (pos >= b.length) fail('Unexpected end, expected "' + c + '"');
            if (b[pos] !== c.charCodeAt(0)) fail('Expected "' + c + '" but found "' + ch() + '"');
            pos++;
        }
        // Text up to (not including) the terminator byte.
        function until(c, what) {
            const end = b.indexOf(c.charCodeAt(0), pos);
            if (end < 0) fail('Unterminated ' + what);
            const s = dec.decode(b.subarray(pos, end));
            pos = end + 1;
            return s;
        }
        function count(what) {
            const s = until(':', what);
            if (!/^\d+$/.test(s)) fail('Bad ' + what + ' "' + s + '"');
            return parseInt(s, 10);
        }
        // "…" of a declared byte length. A length that counts characters rather
        // than bytes — what a non-PHP writer or a re-encoded value tends to
        // produce — is accepted with a warning when bytes do not fit.
        function quoted(n, close, what) {
            expect('"');
            const start = pos;
            if (b[start + n] === 34 && b[start + n + 1] === close.charCodeAt(0)) {
                pos = start + n + 2;
                const raw = b.subarray(start, start + n);
                try { return decStrict.decode(raw); } catch (e) {
                    warnings.push('A ' + what + ' at byte ' + start + ' is not valid UTF-8; shown with replacement characters');
                    return dec.decode(raw);
                }
            }
            const s = dec.decode(b.subarray(start));
            const chars = [...s].slice(0, n).join('');
            const end = start + byteLen(chars);
            if (b[end] === 34 && b[end + 1] === close.charCodeAt(0)) {
                warnings.push('The ' + what + ' at byte ' + start + ' declares ' + n + ' characters, not ' + byteLen(chars) + ' bytes');
                pos = end + 2;
                return chars;
            }
            fail('The ' + what + ' starting at byte ' + start + ' is not ' + n + ' bytes long');
        }
        function entries(n) {
            expect('{');
            const items = [];
            for (let i = 0; i < n; i++) {
                if (b[pos] === 125) fail('Declared ' + n + ' entries but found ' + i);
                const kAt = pos;
                const k = value();
                if (k.t !== 'int' && k.t !== 'string') { pos = kAt; fail('Keys must be int or string'); }
                items.push({ k, v: value() });
            }
            expect('}');
            return items;
        }

        function value() {
            if (pos >= b.length) fail('Unexpected end of input');
            const t = ch();
            if (t === 'N') { pos++; expect(';'); return { t: 'null' }; }
            pos++;
            expect(':');
            switch (t) {
                case 'b': {
                    const s = until(';', 'bool');
                    if (s !== '0' && s !== '1') fail('Bad bool "' + s + '"');
                    return { t: 'bool', v: s === '1' };
                }
                case 'i': {
                    const s = until(';', 'int');
                    if (!/^[+-]?\d+$/.test(s)) fail('Bad int "' + s + '"');
                    return { t: 'int', v: s };
                }
                case 'd': {
                    const s = until(';', 'float');
                    if (!/^(?:[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|-?INF|NAN)$/.test(s)) fail('Bad float "' + s + '"');
                    return { t: 'float', v: s };
                }
                case 's': {
                    const n = count('string length');
                    const v = quoted(n, ';', 'string');
                    return { t: 'string', v };
                }
                case 'S': {
                    // Escaped string (old PHP 6 / APC form): \xx hex escapes.
                    const n = count('string length');
                    expect('"');
                    const out = [];
                    while (out.length < n) {
                        if (pos >= b.length) fail('Unterminated string');
                        if (b[pos] === 92) {
                            const hex = String.fromCharCode(b[pos + 1], b[pos + 2]);
                            if (!/^[0-9a-f]{2}$/i.test(hex)) fail('Bad escape');
                            out.push(parseInt(hex, 16));
                            pos += 3;
                        } else out.push(b[pos++]);
                    }
                    expect('"'); expect(';');
                    return { t: 'string', v: dec.decode(new Uint8Array(out)) };
                }
                case 'a': {
                    const n = count('array length');
                    return { t: 'array', items: entries(n) };
                }
                case 'O': {
                    const cls = quoted(count('class name length'), ':', 'class name');
                    const n = count('property count');
                    return { t: 'object', cls, items: entries(n) };
                }
                case 'C': {
                    const cls = quoted(count('class name length'), ':', 'class name');
                    const n = count('data length');
                    expect('{');
                    if (b[pos + n] !== 125) fail('Custom data of ' + cls + ' is not ' + n + ' bytes long');
                    const data = dec.decode(b.subarray(pos, pos + n));
                    pos += n + 1;
                    return { t: 'custom', cls, data };
                }
                case 'E': {
                    const v = quoted(count('enum length'), ';', 'enum case');
                    if (v.indexOf(':') < 1) fail('Bad enum "' + v + '"');
                    return { t: 'enum', v };
                }
                case 'r': case 'R': {
                    const s = until(';', 'reference');
                    if (!/^\d+$/.test(s)) fail('Bad reference "' + s + '"');
                    return { t: 'ref', v: parseInt(s, 10), byRef: t === 'R' };
                }
            }
            pos -= 2;
            fail('Unknown type "' + t + '"');
        }

        // Surrounding whitespace is forgiven; anything else after the value is
        // not, unless the caller asked for it back.
        while (pos < b.length && /\s/.test(ch())) pos++;
        const node = value();
        const end = pos;
        while (pos < b.length && /\s/.test(ch())) pos++;
        if (pos === b.length) return { value: node, warnings, rest: '' };
        if (!(opts && opts.trailing)) fail('Unexpected text after the value');
        return { value: node, warnings, rest: dec.decode(b.subarray(end)) };
    }

    // What usually follows serialized data: a hex digest signing it, as
    // CodeIgniter 2 does with its session cookie (MD5, later HMAC-SHA1).
    const DIGESTS = { 32: 'MD5', 40: 'SHA-1', 64: 'SHA-256', 128: 'SHA-512' };
    function describeRest(rest) {
        const kind = /^[0-9a-f]+$/i.test(rest) && DIGESTS[rest.length];
        return kind
            ? rest.length + ' hex characters — looks like a ' + kind + ' signature or hash of the data'
            : rest.length + ' more characters after the value';
    }

    // A cheap test before attempting a parse: only something that opens like
    // a PHP container (array, object, custom object) is worth expanding.
    const STRUCT_RE = /^\s*(?:a:\d+:\{|[OC]:\d+:")/;
    function tryUnserialize(text) {
        if (typeof text !== 'string' || !STRUCT_RE.test(text)) return null;
        try { return unserialize(text, { trailing: true }); } catch (e) { return null; }
    }

    // --- serialize -----------------------------------------------------------

    function serialize(node) {
        switch (node.t) {
            case 'null': return 'N;';
            case 'bool': return 'b:' + (node.v ? 1 : 0) + ';';
            case 'int': return 'i:' + node.v + ';';
            case 'float': return 'd:' + node.v + ';';
            case 'string': return 's:' + byteLen(node.v) + ':"' + node.v + '";';
            case 'enum': return 'E:' + byteLen(node.v) + ':"' + node.v + '";';
            case 'ref': return (node.byRef ? 'R' : 'r') + ':' + node.v + ';';
            case 'array':
                return 'a:' + node.items.length + ':{' + node.items.map(e => serialize(e.k) + serialize(e.v)).join('') + '}';
            case 'object':
                return 'O:' + byteLen(node.cls) + ':"' + node.cls + '":' + node.items.length + ':{' +
                    node.items.map(e => serialize(e.k) + serialize(e.v)).join('') + '}';
            case 'custom':
                return 'C:' + byteLen(node.cls) + ':"' + node.cls + '":' + byteLen(node.data) + ':{' + node.data + '}';
        }
        throw new Error('Unknown node type ' + node.t);
    }

    // --- JSON mapping ------------------------------------------------------
    // Plain values map to their JSON twins; a list (keys 0..n-1 in order)
    // becomes a JSON array, any other array a JSON object. What JSON has no
    // word for is spelled with reserved keys, so it survives the round trip:
    //   object   {"__class": "User", "name": …}
    //   custom   {"__class": "ArrayObject", "__serialized": "x:i:0;…"}
    //   enum     {"__enum": "Suit:Hearts"}
    //   ref      {"__ref": 2}  (R: adds "__byRef": true)
    // Property names keep PHP's NUL markers: "\u0000*\u0000x" is protected x.

    const INT_KEY_RE = /^(?:0|-?[1-9]\d*)$/;

    function toJSON(node) {
        switch (node.t) {
            case 'null': return null;
            case 'bool': return node.v;
            case 'int': {
                const n = Number(node.v);
                return Number.isSafeInteger(n) ? n : node.v;
            }
            case 'float': {
                const n = Number(node.v);
                return Number.isFinite(n) ? n : node.v;
            }
            case 'string': return node.v;
            case 'enum': return { __enum: node.v };
            case 'ref': return node.byRef ? { __ref: node.v, __byRef: true } : { __ref: node.v };
            case 'custom': return { __class: node.cls, __serialized: node.data };
            case 'array': {
                const isList = node.items.every((e, i) => e.k.t === 'int' && Number(e.k.v) === i);
                if (isList) return node.items.map(e => toJSON(e.v));
                const o = {};
                for (const e of node.items) o[e.k.v] = toJSON(e.v);
                return o;
            }
            case 'object': {
                const o = { __class: node.cls };
                for (const e of node.items) o[e.k.v] = toJSON(e.v);
                return o;
            }
        }
    }

    // JS prints 1e+25; PHP writes 1.0E+25.
    function phpFloat(n) {
        if (Number.isNaN(n)) return 'NAN';
        if (!Number.isFinite(n)) return n > 0 ? 'INF' : '-INF';
        const s = String(n);
        const m = /^(-?\d+)(\.\d+)?e([+-]\d+)$/.exec(s);
        return m ? m[1] + (m[2] || '.0') + 'E' + m[3] : s;
    }

    // PHP turns a decimal-integer string key into an int key, as an array
    // literal would.
    const keyNode = k => INT_KEY_RE.test(k) && Number.isSafeInteger(Number(k))
        ? { t: 'int', v: k } : { t: 'string', v: k };

    function fromJSON(v) {
        if (v === null) return { t: 'null' };
        if (typeof v === 'boolean') return { t: 'bool', v };
        if (typeof v === 'number') {
            return Number.isInteger(v) && Number.isSafeInteger(v)
                ? { t: 'int', v: String(v) } : { t: 'float', v: phpFloat(v) };
        }
        if (typeof v === 'string') return { t: 'string', v };
        if (Array.isArray(v)) {
            return { t: 'array', items: v.map((x, i) => ({ k: { t: 'int', v: String(i) }, v: fromJSON(x) })) };
        }
        const keys = Object.keys(v);
        if (keys.length === 1 && typeof v.__enum === 'string') return { t: 'enum', v: v.__enum };
        if (typeof v.__ref === 'number' && keys.every(k => k === '__ref' || k === '__byRef')) {
            return { t: 'ref', v: v.__ref, byRef: v.__byRef === true };
        }
        if (typeof v.__class === 'string') {
            if (typeof v.__serialized === 'string' && keys.length === 2) {
                return { t: 'custom', cls: v.__class, data: v.__serialized };
            }
            return {
                t: 'object', cls: v.__class,
                items: keys.filter(k => k !== '__class').map(k => ({ k: keyNode(k), v: fromJSON(v[k]) })),
            };
        }
        return { t: 'array', items: keys.map(k => ({ k: keyNode(k), v: fromJSON(v[k]) })) };
    }

    // --- tree view ---------------------------------------------------------

    function span(cls, text) {
        const s = document.createElement('span');
        s.className = cls;
        s.textContent = text;
        return s;
    }

    // Property names carry visibility: "\0*\0x" is protected, "\0Cls\0x" private.
    function keyLabel(k, ownerCls) {
        if (k.t === 'int') return [span('pt-key', '[' + k.v + ']')];
        const m = /^\0([^\0]*)\0(.*)$/s.exec(k.v);
        if (!m) return [span('pt-key', ownerCls ? k.v : JSON.stringify(k.v))];
        const vis = m[1] === '*' ? 'protected ' : 'private ' + (m[1] === ownerCls ? '' : m[1] + '::');
        return [span('pt-meta', vis), span('pt-key', m[2])];
    }

    function leafParts(n) {
        switch (n.t) {
            case 'null': return [span('pt-null', 'null')];
            case 'bool': return [span('pt-bool', String(n.v))];
            case 'int': return [span('pt-number', n.v)];
            case 'float': return [span('pt-number', n.v), span('pt-meta', ' float')];
            case 'string': return [span('pt-string', JSON.stringify(n.v)), span('pt-meta', ' string(' + byteLen(n.v) + ')')];
            case 'enum': return [span('pt-bool', n.v.replace(':', '::')), span('pt-meta', ' enum')];
            case 'ref': return [span('pt-meta', (n.byRef ? '&' : '') + 'reference to value #' + n.v)];
            case 'custom': return [span('pt-meta', n.cls + ' (custom) '), span('pt-string', JSON.stringify(n.data))];
        }
        return [];
    }

    function row(key, owner, parts) {
        const d = document.createElement('div');
        d.className = 'pt-leaf';
        if (key) d.append(...keyLabel(key, owner), span('pt-meta', ' => '));
        d.append(...parts);
        return d;
    }

    function restRow(rest) {
        const d = document.createElement('div');
        d.className = 'pt-leaf pt-rest';
        d.append(span('pt-meta', 'followed by '), span('pt-string', rest),
            span('pt-meta', ' — ' + describeRest(rest)));
        return d;
    }

    // A tree of <details>; containers start open down to `openDepth`. A string
    // that itself holds serialized PHP — double-serialized session data, a
    // nested cache entry — expands in place. opts.rest is text that followed
    // the value, shown under it.
    function renderTree(node, opts) {
        const openDepth = opts && opts.openDepth != null ? opts.openDepth : 2;
        function build(n, key, owner, depth) {
            if (n.t === 'string') {
                const inner = tryUnserialize(n.v);
                if (inner) {
                    const det = document.createElement('details');
                    const sum = document.createElement('summary');
                    if (key) sum.append(...keyLabel(key, owner), span('pt-meta', ' => '));
                    sum.append(span('pt-meta', 'serialized string(' + byteLen(n.v) + ')'));
                    det.append(sum, build(inner.value, null, null, depth + 1));
                    if (inner.rest) det.appendChild(restRow(inner.rest));
                    return det;
                }
            }
            if (n.t !== 'array' && n.t !== 'object') return row(key, owner, leafParts(n));
            const det = document.createElement('details');
            det.open = depth < openDepth;
            const sum = document.createElement('summary');
            if (key) sum.append(...keyLabel(key, owner), span('pt-meta', ' => '));
            if (n.t === 'array') sum.append(span('pt-meta', 'array(' + n.items.length + ')'));
            else sum.append(span('pt-class', n.cls), span('pt-meta', ' object(' + n.items.length + ')'));
            det.appendChild(sum);
            const cls = n.t === 'object' ? n.cls : null;
            for (const e of n.items) det.appendChild(build(e.v, e.k, cls, depth + 1));
            return det;
        }
        const root = document.createElement('div');
        root.className = 'php-tree';
        root.setAttribute('data-i18n-skip', '');
        const top = build(node, null, null, 0);
        if (top.tagName === 'DETAILS') top.open = true;
        root.appendChild(top);
        if (opts && opts.rest) root.appendChild(restRow(opts.rest));
        return root;
    }

    window.LocalUtilPHP = { unserialize, tryUnserialize, describeRest, serialize, toJSON, fromJSON, renderTree, PhpError };
})();
