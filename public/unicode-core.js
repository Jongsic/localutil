// Hidden Unicode characters: find them, take them out, and put some in on
// purpose (a hidden message or a per-recipient watermark).
//
// Shared by unicode-hygiene.html and paste-board.html, so "Copy cleaned" on the
// paste board removes exactly what the dedicated page would. Exposed as
// window.LocalUtilUnicode.
//
// Positions are UTF-16 indices into the string the caller passed — what
// textarea.setSelectionRange takes. line and col are 1-based; col counts code
// points, so an emoji is one column.
//
// Hidden payloads are written as a run of variation selectors, one byte per
// selector (VS1–16 = 0–15, VS17–256 = 16–255), attached to a single letter:
//   A7 11 <utf-8 text> <crc16>                     plain message
//   A7 12 <salt 16> <iv 12> <AES-GCM ciphertext>   encrypted message
//   A7 13 <code 6> <crc16>                          recipient watermark
// The run itself delimits the frame, so there is no length field. The older
// zero-width binary format (U+2062 U+2064, U+200B = 0 / U+200C = 1, U+2064
// U+2062) is read and written for compatibility with other tools; it carries
// plain text only.
(function () {
    'use strict';

    const enc = new TextEncoder();
    const decStrict = new TextDecoder('utf-8', { fatal: true });
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

    const hex = cp => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
    const chr = cp => cp === undefined ? '' : String.fromCodePoint(cp);

    // --- the character table -----------------------------------------------

    // cat: invisible · bidi · space · control · tag · variation · filler
    const NAMED = [
        [0x00AD, 'Soft Hyphen', 'SHY', 'invisible'],
        [0x034F, 'Combining Grapheme Joiner', 'CGJ', 'invisible'],
        [0x17B4, 'Khmer Vowel Inherent Aq', '', 'invisible'],
        [0x17B5, 'Khmer Vowel Inherent Aa', '', 'invisible'],
        [0x180E, 'Mongolian Vowel Separator', 'MVS', 'invisible'],
        [0x200B, 'Zero Width Space', 'ZWSP', 'invisible'],
        [0x200C, 'Zero Width Non-Joiner', 'ZWNJ', 'invisible'],
        [0x200D, 'Zero Width Joiner', 'ZWJ', 'invisible'],
        [0x2060, 'Word Joiner', 'WJ', 'invisible'],
        [0x2061, 'Function Application', '', 'invisible'],
        [0x2062, 'Invisible Times', '', 'invisible'],
        [0x2063, 'Invisible Separator', '', 'invisible'],
        [0x2064, 'Invisible Plus', '', 'invisible'],
        [0x206A, 'Inhibit Symmetric Swapping', '', 'invisible'],
        [0x206B, 'Activate Symmetric Swapping', '', 'invisible'],
        [0x206C, 'Inhibit Arabic Form Shaping', '', 'invisible'],
        [0x206D, 'Activate Arabic Form Shaping', '', 'invisible'],
        [0x206E, 'National Digit Shapes', '', 'invisible'],
        [0x206F, 'Nominal Digit Shapes', '', 'invisible'],
        [0xFEFF, 'Zero Width No-Break Space', 'BOM', 'invisible'],
        [0xFFF9, 'Interlinear Annotation Anchor', '', 'invisible'],
        [0xFFFA, 'Interlinear Annotation Separator', '', 'invisible'],
        [0xFFFB, 'Interlinear Annotation Terminator', '', 'invisible'],
        [0xFFFC, 'Object Replacement Character', 'OBJ', 'invisible'],
        [0x061C, 'Arabic Letter Mark', 'ALM', 'bidi'],
        [0x200E, 'Left-to-Right Mark', 'LRM', 'bidi'],
        [0x200F, 'Right-to-Left Mark', 'RLM', 'bidi'],
        [0x202A, 'Left-to-Right Embedding', 'LRE', 'bidi'],
        [0x202B, 'Right-to-Left Embedding', 'RLE', 'bidi'],
        [0x202C, 'Pop Directional Formatting', 'PDF', 'bidi'],
        [0x202D, 'Left-to-Right Override', 'LRO', 'bidi'],
        [0x202E, 'Right-to-Left Override', 'RLO', 'bidi'],
        [0x2066, 'Left-to-Right Isolate', 'LRI', 'bidi'],
        [0x2067, 'Right-to-Left Isolate', 'RLI', 'bidi'],
        [0x2068, 'First Strong Isolate', 'FSI', 'bidi'],
        [0x2069, 'Pop Directional Isolate', 'PDI', 'bidi'],
        [0x00A0, 'No-Break Space', 'NBSP', 'space'],
        [0x1680, 'Ogham Space Mark', '', 'space'],
        [0x2000, 'En Quad', '', 'space'],
        [0x2001, 'Em Quad', '', 'space'],
        [0x2002, 'En Space', '', 'space'],
        [0x2003, 'Em Space', '', 'space'],
        [0x2004, 'Three-Per-Em Space', '', 'space'],
        [0x2005, 'Four-Per-Em Space', '', 'space'],
        [0x2006, 'Six-Per-Em Space', '', 'space'],
        [0x2007, 'Figure Space', '', 'space'],
        [0x2008, 'Punctuation Space', '', 'space'],
        [0x2009, 'Thin Space', '', 'space'],
        [0x200A, 'Hair Space', '', 'space'],
        [0x2028, 'Line Separator', 'LSEP', 'space'],
        [0x2029, 'Paragraph Separator', 'PSEP', 'space'],
        [0x202F, 'Narrow No-Break Space', 'NNBSP', 'space'],
        [0x205F, 'Medium Mathematical Space', 'MMSP', 'space'],
        [0x3000, 'Ideographic Space', '', 'space'],
        [0x180B, 'Mongolian Free Variation Selector One', 'FVS1', 'variation'],
        [0x180C, 'Mongolian Free Variation Selector Two', 'FVS2', 'variation'],
        [0x180D, 'Mongolian Free Variation Selector Three', 'FVS3', 'variation'],
        [0x180F, 'Mongolian Free Variation Selector Four', 'FVS4', 'variation'],
        [0x115F, 'Hangul Choseong Filler', '', 'filler'],
        [0x1160, 'Hangul Jungseong Filler', '', 'filler'],
        [0x3164, 'Hangul Filler', '', 'filler'],
        [0xFFA0, 'Halfwidth Hangul Filler', '', 'filler'],
        [0x2800, 'Braille Pattern Blank', '', 'filler'],
    ];
    const BY_CP = new Map(NAMED.map(([cp, name, abbr, cat]) => [cp, { cp, name, abbr, cat }]));
    const CTRL_ABBR = { 0x00: 'NUL', 0x07: 'BEL', 0x08: 'BS', 0x0B: 'VT', 0x0C: 'FF', 0x1B: 'ESC', 0x7F: 'DEL', 0x85: 'NEL' };

    const isVS = cp => (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xE0100 && cp <= 0xE01EF);
    const isTag = cp => cp >= 0xE0000 && cp <= 0xE007F;

    // { cp, name, abbr, cat } for a character this module cares about, else null.
    function info(cp) {
        const named = BY_CP.get(cp);
        if (named) return named;
        if (cp >= 0xFE00 && cp <= 0xFE0F) return { cp, name: 'Variation Selector-' + (cp - 0xFDFF), abbr: 'VS' + (cp - 0xFDFF), cat: 'variation' };
        if (cp >= 0xE0100 && cp <= 0xE01EF) return { cp, name: 'Variation Selector-' + (cp - 0xE00EF), abbr: 'VS' + (cp - 0xE00EF), cat: 'variation' };
        if (isTag(cp)) {
            const name = cp === 0xE0001 ? 'Language Tag' : cp === 0xE007F ? 'Cancel Tag'
                : cp === 0xE0020 ? 'Tag Space' : cp > 0xE0020 ? 'Tag ' + String.fromCharCode(cp - 0xE0000) : 'Tag (unassigned)';
            return { cp, name, abbr: '', cat: 'tag' };
        }
        if ((cp < 0x20 && cp !== 0x09 && cp !== 0x0A && cp !== 0x0D) || (cp >= 0x7F && cp <= 0x9F)) {
            return { cp, name: 'Control Character', abbr: CTRL_ABBR[cp] || '', cat: 'control' };
        }
        return null;
    }

    // --- legitimate uses ---------------------------------------------------

    // Several of these characters are part of ordinary writing in the right
    // place: ZWJ inside an emoji sequence, ZWNJ in Persian, VS16 after an
    // emoji, an ideographic variation selector after a Han character, a mark
    // or isolate in right-to-left text, a no-break space in French spacing. Scan shows them as normal, and Clean
    // keeps them unless told otherwise.
    const RE = {
        pict: /\p{Extended_Pictographic}/u,
        emoji: /\p{Emoji}/u,
        modifier: /\p{Emoji_Modifier}/u,
        joining: /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Mongolian}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Lao}\p{Script=Thai}\p{Script=Tibetan}]/u,
        svsBase: /[\p{Script=Han}\p{Script=Mongolian}\p{Script=Myanmar}\p{Script=Phags_Pa}\p{Script=Manichaean}\p{Sm}\p{So}0]/u,
        han: /\p{Script=Han}/u,
        mongolian: /\p{Script=Mongolian}/u,
        cjk: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFFEF]/u,
        rtl: /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u,
        jamo: /[\u1100-\u11FF\uA960-\uA97F\uD7B0-\uD7FF]/,
        frenchOpen: /[\u00AB\u2039]/,         // « ‹
        frenchClose: /[\u00BB\u203A!?;:]/,    // » › and the high punctuation
    };

    // The nearest neighbor that is not a variation selector, joiner or skin
    // tone modifier. Capped: no real sequence stacks more than a few, and an
    // uncapped walk over a pasted run of thousands would cost O(n²).
    const SKIP_NEIGHBOR = cp => (cp >= 0xFE00 && cp <= 0xFE0F) || cp === 0x200D || (cp >= 0x1F3FB && cp <= 0x1F3FF);
    function neighbor(cps, k, step) {
        for (let j = k + step, n = 0; j >= 0 && j < cps.length && n <= 16; j += step, n++) {
            if (!SKIP_NEIGHBOR(cps[j])) return cps[j];
        }
        return undefined;
    }

    // ctx comes from contextOf(): facts about the whole text, worked out once.
    function isLegit(cps, k, ctx) {
        const cp = cps[k], prev = cps[k - 1], next = cps[k + 1];
        if (cp === 0x200D) {
            let j = k - 1;
            while (j >= 0 && (cps[j] === 0xFE0F || RE.modifier.test(chr(cps[j])))) j--;
            if (j >= 0 && RE.pict.test(chr(cps[j])) && RE.pict.test(chr(next))) return true;
        }
        if (cp === 0x200D) return RE.joining.test(chr(prev)) && RE.joining.test(chr(next));
        if (cp === 0x200C) return RE.joining.test(chr(neighbor(cps, k, -1))) && RE.joining.test(chr(neighbor(cps, k, 1)));
        if (cp === 0xFE0E || cp === 0xFE0F) return RE.emoji.test(chr(prev));
        if (cp >= 0xFE00 && cp <= 0xFE0D) return RE.svsBase.test(chr(prev));
        if (cp >= 0xE0100 && cp <= 0xE01EF) return RE.han.test(chr(prev));
        if (cp >= 0x180B && cp <= 0x180F) return cp !== 0x180E && RE.mongolian.test(chr(prev));
        if (isTag(cp)) return ctx.flag[k] === 1;
        if (cp === 0x200E || cp === 0x200F || cp === 0x061C || (cp >= 0x202A && cp <= 0x202C) || (cp >= 0x2066 && cp <= 0x2069)) return ctx.hasRtl;
        // French typography: « mot », Bonjour !
        if (cp === 0x00A0 || cp === 0x202F) return RE.frenchOpen.test(chr(prev)) || RE.frenchClose.test(chr(next));
        if (cp === 0x3000) return prev === undefined || prev === 0x0A || RE.cjk.test(chr(prev)) || RE.cjk.test(chr(next));
        if (cp === 0x115F || cp === 0x1160) return RE.jamo.test(chr(prev)) || RE.jamo.test(chr(next));
        return false;
    }

    // The subdivision flags with RGI emoji status: England, Scotland, Wales.
    // A black flag followed by any other tag text is no flag a font draws, so
    // that text is read as hidden rather than waved through as an emoji.
    const RGI_FLAGS = new Set(['gbeng', 'gbsct', 'gbwls']);

    function isRgiFlag(cps, s, e) {
        if (e - s !== 6 || cps[s - 1] !== 0x1F3F4 || cps[e - 1] !== 0xE007F) return false;
        return RGI_FLAGS.has(String.fromCharCode(...cps.slice(s, e - 1).map(c => c - 0xE0000)));
    }

    // Whether the text has right-to-left script, and which tag characters
    // belong to a flag — each tag run is judged once, so a long run costs no
    // more than its length.
    function contextOf(text, cps) {
        const flag = new Uint8Array(cps.length);
        for (let k = 0; k < cps.length;) {
            if (!isTag(cps[k])) { k++; continue; }
            let e = k;
            while (e < cps.length && isTag(cps[e])) e++;
            if (isRgiFlag(cps, k, e)) flag.fill(1, k, e);
            k = e;
        }
        return { hasRtl: RE.rtl.test(text), flag };
    }

    // --- letters from other scripts, styled letters, punctuation -----------

    // The writing systems a text is expected to hold: Latin, Hangul, Han and
    // kana, plus what belongs to no script of its own — digits, punctuation,
    // symbols, emoji, combining marks. Everything else is "other" and is
    // judged character by character, with no look at the words around it.
    const ALLOWED = /[\p{Script=Latin}\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Common}\p{Script=Inherited}]/u;
    const SCRIPTS = ['Cyrillic', 'Greek', 'Armenian', 'Georgian', 'Hebrew', 'Arabic', 'Syriac', 'Thaana', 'Nko', 'Devanagari',
        'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala', 'Thai', 'Lao',
        'Tibetan', 'Myanmar', 'Khmer', 'Mongolian', 'Ethiopic', 'Cherokee', 'Canadian_Aboriginal', 'Coptic', 'Glagolitic',
        'Runic', 'Ogham', 'Tifinagh', 'Bopomofo', 'Yi', 'Lisu', 'Vai'].map(name => [name.replace('_', ' '), new RegExp('\\p{Script=' + name + '}', 'u')]);

    // Letters of other scripts that pass for Latin ones, by code point so the
    // table cannot fool whoever reads it. Cleaning turns these into their
    // Latin twin instead of deleting them, so "paypal" spelled with a
    // Cyrillic a comes back as "paypal", not "pypal".
    const LATIN_TWIN = new Map([
        [0x0430, 'a'], [0x0435, 'e'], [0x043E, 'o'], [0x0440, 'p'], [0x0441, 'c'], [0x0443, 'y'], [0x0445, 'x'],
        [0x0455, 's'], [0x0456, 'i'], [0x0458, 'j'], [0x04BB, 'h'], [0x0501, 'd'], [0x051B, 'q'], [0x051D, 'w'], [0x04CF, 'l'],
        [0x0410, 'A'], [0x0412, 'B'], [0x0415, 'E'], [0x041A, 'K'], [0x041C, 'M'], [0x041D, 'H'], [0x041E, 'O'],
        [0x0420, 'P'], [0x0421, 'C'], [0x0422, 'T'], [0x0423, 'Y'], [0x0425, 'X'], [0x0405, 'S'], [0x0406, 'I'],
        [0x0408, 'J'], [0x051A, 'Q'], [0x051C, 'W'],
        [0x03BF, 'o'], [0x03BD, 'v'],
        [0x0391, 'A'], [0x0392, 'B'], [0x0395, 'E'], [0x0396, 'Z'], [0x0397, 'H'], [0x0399, 'I'], [0x039A, 'K'],
        [0x039C, 'M'], [0x039D, 'N'], [0x039F, 'O'], [0x03A1, 'P'], [0x03A4, 'T'], [0x03A5, 'Y'], [0x03A7, 'X'],
        [0x0585, 'o'], [0x057D, 'u'], [0x0570, 'h'], [0x0578, 'n'], [0x0581, 'g'], [0x0566, 'q'],
    ]);

    // { script, latin } for a character outside the expected scripts, else
    // null. latin is its twin, or '' when it has none.
    function otherScript(cp) {
        const c = String.fromCodePoint(cp);
        if (ALLOWED.test(c)) return null;
        return { script: (SCRIPTS.find(([, re]) => re.test(c)) || ['Other'])[0], latin: LATIN_TWIN.get(cp) || '' };
    }

    // Styled letters that are not the letters they show: mathematical bold,
    // italic, script, fraktur and double-struck (what "fancy text" generators
    // use to slip past filters), and fullwidth Latin letters and digits.
    // { kind: 'styled' | 'fullwidth', to } for one code point, else null.
    // Fullwidth punctuation stays: fullwidth brackets and colons are
    // ordinary in CJK writing.
    function plainOf(cp) {
        if ((cp >= 0xFF10 && cp <= 0xFF19) || (cp >= 0xFF21 && cp <= 0xFF3A) || (cp >= 0xFF41 && cp <= 0xFF5A)) {
            return { kind: 'fullwidth', to: String.fromCharCode(cp - 0xFEE0) };
        }
        const math = cp >= 0x1D400 && cp <= 0x1D7FF;
        if (!math && !(cp >= 0x2100 && cp <= 0x214F)) return null;
        const to = String.fromCodePoint(cp).normalize('NFKC');
        // the letterlike block also holds ℃, ™ and №, which are symbols, not styled letters
        if (math ? to.length === 1 && /[\p{L}\p{Nd}]/u.test(to) : /^[A-Za-z]$/.test(to)) return { kind: 'styled', to };
        return null;
    }

    // Typographic punctuation with a plain ASCII twin, for text headed into
    // code, configuration or a shell. An em dash becomes "--", so a dash
    // between two words does not turn them into one hyphenated word.
    const ASCII_PUNCT = new Map([
        [0x2018, ['Left Single Quotation Mark', "'"]], [0x2019, ['Right Single Quotation Mark', "'"]],
        [0x201A, ['Single Low-9 Quotation Mark', "'"]], [0x201B, ['Single High-Reversed-9 Quotation Mark', "'"]],
        [0x201C, ['Left Double Quotation Mark', '"']], [0x201D, ['Right Double Quotation Mark', '"']],
        [0x201E, ['Double Low-9 Quotation Mark', '"']], [0x2032, ['Prime', "'"]], [0x2033, ['Double Prime', '"']],
        [0x2026, ['Horizontal Ellipsis', '...']], [0x2010, ['Hyphen', '-']], [0x2011, ['Non-Breaking Hyphen', '-']],
        [0x2012, ['Figure Dash', '-']], [0x2013, ['En Dash', '-']], [0x2014, ['Em Dash', '--']], [0x2212, ['Minus Sign', '-']],
    ]);

    // --- positions ---------------------------------------------------------

    // index → { line, col }, precomputed once per text.
    function locator(text) {
        const n = text.length;
        const cpBefore = new Uint32Array(n + 1);
        const starts = [0];
        for (let i = 0; i < n; i++) {
            const c = text.charCodeAt(i);
            const low = c >= 0xDC00 && c <= 0xDFFF && i > 0 && (text.charCodeAt(i - 1) & 0xFC00) === 0xD800;
            cpBefore[i + 1] = cpBefore[i] + (low ? 0 : 1);
            if (c === 0x0A || (c === 0x0D && text.charCodeAt(i + 1) !== 0x0A)) starts.push(i + 1);
        }
        return index => {
            let lo = 0, hi = starts.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (starts[mid] <= index) lo = mid; else hi = mid - 1;
            }
            return { line: lo + 1, col: cpBefore[index] - cpBefore[starts[lo]] + 1 };
        };
    }

    function codePoints(text) {
        const cps = [], at = [];
        for (let i = 0; i < text.length;) {
            const cp = text.codePointAt(i);
            cps.push(cp);
            at.push(i);
            i += cp > 0xFFFF ? 2 : 1;
        }
        at.push(text.length);
        return { cps, at };
    }

    // --- frames ------------------------------------------------------------

    const MAGIC = 0xA7;
    const T_TEXT = 0x11, T_ENCRYPTED = 0x12, T_WATERMARK = 0x13;
    // Part of frame version 1: changing it means a new version byte.
    const PBKDF2_ITERATIONS = 600000;
    const ZW_OPEN = '\u2062\u2064', ZW_CLOSE = '\u2064\u2062';

    function crc16(bytes) { // CRC-16/CCITT-FALSE
        let crc = 0xFFFF;
        for (const b of bytes) {
            crc ^= b << 8;
            for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
        }
        return crc;
    }

    function withCrc(bytes) {
        const crc = crc16(bytes);
        const out = new Uint8Array(bytes.length + 2);
        out.set(bytes);
        out[bytes.length] = crc >> 8;
        out[bytes.length + 1] = crc & 0xFF;
        return out;
    }

    const crcOk = b => b.length > 2 && crc16(b.subarray(0, -2)) === ((b[b.length - 2] << 8) | b[b.length - 1]);
    const concat = (...parts) => {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    };
    const toHex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    const vsChar = b => String.fromCodePoint(b < 16 ? 0xFE00 + b : 0xE0100 + b - 16);
    const vsByte = cp => cp <= 0xFE0F ? cp - 0xFE00 : cp - 0xE0100 + 16;
    const toVS = bytes => Array.from(bytes, vsChar).join('');

    function printable(s) {
        return s.length > 0 && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s);
    }

    function utf8(bytes) {
        try { return decStrict.decode(bytes); } catch (e) { return null; }
    }

    function parseFrame(b) {
        if (b.length < 4 || b[0] !== MAGIC) return null;
        if (b[1] === T_TEXT && crcOk(b)) {
            const text = utf8(b.subarray(2, -2));
            return text === null ? null : { kind: 'text', text };
        }
        if (b[1] === T_ENCRYPTED && b.length >= 2 + 16 + 12 + 16) return { kind: 'encrypted', data: Array.from(b) };
        if (b[1] === T_WATERMARK && b.length === 10 && crcOk(b)) return { kind: 'watermark', code: toHex(b.subarray(2, 8)) };
        return null;
    }

    // --- scan --------------------------------------------------------------

    // Hidden payloads, in order. Each is { scheme, kind, index, length, line,
    // col } plus text (kind 'text'), data (kind 'encrypted') or code (kind
    // 'watermark'). Schemes:
    //   frame     this module's variation-selector frame
    //   vs-text   variation selectors holding raw UTF-8 (the "emoji smuggling" trick)
    //   vs-bytes  two or more variation selectors in a row that decode to nothing
    //   tag       Unicode tag characters spelling out ASCII
    //   zw-binary the zero-width binary format other tools write
    function findPayloads(cps, at, loc, ctx) {
        const out = [];
        const push = (s, e, p) => out.push({ ...p, index: at[s], length: at[e] - at[s], ...loc(at[s]) });
        for (let k = 0; k < cps.length;) {
            const cp = cps[k];
            if (isVS(cp)) {
                let e = k;
                while (e < cps.length && isVS(cps[e])) e++;
                if (e - k >= 2) {
                    const bytes = Uint8Array.from(cps.slice(k, e), vsByte);
                    const frame = parseFrame(bytes);
                    const raw = frame ? null : utf8(bytes);
                    push(k, e, frame ? { scheme: 'frame', ...frame }
                        : raw !== null && printable(raw) ? { scheme: 'vs-text', kind: 'text', text: raw }
                            : { scheme: 'vs-bytes', kind: 'unknown', size: e - k });
                }
                k = e;
                continue;
            }
            if (isTag(cp)) {
                let e = k;
                while (e < cps.length && isTag(cps[e])) e++;
                if (!ctx.flag[k]) {
                    const ascii = cps.slice(k, e).filter(c => c >= 0xE0020 && c <= 0xE007E).map(c => String.fromCharCode(c - 0xE0000)).join('');
                    if (ascii) push(k, e, { scheme: 'tag', kind: 'text', text: ascii });
                }
                k = e;
                continue;
            }
            if (cp === 0x2062 && cps[k + 1] === 0x2064) {
                let e = k + 2;
                while (cps[e] === 0x200B || cps[e] === 0x200C) e++;
                const bits = e - k - 2;
                if (bits > 0 && bits % 8 === 0 && cps[e] === 0x2064 && cps[e + 1] === 0x2062) {
                    const bytes = new Uint8Array(bits / 8);
                    for (let j = 0; j < bits; j++) if (cps[k + 2 + j] === 0x200C) bytes[j >> 3] |= 0x80 >> (j & 7);
                    const text = utf8(bytes);
                    if (text !== null) {
                        push(k, e + 2, { scheme: 'zw-binary', kind: 'text', text });
                        k = e + 2;
                        continue;
                    }
                }
            }
            k++;
        }
        return out;
    }

    // Every special character with its position and whether it looks like a
    // normal use, plus the hidden payloads, letters from other scripts (each,
    // and counted per script), styled letters, whether the text is in NFC and
    // how many U+FFFD (a character lost to a wrong decoding somewhere) it
    // holds.
    function scan(text) {
        const loc = locator(text);
        const { cps, at } = codePoints(text);
        const ctx = contextOf(text, cps);
        const payloads = findPayloads(cps, at, loc, ctx);
        const chars = [];
        let p = 0;
        for (let k = 0; k < cps.length; k++) {
            const inf = info(cps[k]);
            if (!inf) continue;
            while (p < payloads.length && payloads[p].index + payloads[p].length <= at[k]) p++;
            const inPayload = p < payloads.length && payloads[p].index <= at[k] ? p : -1;
            chars.push({ ...inf, index: at[k], length: at[k + 1] - at[k], ...loc(at[k]),
                legit: inPayload < 0 && isLegit(cps, k, ctx), payload: inPayload });
        }
        const others = [], scripts = new Map();
        for (let k = 0; k < cps.length; k++) {
            const o = info(cps[k]) ? null : otherScript(cps[k]);
            if (!o) continue;
            others.push({ ...o, cp: cps[k], char: String.fromCodePoint(cps[k]), index: at[k], length: at[k + 1] - at[k], ...loc(at[k]) });
            const row = scripts.get(o.script);
            if (row) row.count++;
            else scripts.set(o.script, { script: o.script, count: 1, index: at[k], length: at[k + 1] - at[k] });
        }
        return {
            chars, payloads, others,
            scripts: [...scripts.values()].sort((a, b) => b.count - a.count),
            styled: cps.flatMap((cp, k) => {
                const p = plainOf(cp);
                return p ? [{ ...p, cp, char: String.fromCodePoint(cp), index: at[k], length: at[k + 1] - at[k], ...loc(at[k]) }] : [];
            }),
            nfc: text === text.normalize('NFC'),
            replacementChars: (text.match(/\uFFFD/g) || []).length,
        };
    }

    // --- clean -------------------------------------------------------------

    const CLEAN_DEFAULTS = {
        payloads: true,   // recognised hidden payloads, removed whole
        invisible: true, bidi: true, space: true, control: true, tag: true, variation: true,
        filler: true,     // Hangul / Braille fillers (Old Hangul ones next to jamo count as normal use)
        keepLegit: true,  // keep what isLegit() calls normal writing
        otherScripts: true, // letters outside Latin / Hangul / Han / kana → Latin twin, or removed
        styled: true,     // mathematical bold, italic, script … letters → plain
        fullwidth: true,  // fullwidth Latin letters and digits → ASCII
        ascii: false,     // typographic quotes, dashes, ellipsis → ASCII
        lineEnds: false,  // CRLF / CR → LF
        trailing: false,  // spaces and tabs at the end of a line
        blankLines: false, // three or more line breaks → one blank line
        nfc: false,
    };

    // Returns { text, edits }. Each edit says what happened where, in the
    // caller's text: { index, length, line, col, action: 'remove'|'replace',
    // kind: 'payload'|'char'|'script'|'styled'|'fullwidth'|'ascii'|
    // 'lineEnd'|'trailing'|'blankLines'|'nfc', to } plus cp/name/abbr/cat for
    // a character, cp/name for punctuation, cp/char/script for a letter of
    // another script, cp/char for a styled letter and payload for a payload.
    // Edits come in the order they appear in the text. Runs as passes over
    // the text so far; a map from each position back to the original keeps
    // every edit pointing into the text the caller has.
    function clean(text, options) {
        const o = { ...CLEAN_DEFAULTS, ...options };
        const loc = locator(text);
        const edits = [];
        let cur = text;
        let map = Array.from({ length: text.length + 1 }, (_, i) => i);

        // finds: sorted, non-overlapping { start, end, to, edit } in cur.
        function apply(finds) {
            if (!finds.length) return;
            const parts = [], next = [];
            let last = 0;
            for (const f of finds) {
                parts.push(cur.slice(last, f.start));
                for (let i = last; i < f.start; i++) next.push(map[i]);
                const from = map[f.start], to = f.end > f.start ? map[f.end - 1] + 1 : from;
                parts.push(f.to);
                for (let i = 0; i < f.to.length; i++) next.push(from);
                edits.push({ index: from, length: to - from, ...loc(from), action: f.to ? 'replace' : 'remove', to: f.to, ...f.edit });
                last = f.end;
            }
            parts.push(cur.slice(last));
            for (let i = last; i <= cur.length; i++) next.push(map[i]);
            cur = parts.join('');
            map = next;
        }

        if (o.payloads) {
            apply(scan(cur).payloads.map(p => ({ start: p.index, end: p.index + p.length, to: '',
                edit: { kind: 'payload', payload: { scheme: p.scheme, kind: p.kind, text: p.text, code: p.code } } })));
        }

        // Taking a character out can change a neighbor's context — a ZWNJ
        // kept between two Arabic letters has nothing to join once they are
        // gone — so this pass repeats until nothing is left to change:
        // cleaning the result again changes nothing.
        for (let round = 0; round < 4; round++) {
            const { cps, at } = codePoints(cur);
            const ctx = contextOf(cur, cps);
            const finds = [];
            for (let k = 0; k < cps.length; k++) {
                const cp = cps[k];
                const plain = plainOf(cp);
                if (plain && o[plain.kind]) {
                    finds.push({ start: at[k], end: at[k + 1], to: plain.to, edit: { kind: plain.kind, cp, char: String.fromCodePoint(cp) } });
                    continue;
                }
                if (o.ascii && ASCII_PUNCT.has(cp)) {
                    const [name, to] = ASCII_PUNCT.get(cp);
                    finds.push({ start: at[k], end: at[k + 1], to, edit: { kind: 'ascii', cp, name } });
                    continue;
                }
                const inf = info(cp);
                if (!inf) {
                    const other = o.otherScripts && otherScript(cp);
                    if (other) finds.push({ start: at[k], end: at[k + 1], to: other.latin, edit: { kind: 'script', cp, char: String.fromCodePoint(cp), script: other.script } });
                    continue;
                }
                if (!o[inf.cat] || (o.keepLegit && isLegit(cps, k, ctx))) continue;
                const to = inf.cat === 'space' ? (cp === 0x2028 || cp === 0x2029 ? '\n' : ' ') : cp === 0x85 ? '\n' : '';
                finds.push({ start: at[k], end: at[k + 1], to, edit: { kind: 'char', ...inf } });
            }
            if (!finds.length) break;
            apply(finds);
        }

        const regexPass = (re, to, kind) => apply(Array.from(cur.matchAll(re), m => ({ start: m.index, end: m.index + m[0].length, to, edit: { kind } })));
        if (o.lineEnds) regexPass(/\r\n?/g, '\n', 'lineEnd');
        if (o.trailing) regexPass(/[ \t]+(?=\r?\n|\r|$)/g, '', 'trailing');
        if (o.blankLines) regexPass(/(?:\r?\n|\r)(?:[ \t]*(?:\r?\n|\r)){2,}/g, '\n\n', 'blankLines');
        if (o.nfc) {
            const nf = [];
            for (const { segment, index } of segmenter.segment(cur)) {
                const n = segment.normalize('NFC');
                if (n !== segment) nf.push({ start: index, end: index + segment.length, to: n, edit: { kind: 'nfc', from: segment } });
            }
            apply(nf);
        }
        edits.sort((a, b) => a.index - b.index);
        return { text: cur, edits };
    }

    // Edits folded into rows for a summary: same kind, character and action
    // count together. Each row keeps its first edit for "where".
    function groupEdits(edits) {
        const rows = new Map();
        for (const e of edits) {
            const key = e.kind === 'char' || e.kind === 'ascii' || e.kind === 'script' ? e.kind + ':' + e.action + ':' + e.cp
                : e.kind === 'payload' ? 'payload:' + e.payload.scheme + ':' + e.payload.kind : e.kind;  // styled / fullwidth: one row each
            const row = rows.get(key);
            if (row) row.count++;
            else rows.set(key, { key, count: 1, first: e });
        }
        return [...rows.values()];
    }

    // --- crypto ------------------------------------------------------------

    async function aesKey(passphrase, salt) {
        const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
        return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
            base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }

    async function encryptedFrame(message, passphrase) {
        const head = Uint8Array.of(MAGIC, T_ENCRYPTED);
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await aesKey(passphrase, salt);
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: head }, key, enc.encode(message)));
        return concat(head, salt, iv, ct);
    }

    // The message inside an encrypted payload from scan(); throws on a wrong
    // passphrase.
    async function decrypt(payload, passphrase) {
        const b = Uint8Array.from(payload.data);
        const key = await aesKey(passphrase, b.subarray(2, 18));
        try {
            const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(18, 30), additionalData: b.subarray(0, 2) }, key, b.subarray(30));
            return new TextDecoder().decode(pt);
        } catch (e) {
            throw new Error('Wrong passphrase, or the hidden message was damaged');
        }
    }

    // 6 bytes of HMAC-SHA256(key, recipient): without the key the code says
    // nothing, and nobody can make the code of another recipient.
    async function watermarkCode(key, recipient) {
        const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const mac = await crypto.subtle.sign('HMAC', k, enc.encode('localutil-watermark-v1\0' + recipient.trim().normalize('NFC')));
        return new Uint8Array(mac, 0, 6);
    }

    // Which recipients' codes appear among the payloads, most hits first.
    async function identify(payloads, key, recipients) {
        const found = payloads.filter(p => p.kind === 'watermark').map(p => p.code);
        const results = [];
        for (const name of recipients.map(r => r.trim()).filter(Boolean)) {
            const code = toHex(await watermarkCode(key, name));
            results.push({ name, code, hits: found.filter(c => c === code).length });
        }
        results.sort((a, b) => b.hits - a.hits);
        return { total: found.length, results };
    }

    function generateKey() {
        const b = crypto.getRandomValues(new Uint8Array(32));
        return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    // --- mark --------------------------------------------------------------

    // Where hidden characters can go without changing what anyone sees.
    // Only between grapheme clusters, so never inside an emoji, a flag or a
    // decomposed Hangul syllable. 'vs': right after a single Latin letter,
    // Hangul syllable or kana — characters with no variation sequences of
    // their own, so the selectors there mean nothing and stay attached to that
    // letter. 'zw': right after an ASCII space — the space already breaks
    // joining, so a ZWNJ next to it cannot reshape Arabic or Indic letters.
    const ANCHOR = /^[A-Za-z\uAC00-\uD7A3\u3041-\u3096\u30A1-\u30FA]$/;

    function slots(text, carrier) {
        const out = [];
        for (const { segment, index } of segmenter.segment(text)) {
            if (carrier === 'zw' ? segment === ' ' : ANCHOR.test(segment)) out.push(index + segment.length);
        }
        return out;
    }

    class MarkError extends Error {}

    // The payload goes into the first slot and then into the first slot at
    // least `every` UTF-16 units after the previous one; every = 0 → once.
    function place(text, payload, carrier, every) {
        const all = slots(text, carrier);
        if (!all.length) {
            throw new MarkError(carrier === 'zw' ? 'There is no space in the text to put the hidden characters after.'
                : 'There is no Latin letter, Hangul syllable or kana in the text to attach the hidden characters to.');
        }
        const picked = [];
        let next = 0;
        for (const s of all) {
            if (s < next) continue;
            picked.push(s);
            if (!every) break;
            next = s + every;
        }
        const parts = [], insertions = [];
        let last = 0, len = 0;
        for (const s of picked) {
            parts.push(text.slice(last, s));
            len += s - last;
            insertions.push({ index: len, length: payload.length });
            parts.push(payload);
            len += payload.length;
            last = s;
        }
        parts.push(text.slice(last));
        const out = parts.join('');
        return {
            text: out,
            insertions,
            hiddenChars: Array.from(payload).length * picked.length,
            addedBytes: enc.encode(payload).length * picked.length,
            check: verify(text, out, insertions),
        };
    }

    // Takes the inserted ranges back out and compares: the text must come
    // back exactly, every grapheme cluster must be the same one, and each
    // insertion must read back as a payload.
    function verify(original, marked, insertions) {
        const mask = new Uint8Array(marked.length);
        for (const { index, length } of insertions) mask.fill(1, index, index + length);
        // s is the part of marked starting at from, minus what was inserted
        const unmarked = (s, from) => {
            let r = '';
            for (let i = 0; i < s.length; i++) if (!mask[from + i]) r += s[i];
            return r;
        };
        const sameText = unmarked(marked, 0) === original;
        const before = Array.from(segmenter.segment(original), s => s.segment);
        const after = [];
        for (const { segment, index } of segmenter.segment(marked)) {
            const s = unmarked(segment, index);
            if (s) after.push(s);
        }
        const sameGraphemes = before.length === after.length && before.every((g, i) => g === after[i]);
        const found = new Set(scan(marked).payloads.map(p => p.index));
        const decoded = insertions.filter(ins => found.has(ins.index)).length;
        return { ok: sameText && sameGraphemes && decoded === insertions.length, sameText, sameGraphemes, graphemes: before.length, decoded };
    }

    function zwBinary(message) {
        let bits = '';
        for (const b of enc.encode(message)) for (let i = 7; i >= 0; i--) bits += b >> i & 1 ? '\u200C' : '\u200B';
        return ZW_OPEN + bits + ZW_CLOSE;
    }

    // opts: { passphrase, carrier: 'vs' | 'zw', every }
    async function markMessage(text, message, opts = {}) {
        if (!message) throw new MarkError('Write the message to hide.');
        const carrier = opts.carrier || 'vs';
        if (carrier === 'zw' && opts.passphrase) throw new MarkError('Encryption needs the variation selector method.');
        const payload = carrier === 'zw' ? zwBinary(message)
            : toVS(opts.passphrase ? await encryptedFrame(message, opts.passphrase) : withCrc(concat(Uint8Array.of(MAGIC, T_TEXT), enc.encode(message))));
        return place(text, payload, carrier, opts.every || 0);
    }

    // opts: { every } — default about every 300 characters
    async function markWatermark(text, key, recipient, opts = {}) {
        if (!key) throw new MarkError('Enter or generate a key.');
        if (!recipient.trim()) throw new MarkError('Enter a recipient.');
        const code = await watermarkCode(key, recipient);
        const r = place(text, toVS(withCrc(concat(Uint8Array.of(MAGIC, T_WATERMARK), code))), 'vs', opts.every ?? 300);
        return { ...r, code: toHex(code) };
    }

    window.LocalUtilUnicode = {
        info, hex, scan, clean, groupEdits, CLEAN_DEFAULTS,
        decrypt, identify, generateKey, markMessage, markWatermark, slots, verify, MarkError,
    };
})();
