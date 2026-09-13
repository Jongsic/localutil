// js-minify.html (merged JS Beautify / Minify) — resizable editors, colorized
// output, JSON handling. json.html — JSON error locations with caret snippet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

test('js-minify.html: editors are vertically resizable', async () => {
    await env.goto('js-minify.html');
    for (const sel of ['#jsm-input', '#jsm-output']) {
        const resize = await env.page.$eval(sel, el => getComputedStyle(el).resize);
        assert.equal(resize, 'vertical', `${sel} should be resizable`);
    }
});

test('js-minify.html: colorize toggle swaps textarea and highlighted view', async () => {
    await env.goto('js-minify.html');
    await env.page.fill('#jsm-input', 'const x = "hi"; // note\nif (x) { fn(42); }');
    assert.ok(await env.page.isChecked('#jsm-colorize'), 'colorize is on by default');

    await env.page.click('#btn-jsm-beautify');
    const view = '#jsm-output ~ pre.code-view';
    assert.ok(await env.page.isVisible(view), 'code-view shown');
    assert.ok(await env.page.isHidden('#jsm-output'), 'textarea hidden');
    for (const cls of ['token.keyword', 'token.string', 'token.number', 'token.comment']) {
        assert.ok(await env.page.$(`${view} .${cls}`), `has ${cls} token`);
    }

    // Raw value stays in the textarea so the copy button keeps working
    const raw = await env.page.$eval('#jsm-output', el => el.value);
    assert.match(raw, /const x = "hi"/);
    const viewText = await env.page.$eval(view, el => el.textContent);
    assert.equal(viewText, raw, 'view mirrors the raw output');

    // Turning the toggle off falls back to the plain textarea
    await env.page.uncheck('#jsm-colorize');
    assert.ok(await env.page.isVisible('#jsm-output'), 'textarea back');
    assert.ok(await env.page.isHidden(view), 'code-view hidden');
});

test('js-minify.html: Minify compacts bare JSON directly (not a valid JS program)', async () => {
    await env.goto('js-minify.html');
    await env.page.fill('#jsm-input', '{\n  "a": 1,\n  "b": [1, 2]\n}');
    await env.page.click('#btn-jsm-minify');
    assert.equal(await env.page.$eval('#jsm-output', el => el.value), '{"a":1,"b":[1,2]}');
});

test('js-minify.html: JSON validator reports locations against formatted text', async () => {
    await env.goto('js-minify.html');
    const status = '#jsm-json-status';

    await env.page.fill('#jsm-input', '{"a": [1, 2], "b": null}');
    await env.page.click('#btn-jsm-validate');
    assert.match(await env.page.$eval(status, el => el.className), /\bok\b/);
    assert.match(await env.page.$eval(status, el => el.textContent), /Valid JSON/);
    assert.match(await env.page.$eval('#jsm-output', el => el.value), /^\{\n\s+"a": \[1, 2\]/,
        'valid input leaves the formatted JSON in the output');

    // Minified input: error location must be reported against the FORMATTED
    // text, where line numbers actually mean something.
    await env.page.fill('#jsm-input', '{"a":1,"b":,"c":3}');
    assert.ok(await env.page.isHidden(status), 'verdict clears when input changes');
    await env.page.click('#btn-jsm-validate');
    assert.match(await env.page.$eval(status, el => el.className), /\berr\b/);
    assert.match(await env.page.$eval(status, el => el.textContent), /line 3, column 8/);
    const snippet = await env.page.$eval('#jsm-output', el => el.value);
    assert.match(snippet, /Invalid JSON/);
    assert.match(snippet, />>> 3 \|   "b": ,/, 'snippet marks the offending formatted line');

    // A few classic mistakes JSON.parse messages are vague about
    // (locations are in the formatted text)
    const cases = [
        ['{"a": 1,}', /line 3, column 1/],          // trailing comma
        ["{'a': 1}", /line 2, column 3/],           // single quotes
        ['{"a": "unterminated', /line 2, column 21/],
        ['{"a": 1} extra', /line 4, column 1/],     // garbage after value
    ];
    for (const [bad, loc] of cases) {
        await env.page.fill('#jsm-input', bad);
        await env.page.click('#btn-jsm-validate');
        assert.match(await env.page.$eval(status, el => el.textContent), loc, JSON.stringify(bad));
    }
});

test('json.html: live status and snippet appear while typing, no click needed', async () => {
    await env.goto('json.html');
    await env.page.fill('#json-input', '{\n  "a": 1,\n  "b": ,\n}');
    assert.match(await env.page.$eval('#json-status-text', el => el.textContent),
        /line 3, column 8/);
    // The caret snippet shows up on its own (debounced)
    await env.page.waitForFunction(() =>
        document.getElementById('json-output').value.includes('>>>'));

    // Fixing the input replaces the snippet with the formatted result
    await env.page.fill('#json-input', '{"a": 1}');
    assert.match(await env.page.$eval('#json-status-text', el => el.textContent), /Valid JSON/);
    assert.equal(await env.page.$eval('#json-output', el => el.value), '{\n  "a": 1\n}');
});

test('json.html: editors are resizable and fill tall windows', async () => {
    await env.page.setViewportSize({ width: 1400, height: 1000 });
    await env.goto('json.html');
    for (const sel of ['#json-input', '#json-output']) {
        const { resize, height } = await env.page.$eval(sel, el => ({
            resize: getComputedStyle(el).resize,
            height: el.getBoundingClientRect().height,
        }));
        assert.equal(resize, 'vertical', `${sel} should be resizable`);
        assert.equal(height, 1000 - 310, `${sel} should track the window height`);
    }
    await env.page.setViewportSize({ width: 1280, height: 720 });
});

test('all textareas are vertically resizable (global default)', async () => {
    await env.goto('base64.html');
    const resizes = await env.page.$$eval('textarea',
        els => els.map(el => getComputedStyle(el).resize));
    assert.ok(resizes.length > 0, 'page has textareas');
    assert.ok(resizes.every(r => r === 'vertical'), `got: ${resizes}`);
});

test('json.html: Format on broken input shows a caret snippet in the output', async () => {
    await env.goto('json.html');
    await env.page.fill('#json-input', '{"a":1,"b":,"c":3}');
    await env.page.click('#btn-json-format');
    const snippet = await env.page.$eval('#json-output', el => el.value);
    assert.match(snippet, /Invalid JSON/);
    assert.match(snippet, />>> 3 \|   "b": ,/, 'error located in the pretty-printed text');
    assert.match(snippet, /\^/, 'caret marks the column');
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
