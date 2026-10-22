import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env;
before(async () => {
    env = await startEnv({ permissions: ['clipboard-read', 'clipboard-write'] });
    await env.goto('csv-view.html');
});
after(async () => {
    assert.deepEqual(env.errors, []);
    await env.close();
});

async function open(name, content) {
    if (await env.page.isVisible('#cv-close')) await env.page.click('#cv-close');
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    await env.page.setInputFiles('#cv-file', { name, mimeType: 'text/plain', buffer });
    await env.page.waitForFunction(n => document.querySelector('#cv-name').textContent === n, name);
}
const head = () => env.page.$$eval('#cv-grid thead th', ths => ths.slice(1).map(th => th.firstChild.textContent));
const rows = () => env.page.$$eval('#cv-grid tbody tr', trs =>
    trs.map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.classList.contains('missing') ? null : td.textContent)));
const meta = () => env.page.textContent('#cv-meta');
const click = sel => env.page.click(sel);

test('values stay exactly as written — quotes, delimiters and newlines inside fields too', async () => {
    await open('people.csv', 'id,zip,joined,note\n007,01234,2026-03-01,"Hello, ""world""\nsecond line"\n8,  9 ,1e5,\n');
    assert.deepEqual(await head(), ['id', 'zip', 'joined', 'note']);
    assert.deepEqual(await rows(), [
        ['1', '007', '01234', '2026-03-01', 'Hello, "world"\nsecond line'],
        ['2', '8', '  9 ', '1e5', ''],
    ]);
    assert.equal(await meta(), 'Delimiter: comma (detected) · UTF-8 (detected) · 2 rows × 4 columns');
    assert.equal(await env.page.textContent('#cv-warn'), '');
});

test('the delimiter is detected, or set by hand', async () => {
    await open('eu.csv', 'a;b;c\n1,5;2,5;3\n4;5;6\n');
    assert.match(await meta(), /^Delimiter: semicolon \(detected\)/);
    assert.deepEqual((await rows())[0], ['1', '1,5', '2,5', '3']);

    await open('data.tsv', 'x\ty\n1\t"a,b"\n');
    assert.match(await meta(), /^Delimiter: tab \(detected\)/);
    assert.deepEqual((await rows())[0], ['1', '1', 'a,b']);

    await open('caret.txt', 'k^v\n1^2\n');
    await click('#cv-delim [data-delim="custom"]');
    await env.page.fill('#cv-custom', '^');
    assert.deepEqual(await head(), ['k', 'v']);
    assert.match(await meta(), /^Delimiter: "\^"/);
    await click('#cv-delim [data-delim="auto"]');

    // quotes can be switched off, so a quote character is just text
    await open('q.csv', 'a,b\n"x,y",z\n');
    await click('#cv-quote [data-quote=""]');
    assert.deepEqual(await rows(), [['1', '"x', 'y"', 'z']]);
    assert.match(await env.page.textContent('#cv-warn'), /1 row has a different number of fields than the usual 2 \(row 1\)/);
    await click('#cv-quote [data-quote="\\""]');
});

test('legacy Korean encodings are detected, and can be chosen', async () => {
    // "이름,값\n홍길동,0012\n" in CP949
    await open('kr.csv', Buffer.from('c0ccb8a72cb0aa0ac8abb1e6b5bf2c303031320a', 'hex'));
    assert.deepEqual(await head(), ['이름', '값']);
    assert.deepEqual(await rows(), [['1', '홍길동', '0012']]);
    assert.match(await meta(), /EUC-KR \(detected\)/);

    await env.page.selectOption('#cv-encoding', 'windows-1252');
    assert.notDeepEqual(await head(), ['이름', '값']);
    assert.match(await meta(), /Windows-1252 · /);
    await env.page.selectOption('#cv-encoding', 'auto');

    // a UTF-8 BOM is not part of the first header
    await open('bom.csv', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('name,v\nx,1\n')]));
    assert.deepEqual(await head(), ['name', 'v']);
});

test('the first row can be data; short rows are marked, not padded', async () => {
    await open('ragged.csv', 'a,b,c\n1,2\n3,4,5,6\n');
    assert.deepEqual(await head(), ['a', 'b', 'c', 'D']);
    assert.deepEqual(await rows(), [['1', '1', '2', null, null], ['2', '3', '4', '5', '6']]);
    assert.match(await env.page.textContent('#cv-warn'), /2 rows have a different number of fields than the usual 3 \(row 1, 2\)/);

    await click('#cv-header [data-header="0"]');
    assert.deepEqual(await head(), ['A', 'B', 'C', 'D']);
    assert.equal((await rows()).length, 3);
    assert.match(await meta(), /3 rows × 4 columns/);
    await click('#cv-header [data-header="1"]');
});

