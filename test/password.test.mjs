import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env;
before(async () => { env = await startEnv({ permissions: ['clipboard-read', 'clipboard-write'] }); });
after(async () => { await env.close(); });

const open = (query = '') =>
    env.page.goto(`${env.server.base}/password.html${query}`, { waitUntil: 'networkidle' });

// Everything the URL codec is supposed to round-trip, read off the live page.
function snap() {
    return env.page.evaluate(() => ({
        search: location.search,
        pw: document.getElementById('pw-display').textContent,
        placeholder: document.getElementById('pw-display').classList.contains('placeholder'),
        note: document.getElementById('pw-note').textContent,
        len: document.getElementById('pw-length').value,
        lenLabel: document.getElementById('pw-length-value').textContent,
        mode: [...document.querySelectorAll('#pw-mode button')]
            .find(b => b.classList.contains('active')).dataset.mode,
        customHidden: document.getElementById('pw-custom-section').style.display === 'none',
        types: [...document.querySelectorAll('#pw-types .pw-type')].map(r => ({
            on: r.querySelector('input[type=checkbox]').checked,
            rowOn: r.classList.contains('on'),
            readout: r.querySelector('.rng-readout').textContent,
        })),
        syms: document.querySelector('.pw-symbols-custom input').value,
        symsHint: document.querySelectorAll('#pw-types .pw-type')[3].querySelector('.field-hint').textContent,
    }));
}

test('defaults are written to the query string on load', async () => {
    await open();
    const s = await snap();
    const q = new URLSearchParams(s.search);
    assert.equal(q.get('mode'), 'custom');
    assert.equal(q.get('len'), '20');
    assert.equal(q.get('upper'), '1-20');
    assert.equal(q.get('lower'), '1-20');
    assert.equal(q.get('digits'), '1-20');
    assert.equal(q.get('symbols'), 'off');
    assert.equal(q.get('syms'), null, 'default symbol set stays implicit');
    assert.equal(s.pw.length, 20);
});

test('hex mode and its length come back from the URL', async () => {
    await open('?mode=hex&len=32');
    const s = await snap();
    assert.equal(s.mode, 'hex');
    assert.ok(s.customHidden, 'character-type section is hidden in hex mode');
    assert.equal(s.len, '32');
    assert.equal(s.lenLabel, '32');
    assert.match(s.pw, /^[0-9a-f]{32}$/);
    assert.match(s.note, /~128 bits/);
    assert.equal(s.search, '?mode=hex&len=32', 'hex links carry no character-type params');
});

test('?hex=N shorthand matches the preset chips', async () => {
    await open('?hex=48');
    const s = await snap();
    assert.equal(s.mode, 'hex');
    assert.match(s.pw, /^[0-9a-f]{48}$/);
    assert.equal(s.search, '?mode=hex&len=48', 'shorthand is normalized');
});

test('custom counts and a custom symbol set round-trip', async () => {
    const query = '?mode=custom&len=24&upper=2-4&lower=1-24&digits=off&symbols=3-3&syms=%40%23%25';
    await open(query);
    const s = await snap();
    assert.equal(s.len, '24');
    assert.deepEqual(s.types.map(t => t.on), [true, true, false, true]);
    // The disabled type keeps a full-length range, so turning it back on here
    // can still fill all 24 chars.
    assert.deepEqual(s.types.map(t => t.readout), ['2–4', '1–24', '1–24', '3–3']);
    assert.ok(!s.types[2].rowOn, 'a disabled type collapses its count row');
    assert.equal(s.syms, '@#%');
    assert.equal(s.symsHint, '@#%');
    assert.equal(s.search, query, 'the link is reproduced verbatim');

    // The generated password must actually obey the shared constraints.
    assert.equal(s.pw.length, 24);
    assert.equal((s.pw.match(/[@#%]/g) || []).length, 3);
    const uppers = (s.pw.match(/[A-Z]/g) || []).length;
    assert.ok(uppers >= 2 && uppers <= 4, `expected 2–4 uppercase, got ${uppers}`);
    assert.ok(!/[0-9]/.test(s.pw), 'digits were disabled');
});

test('a length-only link fills the whole length', async () => {
    await open('?mode=custom&len=64');
    const s = await snap();
    assert.equal(s.pw.length, 64, 'types not named in the link scale up to the new length');
    assert.equal(s.note, '', 'no "maximums cap the password" warning');
    assert.match(s.search, /upper=1-64/);
});

test('option edits update the URL live', async () => {
    await open('?mode=custom&len=24&digits=off');
    assert.ok(!(await snap()).types[2].on);

    await env.page.click('#pw-types .pw-type:nth-child(3) .switch span'); // re-enable digits
    let s = await snap();
    assert.ok(s.types[2].on && s.types[2].rowOn);
    assert.match(s.search, /digits=1-24/);

    await env.page.evaluate(() => {
        const el = document.getElementById('pw-length');
        el.value = '30';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    s = await snap();
    assert.equal(s.lenLabel, '30');
    assert.match(s.search, /len=30/);

    await env.page.click('#pw-mode button[data-mode="hex"]');
    assert.equal((await snap()).search, '?mode=hex&len=30');
});

test('Share copies the options URL and never the password', async () => {
    await open('?mode=custom&len=28');
    await env.page.click('#btn-share');
    const clip = await env.page.evaluate(() => navigator.clipboard.readText());
    const s = await snap();
    assert.equal(clip, await env.page.evaluate(() => location.href));
    assert.ok(!clip.includes(s.pw), 'the generated password stays out of the URL');
    assert.match(await env.page.textContent('#toast'), /copied/i);

    // Reopening the shared link restores the config but rolls a new password.
    await env.page.goto(clip, { waitUntil: 'networkidle' });
    const a = await snap();
    await env.page.goto(clip, { waitUntil: 'networkidle' });
    const b = await snap();
    assert.deepEqual(a.types, b.types);
    assert.equal(a.len, b.len);
    assert.notEqual(a.pw, b.pw);
});

test('malformed params degrade instead of breaking', async () => {
    await open('?mode=nope&len=9999&upper=abc&symbols=5&syms=');
    const s = await snap();
    assert.equal(s.mode, 'custom', 'unknown mode falls back to custom');
    assert.equal(s.len, '128', 'length is clamped to the slider maximum');
    assert.ok(!s.types[0].on, 'an unparseable count disables the type');
    assert.equal(s.types[3].readout, '5–5', 'a bare count means exactly that many');
    assert.match(s.symsHint, /empty/);
    assert.ok(!s.placeholder);
    assert.equal(s.pw.length, 128);
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
