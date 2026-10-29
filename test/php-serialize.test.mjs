import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

// Runs fn(LocalUtilPHP, arg) in the page and returns its result.
const php = (fn, arg) => env.page.evaluate(
    ([src, a]) => new Function('P', 'a', 'return (' + src + ')(P, a)')(window.LocalUtilPHP, a),
    [fn.toString(), arg]);

// Real PHP 8 output, covering every type and NUL-marked property names.
const SAMPLES = [
    'a:2:{s:4:"name";s:5:"Alice";s:3:"age";i:30;}',
    'a:3:{i:0;d:0.1;i:1;d:-1.0E+25;i:2;d:INF;}',
    'a:2:{i:0;b:1;i:1;N;}',
    's:9:"홍길동";',
    'i:9223372036854775807;',
    'O:4:"User":3:{s:2:"id";i:7;s:8:"\0*\0email";s:1:"x";s:10:"\0User\0pass";N;}',
    'C:11:"ArrayObject":21:{x:i:0;a:0:{};m:a:0:{}}',
    'a:1:{s:1:"s";E:11:"Suit:Hearts";}',
    'a:2:{i:0;O:8:"stdClass":0:{}i:1;r:2;}',
    'a:2:{i:0;i:1;i:1;R:2;}',
    'a:1:{s:1:"k";s:14:"a:1:{i:0;i:1;}";}',
];

test('unserialize then serialize gives back the same bytes', async () => {
    await env.goto('php-serialize.html');
    for (const s of SAMPLES) {
        const out = await php((P, s) => P.serialize(P.unserialize(s).value), s);
        assert.equal(out, s);
    }
});

test('values keep their PHP types', async () => {
    await env.goto('php-serialize.html');
    const v = await php((P, s) => P.unserialize(s).value, 'a:3:{i:5;i:9223372036854775807;s:1:"f";d:0.1;s:1:"s";s:3:"a;b";}');
    assert.deepEqual(v, { t: 'array', items: [
        { k: { t: 'int', v: '5' }, v: { t: 'int', v: '9223372036854775807' } },
        { k: { t: 'string', v: 'f' }, v: { t: 'float', v: '0.1' } },
        { k: { t: 'string', v: 's' }, v: { t: 'string', v: 'a;b' } },
    ] });
});

test('string lengths are UTF-8 bytes; a character count is read with a warning', async () => {
    await env.goto('php-serialize.html');
    assert.deepEqual(await php((P, s) => P.unserialize(s), 's:6:"한글";'),
        { value: { t: 'string', v: '한글' }, warnings: [], rest: '' });
    const r = await php((P, s) => P.unserialize(s), 's:2:"한글";');
    assert.equal(r.value.v, '한글');
    assert.equal(r.warnings.length, 1);
    assert.equal(await php((P, s) => P.serialize({ t: 'string', v: s }), '한글'), 's:6:"한글";');
});

test('broken input names the byte where it went wrong', async () => {
    await env.goto('php-serialize.html');
    const err = s => php((P, s) => { try { P.unserialize(s); return null; } catch (e) { return [e.message, e.offset]; } }, s);
    assert.deepEqual(await err('a:2:{i:0;i:1;}'), ['Declared 2 entries but found 1 at byte 13', 13]);
    assert.deepEqual(await err('a:1:{d:1.5;i:1;}'), ['Keys must be int or string at byte 5', 5]);
    assert.match((await err('s:9:"abc";'))[0], /not 9 bytes long/);
    assert.match((await err('i:1;x'))[0], /Unexpected text after the value/);
    assert.match((await err('q:1;'))[0], /Unknown type "q"/);
});

