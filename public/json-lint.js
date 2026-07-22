// Strict JSON validator (RFC 8259) with exact error locations, plus a caret
// snippet renderer. JSON.parse error messages don't reliably carry line/column
// across engines, so we parse ourselves. Exposed as window.LocalUtilJsonLint.
(function () {
    'use strict';

    // Returns { ok: true } or { ok: false, line, col, message } (1-based).
    function validate(text) {
        let i = 0;
        const n = text.length;

        function fail(expected) {
            const before = text.slice(0, i).split('\n');
            const found = i >= n ? 'end of input' : JSON.stringify(text[i]);
            throw {
                line: before.length,
                col: before[before.length - 1].length + 1,
                message: `Expected ${expected} but found ${found}`
            };
        }
        function ws() { while (i < n && ' \t\n\r'.includes(text[i])) i++; }
        function value() {
            ws();
            const c = text[i];
            if (c === '{') return obj();
            if (c === '[') return arr();
            if (c === '"') return str();
            if (c === '-' || (c >= '0' && c <= '9')) return num();
            if (text.startsWith('true', i)) { i += 4; return; }
            if (text.startsWith('false', i)) { i += 5; return; }
            if (text.startsWith('null', i)) { i += 4; return; }
            fail('a value');
        }
        function obj() {
            i++; ws();
            if (text[i] === '}') { i++; return; }
            for (;;) {
                ws();
                if (text[i] !== '"') fail('a string key');
                str(); ws();
                if (text[i] !== ':') fail("':'");
                i++;
                value(); ws();
                if (text[i] === ',') { i++; continue; }
                if (text[i] === '}') { i++; return; }
                fail("',' or '}'");
            }
        }
        function arr() {
            i++; ws();
            if (text[i] === ']') { i++; return; }
            for (;;) {
                value(); ws();
                if (text[i] === ',') { i++; continue; }
                if (text[i] === ']') { i++; return; }
                fail("',' or ']'");
            }
        }
        function str() {
            i++;
            while (i < n) {
                const c = text[i];
                if (c === '"') { i++; return; }
                if (c === '\\') {
                    i++;
                    if (text[i] === 'u') {
                        for (let k = 1; k <= 4; k++) {
                            if (!/[0-9a-fA-F]/.test(text[i + k] || '')) { i += k; fail('a hex digit'); }
                        }
                        i += 5;
                    } else if ('"\\/bfnrt'.includes(text[i])) {
                        i++;
                    } else {
                        fail('a valid escape (\\" \\\\ \\/ \\b \\f \\n \\r \\t \\uXXXX)');
                    }
                } else if (c < ' ') {
                    fail("'\"' (strings cannot contain raw control characters or line breaks)");
                } else {
                    i++;
                }
            }
            fail("'\"' (unterminated string)");
        }
        function num() {
            const re = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
            re.lastIndex = i;
            const m = re.exec(text);
            if (!m) fail('a number');
            i += m[0].length;
        }

        try {
            value(); ws();
            if (i < n) fail('end of input');
            return { ok: true };
        } catch (e) {
            if (e && e.line) return { ok: false, line: e.line, col: e.col, message: e.message };
            throw e;
        }
    }

    // Renders the offending line with context, a ">>>" marker and a "^" caret.
    // res is a failed validate() result.
    function snippet(text, res, heading) {
        let out = (heading || 'Invalid JSON') + ': ' + res.message + '\n\n';
        const lines = text.split('\n');
        const start = Math.max(0, res.line - 3);
        const end = Math.min(lines.length, res.line + 2);
        const gutterWidth = String(end).length;
        for (let i = start; i < end; i++) {
            const lineNum = String(i + 1).padStart(gutterWidth, ' ');
            const marker = (i + 1 === res.line) ? '>>>' : '   ';
            out += `${marker} ${lineNum} | ${lines[i]}\n`;
            if (i + 1 === res.line && res.col) {
                out += ' '.repeat(marker.length + 1 + gutterWidth + 3 + res.col - 1) + '^\n';
            }
        }
        return out;
    }

    window.LocalUtilJsonLint = { validate, snippet };
})();
