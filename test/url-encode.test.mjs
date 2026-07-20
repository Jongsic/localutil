import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

async function convert(input, button) {
    await env.page.fill('#url-input', input);
    await env.page.click(button);
    return env.page.$eval('#url-output', e => e.value);
}

test('all three encode modes on one input', async () => {
    await env.goto('url-encode.html');
    assert.equal(await convert('hello world+x', '#btn-uri-encode'), 'hello%20world+x');
    assert.equal(await convert('hello world+x', '#btn-uric-encode'), 'hello%20world%2Bx');
    assert.equal(await convert('hello world+x', '#btn-urif-encode'), 'hello+world%2Bx');
});

test('decode modes; + becomes a space only in form mode', async () => {
    await env.goto('url-encode.html');
    assert.equal(await convert('hello+world%2Bx', '#btn-urif-decode'), 'hello world+x');
    assert.equal(await convert('hello+world%2Bx', '#btn-uric-decode'), 'hello+world+x');
    assert.equal(await convert('a%20b', '#btn-uri-decode'), 'a b');
});

test('swap moves the output back to the input', async () => {
    await env.goto('url-encode.html');
    await convert('a b', '#btn-uric-encode');
    await env.page.click('#btn-url-swap');
    assert.equal(await env.page.$eval('#url-input', e => e.value), 'a%20b');
    assert.equal(await env.page.$eval('#url-output', e => e.value), '');
});

async function breakdownRows(selector = '#breakdown-body .breakdown-table') {
    return env.page.$$eval(selector + ' tr', trs =>
        trs.map(tr => [...tr.children].map(td => td.textContent)));
}

test('breakdown parses a full URL into host/path/decoded params', async () => {
    await env.goto('url-encode.html');
    await env.page.fill('#url-input',
        'https://www.google.com/search?q=%EB%AC%B8%EC%84%9C&ie=UTF-8&plus=a+b');
    assert.ok(await env.page.$eval('#url-breakdown', e => e.style.display !== 'none'));
    const tables = await env.page.$$eval('#breakdown-body .breakdown-table', els => els.length);
    assert.equal(tables, 2);
    const parts = Object.fromEntries(await env.page.$$eval(
        '#breakdown-body .breakdown-table:first-of-type tr',
        trs => trs.map(tr => [...tr.children].map(td => td.textContent))));
    assert.equal(parts.scheme, 'https');
    assert.equal(parts.host, 'www.google.com');
    assert.equal(parts.path, '/search');
    const params = await env.page.$$eval(
        '#breakdown-body .breakdown-table:last-of-type tr',
        trs => trs.slice(1).map(tr => [...tr.children].map(td => td.textContent)));
    assert.deepEqual(params, [['q', '문서'], ['ie', 'UTF-8'], ['plus', 'a b']]);
});

test('breakdown parses cookie strings, keeping undecodable values raw', async () => {
    await env.goto('url-encode.html');
    await env.page.fill('#url-input', 'access_token=@#$#@$@dsfsadfasd$%R$; auth_session=1; enc=a%20b+c');
    assert.ok(await env.page.$eval('#url-breakdown', e => e.style.display !== 'none'));
    const rows = await env.page.$$eval('#breakdown-body .breakdown-table tr',
        trs => trs.slice(1).map(tr => [...tr.children].map(td => td.textContent)));
    assert.deepEqual(rows, [
        ['access_token', '@#$#@$@dsfsadfasd$%R$'],  // %R is not a valid escape → raw
        ['auth_session', '1'],
        ['enc', 'a b+c'],                            // %20 decoded, + kept (cookies are not form-encoded)
    ]);
});

test('breakdown parses a bare query string with + as space', async () => {
    await env.goto('url-encode.html');
    await env.page.fill('#url-input', 'q=hello+world&lang=ko');
    const rows = await env.page.$$eval('#breakdown-body .breakdown-table tr',
        trs => trs.slice(1).map(tr => [...tr.children].map(td => td.textContent)));
    assert.deepEqual(rows, [['q', 'hello world'], ['lang', 'ko']]);
});

test('breakdown stays hidden for plain text', async () => {
    await env.goto('url-encode.html');
    await env.page.fill('#url-input', 'just some plain text');
    assert.ok(await env.page.$eval('#url-breakdown', e => e.style.display === 'none'));
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