test('JSON mapping round-trips objects, lists, maps and int-like keys', async () => {
    await env.goto('php-serialize.html');
    const json = await php((P, s) => P.toJSON(P.unserialize(s).value), SAMPLES[5]);
    assert.deepEqual(json, { __class: 'User', id: 7, '\0*\0email': 'x', '\0User\0pass': null });
    for (const s of [SAMPLES[0], SAMPLES[5], SAMPLES[6], SAMPLES[7], SAMPLES[9]]) {
        assert.equal(await php((P, s) => P.serialize(P.fromJSON(P.toJSON(P.unserialize(s).value))), s), s);
    }
    assert.equal(await php((P, j) => P.serialize(P.fromJSON(j)), { '0': 'a', '-3': 1.5, '07': [true, 1e25] }),
        'a:3:{i:0;s:1:"a";i:-3;d:1.5;s:2:"07";a:2:{i:0;b:1;i:1;d:1.0E+25;}}');
});

test('tryUnserialize only takes containers that parse', async () => {
    await env.goto('php-serialize.html');
    const ok = s => php((P, s) => !!P.tryUnserialize(s), s);
    assert.equal(await ok('a:1:{i:0;i:1;}'), true);
    assert.equal(await ok('O:8:"stdClass":0:{}'), true);
    assert.equal(await ok('a:1:{i:0;i:1;'), false);
    assert.equal(await ok('i:1;'), false);
    assert.equal(await ok('hello'), false);
});

test('text after the value comes back as rest when asked for', async () => {
    await env.goto('php-serialize.html');
    const sig = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';
    const r = await php((P, s) => P.unserialize(s, { trailing: true }), 'a:1:{i:0;i:1;}' + sig);
    assert.equal(r.rest, sig);
    assert.equal(await php((P, s) => P.tryUnserialize(s).rest, 'a:1:{i:0;i:1;}' + sig), sig);
    assert.match(await php((P, s) => P.describeRest(s), sig), /SHA-1/);
    assert.match(await php((P, s) => P.describeRest(s), 'xyz'), /^3 more characters/);
    assert.equal(await php((P, s) => P.unserialize(s).rest, 'a:0:{} \n'), '');
});

test('page: typing PHP fills the tree and JSON; editing JSON writes PHP back', async () => {
    await env.goto('php-serialize.html');
    const p = env.page;
    await p.fill('#php-input', SAMPLES[0]);
    assert.equal(await p.textContent('#php-status-text'), 'Valid');
    const tree = await p.textContent('#php-tree');
    assert.ok(tree.includes('array(2)') && tree.includes('"Alice"'), tree);
    assert.deepEqual(JSON.parse(await p.inputValue('#php-json')), { name: 'Alice', age: 30 });

    await p.click('#php-view-toggle button[data-view="json"]');
    await p.fill('#php-json', '{"name":"Bob","tags":["x"]}');
    assert.equal(await p.inputValue('#php-input'), 'a:2:{s:4:"name";s:3:"Bob";s:4:"tags";a:1:{i:0;s:1:"x";}}');

    await p.fill('#php-input', 'a:1:{');
    assert.match(await p.textContent('#php-status-text'), /^Invalid — /);
});

test('page: a signed CodeIgniter cookie shows its data and the signature', async () => {
    await env.goto('php-serialize.html');
    await env.page.fill('#php-input', 'a:1:{s:10:"session_id";s:3:"abc";}d41d8cd98f00b204e9800998ecf8427e');
    assert.match(await env.page.textContent('#php-status-text'), /MD5 signature/);
    const tree = await env.page.textContent('#php-tree');
    assert.ok(tree.includes('"abc"') && tree.includes('followed by d41d8cd98f00b204e9800998ecf8427e'), tree);
});

test('page: sample shows visibility and a nested object', async () => {
    await env.goto('php-serialize.html');
    await env.page.click('#btn-php-sample');
    assert.equal(await env.page.textContent('#php-status-text'), 'Valid');
    const tree = await env.page.textContent('#php-tree');
    for (const s of ['User object(3)', 'protected email', 'private pass', '"홍길동" string(9)']) {
        assert.ok(tree.includes(s), s + ' in ' + tree);
    }
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