test('rows filter, sort as text in natural order, and page', async () => {
    const body = ['name,code'];
    for (let i = 1; i <= 250; i++) body.push(`item ${i},${i % 2 ? 'odd' : 'even'}`);
    await open('items.csv', body.join('\n'));
    assert.equal(await env.page.textContent('#cv-pager-info'), '1–100 of 250');
    await click('#cv-next');
    await click('#cv-next');
    assert.equal(await env.page.textContent('#cv-pager-info'), '201–250 of 250');

    await env.page.fill('#cv-filter', 'item 2');
    await env.page.waitForFunction(() => /filtered/.test(document.querySelector('#cv-pager-info').textContent));
    assert.equal(await env.page.textContent('#cv-pager-info'), '1–62 of 62 (filtered from 250)');

    // descending: "item 250" sorts above "item 29" — numbers inside text compare as numbers
    await click('#cv-grid th[data-col="0"]');
    await click('#cv-grid th[data-col="0"]');
    const r = await rows();
    assert.deepEqual(r.slice(0, 3).map(x => x[1]), ['item 250', 'item 249', 'item 248']);
    assert.equal(r[0][0], '250', 'row numbers stay those of the file');
    assert.match((await head())[0], /▼$/);
    await env.page.fill('#cv-filter', '');
});

test('DIF files are read', async () => {
    const dif = [
        'TABLE', '0,1', '"EXCEL"', 'VECTORS', '0,3', '""', 'TUPLES', '0,2', '""', 'DATA', '0,0', '""',
        '-1,0', 'BOT', '1,0', '"code"', '1,0', '"qty"', '1,0', '"ok"',
        '-1,0', 'BOT', '1,0', '"00123"', '0,1.50', 'V', '0,1', 'TRUE',
        '-1,0', 'BOT', '1,0', '"say ""hi"""', '0,0', 'NA', '0,0', 'FALSE',
        '-1,0', 'EOD', '',
    ].join('\r\n');
    await open('sheet.dif', dif);
    assert.deepEqual(await head(), ['code', 'qty', 'ok']);
    assert.deepEqual(await rows(), [['1', '00123', '1.50', 'TRUE'], ['2', 'say "hi"', '', 'FALSE']]);
    assert.match(await meta(), /^DIF · UTF-8 \(detected\) · 2 rows × 3 columns$/);
    assert.equal(await env.page.isVisible('#cv-delim-opt'), false);
});

test('pasted text opens as a table', async () => {
    await click('#cv-close');
    await env.page.evaluate(() => {
        const dt = new DataTransfer();
        dt.setData('text/plain', 'col1\tcol2\r\n0001\t=SUM(A1)\r\n');
        document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await env.page.waitForFunction(() => document.querySelector('#cv-name').textContent === 'Pasted text');
    assert.deepEqual(await rows(), [['1', '0001', '=SUM(A1)']]);
    assert.equal(await env.page.isVisible('#cv-encoding-opt'), false);
});

test('double-clicking a cell shows and copies its whole value', async () => {
    const long = 'x'.repeat(2000) + '\nend';
    await open('long.csv', `k,v\na,"${long}"\n`);
    assert.ok((await rows())[0][2].length < 600);
    await env.page.dblclick('#cv-grid tbody td[data-col="1"]');
    assert.equal(await env.page.$eval('#cv-cell', d => d.open), true);
    assert.equal(await env.page.textContent('#cv-cell-title'), 'v (B) · row 1');
    assert.equal(await env.page.textContent('#cv-cell-meta'), '2,004 chars · 2 lines');
    assert.equal(await env.page.textContent('#cv-cell-text'), long);
    await click('#cv-cell-copy');
    assert.equal(await env.page.evaluate(() => navigator.clipboard.readText()), long);
    await env.page.keyboard.press('Escape');
    assert.equal(await env.page.$eval('#cv-cell', d => d.open), false);
});

test('an unclosed quote is reported', async () => {
    await open('broken.csv', 'a,b\n1,"oops\n2,3\n');
    assert.match(await env.page.textContent('#cv-warn'), /a quote is never closed/);
    assert.deepEqual(await rows(), [['1', '1', 'oops\n2,3\n']]);
});
