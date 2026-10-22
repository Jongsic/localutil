import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startEnv } from './helpers.mjs';

let env;
before(async () => {
    env = await startEnv({ acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
    await env.goto('sqlite.html');
});
after(async () => {
    assert.deepEqual(env.errors, []);
    await env.close();
});

// Builds a database with the page's own sql.js and returns its bytes.
async function makeDb(sql, { wal = false } = {}) {
    const bytes = await env.page.evaluate(async sql => {
        const S = await initSqlJs({ locateFile: f => 'vendor/sqljs/' + f });
        const db = new S.Database();
        db.exec(sql);
        const out = db.export();
        db.close();
        return Array.from(out);
    }, sql);
    // Header bytes 18/19 = 2 mark a WAL-mode file.
    if (wal) bytes[18] = bytes[19] = 2;
    return Buffer.from(bytes);
}

async function open(buffer, name = 'shop.sqlite') {
    await env.page.setInputFiles('#sq-file', { name, mimeType: 'application/octet-stream', buffer });
}
const openMany = files => env.page.setInputFiles('#sq-file',
    files.map(([name, buffer]) => ({ name, mimeType: 'application/octet-stream', buffer })));
const opened = name => env.page.waitForFunction(n => document.querySelector('#sq-dbname').textContent === n, name);

// A real WAL-mode database whose recent commits are still only in its -wal file:
// the files are read while the connection is open, before anything is checkpointed.
async function walFiles(setup, pending) {
    const dir = await mkdtemp(join(tmpdir(), 'sq-wal-'));
    const path = join(dir, 'app.db');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    db.exec(setup);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.exec(pending);
    const files = { db: await readFile(path), wal: await readFile(path + '-wal'), shm: await readFile(path + '-shm') };
    db.close();
    await rm(dir, { recursive: true });
    return files;
}

const objects = () => env.page.$$eval('.sq-obj', els => els.map(e => ({
    kind: e.dataset.kind, name: e.querySelector('.sq-obj-name').textContent, count: e.querySelector('.sq-obj-count').textContent,
})));
const gridRows = sel => env.page.$$eval(sel + ' .sq-grid tbody tr', trs =>
    trs.map(tr => Array.from(tr.querySelectorAll('td')).slice(1).map(td => td.textContent)));
const gridHead = sel => env.page.$$eval(sel + ' .sq-grid thead th', ths => ths.slice(1).map(th => th.firstChild.textContent));

async function runSql(sql) {
    await env.page.fill('#sq-sql', sql);
    await env.page.click('#sq-run');
}

const SHOP = `
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT, avatar BLOB);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE, total REAL);
    CREATE INDEX orders_customer ON orders(customer_id);
    CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100;
    INSERT INTO customers VALUES (1, 'Ada', NULL, x'0102ff'), (2, 'Grace', 'admiral', NULL), (3, 'Linus', NULL, NULL);
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250)
    INSERT INTO orders SELECT i, (i % 3) + 1, i * 1.5 FROM n;
`;

test('opening a file lists its objects and shows the first table', async () => {
    await open(await makeDb(SHOP));
    await env.page.waitForSelector('.sq-obj.active');

    assert.deepEqual(await objects(), [
        { kind: 'table', name: 'customers', count: '3' },
        { kind: 'table', name: 'orders', count: '250' },
        { kind: 'view', name: 'big_orders', count: '' },
        { kind: 'index', name: 'orders_customer', count: 'orders' },
    ]);
    assert.equal(await env.page.textContent('#sq-dbname'), 'shop.sqlite');
    assert.match(await env.page.textContent('#sq-dbmeta'), / · 2 tables$/);

    assert.deepEqual(await gridHead('#sq-view'), ['id', 'name', 'note', 'avatar']);
    const rows = await gridRows('#sq-view');
    assert.deepEqual(rows[1].slice(0, 3), ['2', 'Grace', 'admiral']);
    assert.equal(rows[0][2], 'NULL');
    assert.equal(rows[0][3], 'BLOB · 3 B 01 02 ff');
});

test('table data pages and sorts', async () => {
    await env.page.click('.sq-obj[data-name="orders"]');
    assert.equal(await env.page.textContent('#sq-pager-info'), '1–100 of 250');
    assert.equal(await env.page.isDisabled('#sq-prev'), true);

    await env.page.click('#sq-next');
    await env.page.click('#sq-next');
    assert.equal(await env.page.textContent('#sq-pager-info'), '201–250 of 250');
    assert.equal(await env.page.isDisabled('#sq-next'), true);
    assert.equal((await gridRows('#sq-view')).length, 50);

    // header click: ascending → descending → unsorted, back to page 1
    await env.page.click('#sq-view .sq-grid th:nth-child(4)');
    await env.page.click('#sq-view .sq-grid th:nth-child(4)');
    assert.equal(await env.page.textContent('#sq-pager-info'), '1–100 of 250');
    assert.match(await env.page.textContent('#sq-view .sq-grid th:nth-child(4)'), /^total ▼/);
    assert.equal((await gridRows('#sq-view'))[0][2], '375');
});

test('schema tab shows the DDL with its indexes, columns and foreign keys', async () => {
    await env.page.click('.segmented button[data-tab="schema"]');
    const ddl = await env.page.textContent('#sq-ddl');
    assert.match(ddl, /^CREATE TABLE orders \(id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers\(id\) ON DELETE CASCADE, total REAL\);/);
    assert.match(ddl, /CREATE INDEX orders_customer ON orders\(customer_id\);$/);
    const tables = await env.page.$$eval('#sq-view .sq-grid tbody', bs => bs.map(b =>
        Array.from(b.rows, r => Array.from(r.cells).slice(1).map(c => c.textContent))));
    assert.deepEqual(tables[0][0], ['id', 'INTEGER', '', 'NULL', '1']);
    assert.deepEqual(tables[1], [['customer_id', 'customers(id)', 'NO ACTION', 'CASCADE']]);

    await env.page.click('.sq-obj[data-name="orders_customer"]');
    assert.equal(await env.page.textContent('#sq-ddl'), 'CREATE INDEX orders_customer ON orders(customer_id);');
});

test('SQL runs each statement and reports rows or changes', async () => {
    await runSql(`SELECT name, count(o.id) AS n FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id ORDER BY c.id;
        UPDATE customers SET note = 'x' WHERE id > 1;
        CREATE TABLE tags (t TEXT)`);
    const results = await env.page.$$eval('.sq-result', els => els.map(e => e.querySelector('.sq-ok').textContent));
    assert.deepEqual(results, ['3 rows', 'OK · 2 rows changed', 'OK']);
    assert.deepEqual(await gridHead('.sq-result:first-child'), ['name', 'n']);
    assert.deepEqual(await gridRows('.sq-result:first-child'), [['Ada', '83'], ['Grace', '84'], ['Linus', '83']]);

    // a write marks the file modified and the new table shows up in the list
    assert.equal(await env.page.isVisible('#sq-dirty'), true);
    assert.ok((await objects()).some(o => o.name === 'tags' && o.count === '0'));
});

test('only the selection runs when text is selected', async () => {
    await env.page.fill('#sq-sql', 'SELECT 1 AS a; SELECT 2 AS b;');
    await env.page.$eval('#sq-sql', ta => ta.setSelectionRange(15, 29));
    await env.page.keyboard.press('Control+Enter');
    assert.deepEqual(await gridHead('.sq-result'), ['b']);
    assert.equal(await env.page.$$eval('.sq-result', els => els.length), 1);
});

test('large results are capped and errors name the failing statement', async () => {
    await runSql('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500) SELECT i FROM n');
    assert.equal(await env.page.textContent('.sq-result .sq-ok'), '1,500 rows');
    assert.equal((await gridRows('.sq-result')).length, 1000);

    await runSql('SELECT 1; SELECT * FROM nope');
    assert.equal(await env.page.textContent('#sq-error'), 'Error in statement 2: no such table: nope');

    await runSql('SELEC 1');
    assert.equal(await env.page.textContent('#sq-error'), 'Error in statement 1: near "SELEC": syntax error');
});

test('download returns the changed database', async () => {
    const [dl] = await Promise.all([env.page.waitForEvent('download'), env.page.click('#sq-download')]);
    assert.equal(dl.suggestedFilename(), 'shop.sqlite');
    const bytes = await readFile(await dl.path());
    assert.equal(bytes.subarray(0, 15).toString(), 'SQLite format 3');
    assert.equal(await env.page.isVisible('#sq-dirty'), false);

    // reopen what was downloaded: the update and the new table are in it
    await open(bytes, 'again.sqlite');
    await env.page.waitForFunction(() => document.querySelector('#sq-dbname').textContent === 'again.sqlite');
    await runSql("SELECT count(*) FROM customers WHERE note = 'x'; SELECT name FROM sqlite_schema WHERE name = 'tags'");
    assert.deepEqual(await env.page.$$eval('.sq-result .sq-ok', e => e.map(x => x.textContent)), ['1 row', '1 row']);
    assert.equal((await gridRows('.sq-result:first-child'))[0][0], '2');
});

test('WAL-mode files open', async () => {
    await open(await makeDb('CREATE TABLE w (v); INSERT INTO w VALUES (42);', { wal: true }), 'wal.db');
    await opened('wal.db');
    assert.deepEqual(await gridRows('#sq-view'), [['42']]);
    assert.match(await env.page.textContent('#sq-notice'), /^WAL mode: changes still in wal\.db-wal are not shown/);
});

test('a database dropped with its -wal file includes the committed changes', async () => {
    const f = await walFiles(
        "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes (body) VALUES ('checkpointed');",
        "INSERT INTO notes (body) VALUES ('only in wal'); CREATE TABLE later (x); INSERT INTO later VALUES (randomblob(9000));");

    // without the log: only what was checkpointed
    await openMany([['app.db', f.db]]);
    await opened('app.db');
    assert.deepEqual(await gridRows('#sq-view'), [['1', 'checkpointed']]);
    assert.deepEqual((await objects()).map(o => o.name), ['notes']);

    // with it (and the -shm, which is ignored): both commits are in, the database grew
    await env.page.click('#sq-close');
    await openMany([['app.db-wal', f.wal], ['app.db', f.db], ['app.db-shm', f.shm]]);
    await opened('app.db');
    await env.page.click('.sq-obj[data-name="notes"]');
    assert.deepEqual(await gridRows('#sq-view'), [['1', 'checkpointed'], ['2', 'only in wal']]);
    assert.deepEqual((await objects()).map(o => o.name + ':' + o.count), ['later:1', 'notes:2']);
    assert.match(await env.page.textContent('#sq-notice'), /^Merged 3 committed transactions from app\.db-wal\. /);

    // the download is one file that SQLite reads in WAL mode with everything in it
    const [dl] = await Promise.all([env.page.waitForEvent('download'), env.page.click('#sq-download')]);
    const out = await readFile(await dl.path());
    assert.equal(out[18], 2);
    const dir = await mkdtemp(join(tmpdir(), 'sq-out-'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'out.db'), out);
    const db = new DatabaseSync(join(dir, 'out.db'));
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('SELECT body FROM notes ORDER BY id').all().map(r => r.body), ['checkpointed', 'only in wal']);
    db.close();
    await rm(dir, { recursive: true });
});

test('a -wal file on its own is refused', async () => {
    const f = await walFiles('CREATE TABLE a (x);', 'INSERT INTO a VALUES (1);');
    await openMany([['lonely.db-wal', f.wal]]);
    assert.match(await env.page.textContent('#sq-load-error'), /^lonely\.db-wal is a write-ahead log, not a database/);
});

test('a non-SQLite file is refused and the open database stays', async () => {
    await open(Buffer.from('hello, not a database'), 'notes.txt');
    assert.match(await env.page.textContent('#sq-load-error'), /^notes\.txt is not a SQLite database/);
    assert.equal(await env.page.textContent('#sq-dbname'), 'app.db');
});

test('a new empty database can be built with SQL', async () => {
    await env.page.click('#sq-close');
    assert.equal(await env.page.isVisible('#sq-drop'), true);
    assert.equal(await env.page.isVisible('#sq-dbbar'), false);
    await env.page.click('#sq-new');
    await env.page.waitForFunction(() => document.querySelector('#sq-dbname').textContent === 'untitled.sqlite');
    assert.equal(await env.page.textContent('#sq-view .sq-placeholder'), 'No tables yet — create one with SQL above.');
    await runSql("CREATE TABLE t (a, b); INSERT INTO t VALUES (1, 'one')");
    await env.page.click('.sq-obj[data-name="t"]');
    assert.deepEqual(await gridRows('#sq-view'), [['1', 'one']]);
});

test('example buttons fill in the selected table and run as they are', async () => {
    await open(await makeDb(SHOP), 'ex.sqlite');
    await opened('ex.sqlite');
    await env.page.click('.sq-obj[data-name="orders"]');
    const ex = async kind => {
        await env.page.fill('#sq-sql', '');
        await env.page.click(`#sq-examples [data-ex="${kind}"]`);
        return env.page.inputValue('#sq-sql');
    };

    assert.equal(await ex('insert'), 'INSERT INTO orders (customer_id, total)\nVALUES (0, 0.0);');
    assert.equal(await ex('join'), 'SELECT a.*, b.*\nFROM orders AS a\nJOIN customers AS b ON b.id = a.customer_id\nLIMIT 100;');
    assert.equal(await ex('delete'), 'DELETE FROM orders\nWHERE id = 1;');

    // each one executes against the selected table
    for (const kind of ['select', 'insert', 'update', 'join', 'group', 'alter', 'index', 'create', 'drop', 'delete']) {
        await ex(kind);
        await env.page.click('#sq-run');
        assert.equal(await env.page.$('#sq-error'), null, kind + ' ran without an error');
    }

    // an example is added after what is already there, and selected so Run executes just it
    await env.page.fill('#sq-sql', 'SELECT 1;');
    await env.page.$eval('#sq-sql', ta => ta.setSelectionRange(9, 9));
    await env.page.click('#sq-examples [data-ex="drop"]');
    assert.equal(await env.page.inputValue('#sq-sql'), 'SELECT 1;\n\nDROP TABLE IF EXISTS new_table;');
    assert.equal(await env.page.$eval('#sq-sql', ta => ta.value.slice(ta.selectionStart, ta.selectionEnd)), 'DROP TABLE IF EXISTS new_table;');
});

test('double-clicking a cell opens its whole value', async () => {
    const long = 'line one\n' + 'x'.repeat(3000);
    await open(await makeDb(`CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT, meta TEXT, pic BLOB, raw BLOB, n REAL);
        INSERT INTO docs VALUES (1, '${long}', '{"a":[1,2],"b":"c"}', x'89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf500f00038601805a347d6b0000000049454e44ae426082', randomblob(70000), 2.5);`), 'cells.sqlite');
    await opened('cells.sqlite');
    const td = col => `#sq-view .sq-grid tbody tr:first-child td:nth-child(${col + 1})`;
    const dlg = () => env.page.evaluate(() => ({
        open: document.querySelector('#sq-cell').open,
        title: document.querySelector('#sq-cell-title').textContent,
        meta: document.querySelector('#sq-cell-meta').textContent,
        text: document.querySelector('#sq-cell-text')?.textContent,
    }));

    // long text: the grid shows it cut short, the dialog in full; Copy copies exactly the value
    assert.ok((await env.page.textContent(td(2))).length < 600);
    await env.page.dblclick(td(2));
    let d = await dlg();
    assert.deepEqual([d.open, d.title, d.meta, d.text], [true, 'body', 'TEXT · 3,009 chars · 2 lines', long]);
    await env.page.click('#sq-cell-copy');
    assert.equal(await env.page.evaluate(() => navigator.clipboard.readText()), long);
    await env.page.keyboard.press('Escape');
    assert.equal((await dlg()).open, false);

    // JSON text can be shown formatted, and Copy follows what is shown
    await env.page.dblclick(td(3));
    assert.equal(await env.page.isVisible('#sq-cell-json'), true);
    await env.page.click('#sq-cell-json [data-json="pretty"]');
    assert.equal((await dlg()).text, '{\n  "a": [\n    1,\n    2\n  ],\n  "b": "c"\n}');
    await env.page.click('#sq-cell-copy');
    assert.equal(await env.page.evaluate(() => navigator.clipboard.readText()), '{\n  "a": [\n    1,\n    2\n  ],\n  "b": "c"\n}');
    await env.page.click('#sq-cell-close');

    // a PNG blob: preview, hex dump, hex / Base64 copies and a download named after the column
    await env.page.dblclick(td(4));
    d = await dlg();
    assert.equal(d.meta, 'BLOB · 70 B · PNG image');
    await env.page.waitForSelector('#sq-cell-body img', { state: 'visible', timeout: 3000 });
    assert.equal(d.text.split('\n')[0], '00000000  89 50 4e 47 0d 0a 1a 0a 00 00 00 0d 49 48 44 52  .PNG........IHDR');
    await env.page.click('#sq-cell-copy-hex');
    assert.equal(await env.page.evaluate(() => navigator.clipboard.readText()), '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf500f00038601805a347d6b0000000049454e44ae426082');
    await env.page.click('#sq-cell-copy-b64');
    assert.equal(await env.page.evaluate(() => navigator.clipboard.readText()), 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
    const [dl] = await Promise.all([env.page.waitForEvent('download'), env.page.click('#sq-cell-download')]);
    assert.equal(dl.suggestedFilename(), 'pic-1.png');
    assert.equal((await readFile(await dl.path())).length, 70);
    // a click on the backdrop closes it
    await env.page.mouse.click(5, 5);
    assert.equal((await dlg()).open, false);

    // a large blob: the dump stops at 64 KB, the copies do not
    await env.page.dblclick(td(5));
    d = await dlg();
    assert.equal(d.meta, 'BLOB · 68.4 KB');
    assert.equal(d.text.split('\n').length, 4096);
    assert.match(await env.page.textContent('#sq-cell-body .sq-note'), /first 64 KB/);
    await env.page.click('#sq-cell-copy-hex');
    assert.equal((await env.page.evaluate(() => navigator.clipboard.readText())).length, 140000);
    await env.page.keyboard.press('Escape');

    // query results open the same way
    await runSql('SELECT n, NULL AS empty FROM docs');
    await env.page.dblclick('.sq-result .sq-grid tbody td:nth-child(2)');
    assert.deepEqual(await dlg().then(x => [x.meta, x.text]), ['REAL', '2.5']);
    await env.page.keyboard.press('Escape');
    await env.page.dblclick('.sq-result .sq-grid tbody td:nth-child(3)');
    assert.equal((await dlg()).meta, 'NULL');
    assert.equal(await env.page.$('#sq-cell-copy'), null);
    await env.page.keyboard.press('Escape');
});
