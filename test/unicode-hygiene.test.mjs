import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

const load = () => env.goto('unicode-hygiene.html');

// Runs fn(LocalUtilUnicode, arg) in the page and returns its result.
const U = (fn, arg) => env.page.evaluate(
    ([src, a]) => new Function('U', 'a', 'return (' + src + ')(U, a)')(window.LocalUtilUnicode, a),
    [fn.toString(), arg]);

// The zero-width binary format other tools read and write, encoded here
// independently of the module.
function zwEncode(message) {
    let bits = '';
    for (const b of Buffer.from(message, 'utf8')) for (let i = 7; i >= 0; i--) bits += b >> i & 1 ? '\u200C' : '\u200B';
    return '\u2062\u2064' + bits + '\u2064\u2062';
}
const tags = s => Array.from(s, c => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join('');
const vsBytes = bytes => Array.from(bytes, b => String.fromCodePoint(b < 16 ? 0xFE00 + b : 0xE0100 + b - 16)).join('');

const FAMILY = '👨\u200D👩\u200D👧';
const PERSIAN = 'می\u200Cخواهم';
const ENGLAND = '🏴' + tags('gbeng') + '\u{E007F}';

test('scan names what it finds and where', async () => {
    await load();
    const r = await U((U, t) => U.scan(t), 'ab\u200Bc\r\n😀x\u202Ey');
    assert.deepEqual(r.chars.map(c => [c.abbr, c.cat, c.index, c.line, c.col, c.legit]), [
        ['ZWSP', 'invisible', 2, 1, 3, false],
        ['RLO', 'bidi', 9, 2, 3, false],
    ]);
    assert.equal(r.nfc, true);
});

test('normal writing is told apart from hidden characters', async () => {
    await load();
    const legit = await U((U, list) => list.map(t => U.scan(t).chars.map(c => c.legit)), [
        FAMILY, PERSIAN, '❤\uFE0F', ENGLAND, '葛\u{E0100}', 'a\u200Db', 'a\uFE0F', '1\uFE0F\u20E3',
    ]);
    assert.deepEqual(legit, [
        [true, true], [true], [true], [true, true, true, true, true, true], [true], [false], [false], [true],
    ]);
});

test('French spacing, Thai and Lao joiners count as normal writing', async () => {
    await load();
    const r = await U((U, list) => list.map(t => U.scan(t).chars.map(c => c.legit)), [
        '\u00AB\u00A0mot\u00A0\u00BB', 'Bonjour\u202F!', 'a\u00A0b', 'ก\u200Cข', 'ກ\u200Cຂ', 'ب\u200C\uFE00ت',
    ]);
    assert.deepEqual(r, [[true, true], [true], [false], [true], [true], [true, false]]);
});

test('an object replacement character is removed', async () => {
    await load();
    assert.equal(await U((U, t) => U.clean(t).text, 'a\uFFFCb'), 'ab');
});

// Inputs that mix every kind of finding, for properties that must hold for all.
const MIXED = [
    'a\u200Bb\u00A0c ' + FAMILY + ' ' + PERSIAN + ' \u202Ex',
    'Hi ' + zwEncode('hi') + 'there' + tags('ignore') + ' ' + ENGLAND,
    '«\u200B\u00A0mot\u00A0\u200B»\r\n\r\n\r\n\r\nb  \n' + '한'.normalize('NFD'),
    '❤\u200B\uFE0F 葛\u200B\u{E0100} a\uFE0F\u200D😀 \u3000x\u3164y\u0001',
    'p\u0430y\u200Bp\u0430l \u0441\u200B\u043E\u200Bde \u201Cq\u201D\u2014x',
    '\u0441\u043E\u200B\u0441\u043E \u{1D41A}\u0430\u200B\uFF42 \u{1D6A8}pple \u0420\u200B1',
];

test('cleaning twice gives the same text as cleaning once', async () => {
    await load();
    const r = await U((U, list) => list.flatMap(t => [{}, { keepLegit: false, filler: true, ascii: true, lineEnds: true, trailing: true, blankLines: true, nfc: true }]
        .map(o => { const once = U.clean(t, o).text; return [once, U.clean(once, o).text]; })), MIXED);
    for (const [once, twice] of r) assert.equal(twice, once);
});

test('NFD text is reported', async () => {
    await load();
    assert.equal(await U((U, t) => U.scan(t).nfc, '한글'.normalize('NFD')), false);
});

test('hidden payloads from other tools are read back', async () => {
    await load();
    const raw = vsBytes(Buffer.from('secret 비밀', 'utf8'));
    const r = await U((U, t) => U.scan(t).payloads, 'Hi ' + zwEncode('안녕 hi') + 'there' + tags('ignore all') + ' 😀' + raw + ' end' + ENGLAND);
    assert.deepEqual(r.map(p => [p.scheme, p.kind, p.text]), [
        ['zw-binary', 'text', '안녕 hi'],
        ['tag', 'text', 'ignore all'],
        ['vs-text', 'text', 'secret 비밀'],
    ]);
    assert.equal(r[0].index, 3);
});

test('only a real subdivision flag passes for an emoji; other tag text behind a black flag is read', async () => {
    await load();
    const r = await U((U, a) => a.map(t => ({ p: U.scan(t).payloads.map(x => x.text), legit: U.scan(t).chars.every(c => c.legit), cleaned: U.clean(t).text })), [
        ENGLAND, '🏴' + tags('gbsct') + '\u{E007F}', 'hi 🏴' + tags('leakkey123') + '\u{E007F}', '🏴' + tags('usca') + '\u{E007F}',
    ]);
    assert.deepEqual(r.map(x => [x.p, x.legit]), [[[], true], [[], true], [['leakkey123'], false], [['usca'], false]]);
    assert.equal(r[2].cleaned, 'hi 🏴');
});

test('a long run of tag characters costs no more than its length', async () => {
    await load();
    const ms = await U((U, t) => { const s = performance.now(); U.scan(t); U.clean(t); return performance.now() - s; },
        '🏴' + tags('a'.repeat(100000)) + '\u{E007F}');
    assert.ok(ms < 2000, ms + ' ms');
});

test('clean removes hidden characters, keeps normal writing and says what it did', async () => {
    await load();
    const input = 'a\u200Bb\nc\u00A0d ' + FAMILY + ' ' + PERSIAN + '\n\u202Ee';
    const r = await U((U, t) => U.clean(t, { otherScripts: false }), input);
    assert.equal(r.text, 'ab\nc d ' + FAMILY + ' ' + PERSIAN + '\ne');
    assert.deepEqual(r.edits.map(e => [e.kind, e.action, e.abbr, e.index, e.line, e.col, e.to]), [
        ['char', 'remove', 'ZWSP', 1, 1, 2, ''],
        ['char', 'replace', 'NBSP', 5, 2, 2, ' '],
        ['char', 'remove', 'RLO', input.indexOf('\u202E'), 3, 1, ''],
    ]);
});

test('clean can drop normal uses too; fillers go, except inside an Old Hangul syllable', async () => {
    await load();
    // U+1100 choseong + U+1160 jungseong filler + U+11A8 jongseong: an Old Hangul syllable
    const oldHangul = '\u1100\u1160\u11A8';
    const [strict, filler, old] = await U((U, a) => [U.clean(a[0], { keepLegit: false }).text, U.clean(a[1]).text, U.clean(a[2]).text],
        [FAMILY, 'x\u3164y\u2800z', oldHangul]);
    assert.equal(strict, '👨👩👧');
    assert.equal(filler, 'xyz');
    assert.equal(old, oldHangul);
});

test('a payload is removed whole, as one edit', async () => {
    await load();
    const input = 'Hi ' + zwEncode('hi') + 'there';
    const r = await U((U, t) => { const c = U.clean(t); return { text: c.text, rows: U.groupEdits(c.edits) }; }, input);
    assert.equal(r.text, 'Hi there');
    assert.deepEqual(r.rows.map(x => [x.key, x.count, x.first.payload.text, x.first.length]), [['payload:zw-binary:text', 1, 'hi', input.length - 8]]);
});

test('line cleanup and NFC point back into the original text', async () => {
    await load();
    const input = 'a  \r\nb\r\n\r\n\r\n\r\n' + '한'.normalize('NFD') + '\u200B';
    const r = await U((U, t) => U.clean(t, { lineEnds: true, trailing: true, blankLines: true, nfc: true }), input);
    assert.equal(r.text, 'a\nb\n\n한');
    assert.deepEqual(r.edits.map(e => [e.kind, e.index, e.line]), [
        ['trailing', 1, 1],
        ['lineEnd', 3, 1],
        ['lineEnd', 6, 2], ['blankLines', 6, 2],
        ['lineEnd', 8, 3], ['lineEnd', 10, 4], ['lineEnd', 12, 5],
        ['nfc', 14, 6],
        ['char', input.length - 1, 6],
    ]);
});

// Other-script letters are written as escapes, so the test shows what it hides.
const SPOOF = 'p\u0430ypal'; // "paypal" with a Cyrillic a (U+0430)

test('letters outside Latin, Hangul, Han and kana are listed one by one', async () => {
    await load();
    const r = await U((U, list) => list.map(t => U.scan(t).others.map(o => [o.cp.toString(16), o.script, o.latin, o.line, o.col])), [
        'Log in to ' + SPOOF, 'https://\u03A7.com', '5 \u03BCm', '안녕 漢字 かな 123 😀 é ' + FAMILY,
    ]);
    assert.deepEqual(r, [
        [['430', 'Cyrillic', 'a', 1, 12]],
        [['3a7', 'Greek', 'X', 1, 9]],
        [['3bc', 'Greek', '', 1, 3]],
        [],
    ]);
});

test('clean gives each one its Latin twin or removes it, and leaves them alone when off', async () => {
    await load();
    const list = [SPOOF, 'https://\u03A7.com', 'pa\u0436pal', '5 \u03BCm'];
    const r = await U((U, list) => list.map(t => { const c = U.clean(t); return [c.text, c.edits.map(e => [e.kind, e.action, e.script, e.to]), U.clean(t, { otherScripts: false }).text]; }), list);
    assert.deepEqual(r.map(x => x[0]), ['paypal', 'https://X.com', 'papal', '5 m']);
    assert.deepEqual(r.map(x => x[1]), [
        [['script', 'replace', 'Cyrillic', 'a']], [['script', 'replace', 'Greek', 'X']],
        [['script', 'remove', 'Cyrillic', '']], [['script', 'remove', 'Greek', '']],
    ]);
    assert.deepEqual(r.map(x => x[2]), list);
});

test('styled and fullwidth letters turn plain; symbols and fullwidth punctuation stay', async () => {
    await load();
    const t = '\u{1D429}\u{1D41A}\u{1D432} \u2113 \u2103 \uFF50\uFF41\uFF59\uFF10 \uFF08주\uFF09 \u{1D6C2}';
    const r = await U((U, t) => ({ scan: U.scan(t).styled.map(x => x.kind + ':' + x.to).join(' '), clean: U.clean(t).text,
        off: U.clean(t, { styled: false, fullwidth: false }).text, rows: U.groupEdits(U.clean(t).edits).map(g => g.key + ':' + g.count) }), t);
    assert.equal(r.scan, 'styled:p styled:a styled:y styled:l fullwidth:p fullwidth:a fullwidth:y fullwidth:0 styled:\u03B1');
    // a math Greek letter becomes a Greek one, which the other-scripts rule then removes
    assert.equal(r.clean, 'pay l \u2103 pay0 \uFF08주\uFF09 ');
    assert.equal(r.off, t);
    assert.deepEqual(r.rows, ['styled:5', 'fullwidth:4', 'script:remove:945:1']);
});

test('letters from other writing systems are counted by script', async () => {
    await load();
    const r = await U((U, t) => U.scan(t).scripts.map(x => [x.script, x.count, x.index]), '안녕 hello Москва שלום 漢字 かな \u03BD');
    assert.deepEqual(r, [['Cyrillic', 6, 9], ['Hebrew', 4, 16], ['Greek', 1, 27]]);
});

test('typographic punctuation turns ASCII only when asked', async () => {
    await load();
    const t = '\u201CHi\u201D \u2014 it\u2019s 3\u20134\u2026 \u22121';
    const r = await U((U, t) => [U.clean(t).text, U.clean(t, { ascii: true }).text, U.groupEdits(U.clean(t, { ascii: true }).edits).length], t);
    assert.deepEqual(r, [t, '"Hi" -- it\'s 3-4... -1', 7]);
});

test('replacement characters are counted', async () => {
    await load();
    assert.deepEqual(await U((U, a) => a.map(t => U.scan(t).replacementChars), ['caf\uFFFD \uFFFD', 'café']), [2, 0]);
});

test('a hidden message reads back and leaves the visible text alone', async () => {
    await load();
    const r = await U(async (U, t) => {
        const m = await U.markMessage(t, '회의는 3시 🙂');
        return { m, payloads: U.scan(m.text).payloads, cleaned: U.clean(m.text).text };
    }, 'Hello, 세상.');
    assert.deepEqual(r.payloads.map(p => [p.scheme, p.kind, p.text]), [['frame', 'text', '회의는 3시 🙂']]);
    assert.equal(r.m.text.slice(0, 1), 'H');
    assert.equal(r.m.insertions[0].index, 1);
    assert.equal(r.m.check.ok, true);
    assert.equal(r.cleaned, 'Hello, 세상.');
});

test('an encrypted message needs its passphrase', async () => {
    await load();
    const r = await U(async (U, t) => {
        const m = await U.markMessage(t, 'top secret', { passphrase: 'correct horse' });
        const p = U.scan(m.text).payloads[0];
        let wrong;
        try { await U.decrypt(p, 'nope'); } catch (e) { wrong = e.message; }
        return { kind: p.kind, text: p.text, plain: await U.decrypt(p, 'correct horse'), wrong, ok: m.check.ok };
    }, 'Some text');
    assert.equal(r.kind, 'encrypted');
    assert.equal(r.text, undefined);
    assert.equal(r.plain, 'top secret');
    assert.match(r.wrong, /Wrong passphrase/);
    assert.equal(r.ok, true);
});

test('the zero-width format stays readable by other tools and refuses encryption', async () => {
    await load();
    const r = await U(async (U, t) => {
        const m = await U.markMessage(t, '안녕', { carrier: 'zw' });
        let err;
        try { await U.markMessage(t, 'x', { carrier: 'zw', passphrase: 'p' }); } catch (e) { err = e.message; }
        return { text: m.text, ok: m.check.ok, err };
    }, 'one two');
    assert.equal(r.text, 'one ' + zwEncode('안녕') + 'two');
    assert.equal(r.ok, true);
    assert.match(r.err, /Encryption needs/);
});

test('nothing goes inside emoji, flags, decomposed Hangul or joined scripts', async () => {
    await load();
    const tricky = FAMILY + '🇰🇷🇯🇵 ' + '한국어'.normalize('NFD') + ' ' + PERSIAN + ' नमस्ते ' + ENGLAND + ' é'.normalize('NFD') + ' ok 가';
    const r = await U(async (U, t) => {
        const vs = await U.markMessage(t, 'm', { every: 1 });
        const zw = await U.markMessage(t, 'm', { carrier: 'zw', every: 1 });
        return { vs: vs.check, zw: zw.check, vsSlots: U.slots(t, 'vs'), zwSlots: U.slots(t, 'zw') };
    }, tricky);
    assert.equal(r.vs.ok, true);
    assert.equal(r.zw.ok, true);
    const anchors = r.vsSlots.map(i => tricky.slice(0, i).at(-1));
    assert.deepEqual(anchors, ['o', 'k', '가']);
    assert.ok(r.zwSlots.every(i => tricky[i - 1] === ' '));
});

test('the check catches an insertion that merges or splits what you see', async () => {
    await load();
    const r = await U((U, cases) => cases.map(([o, m, i]) => U.verify(o, m, [{ index: i, length: 1 }]).sameGraphemes), [
        ['👍👍', '👍\u200D👍', 2],     // ZWJ fuses two emoji into one cluster
        ['🇰🇷', '🇰\u200B🇷', 2],       // a flag split into two letters
        ['ab', 'a\u200Bb', 1],
    ]);
    assert.deepEqual(r, [false, false, true]);
});

test('text with nowhere safe to hide is refused', async () => {
    await load();
    const errs = await U(async (U, a) => {
        const out = [];
        for (const [t, carrier] of a) {
            try { await U.markMessage(t, 'x', { carrier }); out.push(null); } catch (e) { out.push(e instanceof U.MarkError); }
        }
        return out;
    }, [[PERSIAN, 'vs'], ['한국어', 'zw']]);
    assert.deepEqual(errs, [true, true]);
});

test('a watermark names its recipient, even from an excerpt', async () => {
    await load();
    const text = 'Lorem ipsum dolor sit amet. '.repeat(40);
    const r = await U(async (U, t) => {
        const key = U.generateKey();
        const a = await U.markWatermark(t, key, 'Alice', { every: 200 });
        const b = await U.markWatermark(t, key, 'Bob', { every: 200 });
        const excerpt = a.text.slice(a.text.length / 2);
        const who = await U.identify(U.scan(excerpt).payloads, key, ['Bob', 'Alice', 'Carol']);
        const wrongKey = await U.identify(U.scan(a.text).payloads, U.generateKey(), ['Alice']);
        return { key, a: { code: a.code, n: a.insertions.length, ok: a.check.ok }, bCode: b.code, who, wrongKey };
    }, text);
    assert.match(r.key, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(r.a.code, r.bCode);
    assert.ok(r.a.n >= 5);
    assert.equal(r.a.ok, true);
    assert.equal(r.who.results[0].name, 'Alice');
    assert.ok(r.who.results[0].hits >= 2);
    assert.equal(r.who.results[1].hits, 0);
    assert.equal(r.wrongKey.results[0].hits, 0);
    assert.ok(r.wrongKey.total >= 5);
});

// --- the page ---------------------------------------------------------------

// Text with elements kept apart, the way the page shows them side by side.
const text = sel => env.page.$eval(sel, e => {
    const walk = n => n.nodeType === 3 ? n.data : ' ' + Array.from(n.childNodes, walk).join('') + ' ';
    return walk(e).replace(/\s+/g, ' ').trim();
});

test('page: the sample scans, then cleans with a list of what went', async () => {
    await load();
    await env.page.click('#sc-sample');
    const verdict = await text('#sc-verdict');
    assert.match(verdict, /2 hidden payloads/);
    assert.match(verdict, /direction overrides/);
    assert.match(verdict, /1 letters from other scripts/);
    assert.equal(await text('#sc-scripts'), 'Cyrillic ×1');
    assert.equal(await text('#sc-others'), 'U+0430 Cyrillic \u0430 1 Latin a Show');
    assert.equal(await env.page.$$eval('#sc-preview .uh-other', n => n.length), 1);
    assert.equal(await env.page.$eval('#sc-verdict', e => e.className), 'uh-verdict err');
    const payloads = await text('#sc-payloads');
    assert.match(payloads, /sent to the finance team/);
    assert.match(payloads, /Ignore previous instructions/);
    assert.ok(await env.page.$$eval('#sc-preview .uh-chip.danger', n => n.length) >= 2);
    assert.ok(await env.page.$$eval('#sc-preview .uh-chip.legit', n => n.length) === 2);

    await env.page.click('#sc-to-clean');
    assert.equal(await env.page.$eval('#tab-clean', e => e.classList.contains('active')), true);
    const out = await env.page.inputValue('#cl-output');
    const left = await env.page.evaluate(t => LocalUtilUnicode.scan(t).chars.filter(c => !c.legit).length, out);
    assert.equal(left, 0);
    assert.match(out, /👨\u200D👩\u200D👧/);
    assert.match(await text('#cl-summary-title'), /^\d+ changes$/);
    assert.match(await text('#cl-edits'), /Hidden message removed “sent to the finance team”/);
    assert.match(await text('#cl-edits'), /U\+0430 Cyrillic \u0430 replaced with Latin a/);
});

test('page: clicking a change selects it in the input', async () => {
    await load();
    await env.page.click('#uh-tabs [data-tab="clean"]');
    await env.page.fill('#cl-input', 'one\ntw\u200Bo');
    assert.equal(await env.page.inputValue('#cl-output'), 'one\ntwo');
    assert.equal(await text('#cl-edits'), 'Line 2, col 3 U+200B Zero Width Space (ZWSP) removed');
    await env.page.click('#cl-edits li');
    assert.deepEqual(await env.page.$eval('#cl-input', e => [e.selectionStart, e.selectionEnd]), [6, 7]);
    await env.page.uncheck('#cl-invisible');
    assert.equal(await text('#cl-summary-title'), 'Nothing to change');
    await env.page.fill('#cl-input', '\u201Cok\u201D');
    await env.page.check('#cl-ascii');
    assert.equal(await env.page.inputValue('#cl-output'), '"ok"');
    assert.match(await text('#cl-summary-chips'), /U\+201C Left Double Quotation Mark replaced with " ×1/);
});

test('page: notes about the whole text, and Clean picks the fix up', async () => {
    await load();
    await env.page.fill('#sc-input', 'c' + '한'.normalize('NFD') + ' caf\uFFFD \uFF21\uFF22 \u05E9\u05DC\u05D5\u05DD');
    const notes = await text('#sc-notes');
    assert.match(notes, /not in NFC/);
    assert.match(notes, /1 replacement characters \(U\+FFFD\)\./);
    assert.match(notes, /2 styled or fullwidth letters\./);
    assert.equal(await text('#sc-verdict'), '4 letters from other scripts · 2 styled letters');
    assert.equal(await text('#sc-scripts'), 'Hebrew ×4');
    assert.equal(await env.page.$$eval('#sc-preview .uh-styled', n => n.length), 2);
    await env.page.click('#sc-to-clean');
    assert.equal(await env.page.inputValue('#cl-output'), 'c한 caf\uFFFD AB ');
    await env.page.uncheck('#cl-otherScripts');
    assert.equal(await env.page.inputValue('#cl-output'), 'c한 caf\uFFFD AB \u05E9\u05DC\u05D5\u05DD');
    assert.match(await text('#cl-summary-chips'), /Fullwidth letters made ASCII ×2/);
});

test('page: an encrypted message goes out and opens in Scan', async () => {
    await load();
    await env.page.click('#uh-tabs [data-tab="mark"]');
    await env.page.fill('#mk-input', 'Quarterly numbers attached.');
    await env.page.fill('#mk-message', '진짜 숫자는 2번 시트');
    await env.page.check('#mk-encrypt');
    await env.page.click('#mk-run');
    assert.match(await env.page.textContent('#mk-error'), /Enter a passphrase/);
    await env.page.fill('#mk-pass', 'hunter2');
    await env.page.click('#mk-run');
    await env.page.waitForSelector('#mk-result:not([hidden])');
    assert.match(await text('#mk-check'), /✔ Visible text unchanged — \d+ characters compared ✔ 1 \/ 1 copies read back/);
    await env.page.click('#mk-scan');
    assert.match(await text('#sc-payloads'), /Encrypted message/);
    await env.page.fill('#sc-payloads input[type=password]', 'hunter2');
    await env.page.click('#sc-payloads button');
    await env.page.waitForSelector('#sc-payloads pre');
    assert.equal(await text('#sc-payloads pre'), '진짜 숫자는 2번 시트');
});

test('page: watermark copies, then a leaked one is traced', async () => {
    await load();
    await env.page.click('#uh-tabs [data-tab="mark"]');
    await env.page.click('#mk-mode [data-mode="watermark"]');
    const body = 'This plan is confidential and for your eyes only. '.repeat(20);
    await env.page.fill('#mk-input', body);
    await env.page.fill('#mk-recipients', 'Alice\nBob\nAlice');
    await env.page.click('#mk-run');
    await env.page.waitForSelector('#mk-copies-card:not([hidden])');
    assert.equal(await env.page.$$eval('.uh-copy', n => n.length), 2);
    assert.match(await text('#mk-copies'), /Alice [0-9a-f]{12} \d+ places ✔ checked/);

    const key = await env.page.inputValue('#mk-key');
    const leaked = await env.page.evaluate(([t, k]) => LocalUtilUnicode.markWatermark(t, k, 'Bob').then(r => r.text.slice(400)), [body, key]);
    await env.page.click('#uh-tabs [data-tab="scan"]');
    await env.page.fill('#sc-input', leaked);
    await env.page.fill('#sc-payloads input.mono', key);
    await env.page.fill('#sc-payloads textarea', 'Alice\nBob');
    await env.page.click('#sc-payloads .btn-primary');
    await env.page.waitForSelector('.uh-found');
    assert.match(await text('.uh-found'), /^Bob — \d+ \/ \d+ watermarks match$/);
});
