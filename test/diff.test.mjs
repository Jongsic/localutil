import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

const lines = n => Array.from({ length: n }, (_, i) => 'line ' + (i + 1));

// The page scrolls as a whole, so the ruler and the ↑/↓ nav are both driven by
// .tools-container — every helper below reads that scroller.
async function compare(oldText, newText) {
    await env.goto('diff.html');
    await env.page.fill('#diff-a', oldText);
    await env.page.fill('#diff-b', newText);
    await env.page.click('#btn-diff-run');
}

const scroller = fn => env.page.evaluate(fn);

test('a line number wider than one digit does not wrap the row', async () => {
    const text = lines(14).join('\n');
    await compare(text, text);
    const heights = await env.page.$$eval('.diff-table tr', trs =>
        trs.map(tr => Math.round(tr.getBoundingClientRect().height)));
    assert.equal(heights.length, 14);
    assert.equal(new Set(heights).size, 1, 'every row is one text line tall: ' + heights.join(','));
});

test('each row type gets its own tint, insertions included', async () => {
    const a = lines(6);
    const b = lines(6);
    b[1] = 'changed';          // chg
    b.splice(3, 0, 'added');   // ins
    b.splice(5, 1);            // del
    await compare(a.join('\n'), b.join('\n'));
    const seen = await env.page.$$eval('.diff-table tr', trs => trs.map(tr => tr.className));
    ['row-eq', 'row-chg', 'row-ins', 'row-del'].forEach(cls =>
        assert.ok(seen.includes(cls), 'missing ' + cls + ' in ' + seen.join(' ')));
    // The tint is what makes the type readable — an untinted row means the CSS
    // class and the row type drifted apart.
    const tinted = await env.page.$$eval('.row-ins .diff-side.new', tds =>
        tds.every(td => getComputedStyle(td).backgroundColor !== 'rgba(0, 0, 0, 0)'));
    assert.ok(tinted, 'inserted rows are highlighted');
});

test('long runs of unchanged lines fold, and expand on click', async () => {
    const a = lines(40);
    const b = lines(40);
    b[20] = 'changed';
    await compare(a.join('\n'), b.join('\n'));

    const folds = await env.page.$$eval('.diff-fold-btn', bs => bs.map(b => b.textContent.trim()));
    assert.equal(folds.length, 2, 'one fold above and one below the change');
    assert.match(folds[0], /^⋯ \d+ unchanged lines hidden$/);

    const shown = () => env.page.$$eval('.diff-table tr[data-type]', trs => trs.length);
    const before = await shown();
    const hidden = Number(folds[0].match(/\d+/)[0]);
    await env.page.click('.diff-fold-btn');
    assert.equal(await shown(), before + hidden, 'expanding reveals exactly the hidden lines');
    assert.equal((await env.page.$$('.diff-fold-btn')).length, 1);
});

test('short runs are left alone', async () => {
    const a = lines(8);
    const b = lines(8);
    b[4] = 'changed';
    await compare(a.join('\n'), b.join('\n'));
    assert.equal((await env.page.$$('.diff-fold-btn')).length, 0);
});

test('the collapse toggle folds and unfolds everything at once', async () => {
    const a = lines(120);
    const b = lines(120);
    [10, 60, 110].forEach(i => { b[i] = 'changed ' + i; });
    await compare(a.join('\n'), b.join('\n'));

    const shown = () => env.page.$$eval('.diff-table tr[data-type]', trs => trs.length);
    const folds = () => env.page.$$eval('.diff-fold-btn', bs => bs.length);
    assert.ok(await folds() > 0);
    assert.ok(await shown() < 120, 'folded by default');

    await env.page.uncheck('#diff-fold');
    assert.equal(await folds(), 0);
    assert.equal(await shown(), 120, 'every line is back');

    await env.page.check('#diff-fold');
    assert.ok(await folds() > 0, 'folds come back');
    assert.ok(await shown() < 120);

    // Re-collapsing also takes back a fold that was expanded by hand.
    await env.page.uncheck('#diff-fold');
    await env.page.check('#diff-fold');
    assert.equal(await shown() < 120, true);
});

test('toggling the fold keeps the change you are reading in place', async () => {
    const a = lines(200);
    const b = lines(200);
    [20, 100, 180].forEach(i => { b[i] = 'changed ' + i; });
    await compare(a.join('\n'), b.join('\n'));
    await env.page.$eval('#btn-diff-next', e => e.click());
    await env.page.waitForTimeout(700);                       // let the smooth scroll land
    await env.page.$eval('#btn-diff-next', e => e.click());   // second change
    await env.page.waitForTimeout(700);

    const where = () => env.page.evaluate(() => {
        const sc = document.querySelector('.tools-container');
        const tr = document.querySelector('tr.diff-focus');
        return { y: Math.round(tr.getBoundingClientRect().top - sc.getBoundingClientRect().top),
                 text: tr.querySelector('.diff-side.new').textContent };
    });
    const before = await where();
    // Dispatched for the same reason as the nav buttons: a real click would make
    // Playwright scroll the sticky toolbar into view first, resetting the scroll
    // this test is about.
    await env.page.$eval('#diff-fold', el => { el.checked = false; el.dispatchEvent(new Event('change')); });
    const after = await where();
    assert.equal(after.text, before.text, 'still the same change');
    assert.ok(Math.abs(after.y - before.y) <= 2,
        `stayed at y=${before.y}, now y=${after.y}`);
    assert.equal(await env.page.$eval('#diff-nav-count', e => e.textContent), '2 / 3');
});

test('the ruler maps the scroll range and marks every change', async () => {
    const a = lines(80);
    const b = lines(80);
    b[5] = 'changed';
    b.splice(30, 0, 'added');
    b.splice(60, 1);
    await compare(a.join('\n'), b.join('\n'));

    const marks = await env.page.$$eval('.diff-mark', ms => ms.map(m => ({
        type: m.className.replace('diff-mark ', ''),
        top: parseFloat(m.style.top),
        height: parseFloat(m.style.height),
    })));
    assert.deepEqual(marks.map(m => m.type), ['chg', 'ins', 'del'], 'in document order');
    assert.ok(marks.every(m => m.height >= 3), 'a one-line change stays visible');

    // A mark sits where the scrollbar thumb has to be for that change to show.
    const { view, total, rulerH } = await scroller(() => {
        const sc = document.querySelector('.tools-container');
        return {
            view: sc.clientHeight, total: sc.scrollHeight,
            rulerH: document.getElementById('diff-ruler').getBoundingClientRect().height,
        };
    });
    assert.equal(Math.round(rulerH), view, 'the ruler spans the scroll viewport');
    const rowTop = await env.page.$eval('.row-chg', tr => {
        const sc = document.querySelector('.tools-container');
        return tr.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    });
    assert.ok(Math.abs(marks[0].top - rowTop / total * view) < 1.5,
        `mark at ${marks[0].top} should track row at ${rowTop} of ${total}`);
});

test('clicking the ruler scrolls to that fraction of the document', async () => {
    const a = lines(300);
    const b = a.map((l, i) => (i % 7 === 0 ? 'changed ' + i : l));   // nothing folds away
    await compare(a.join('\n'), b.join('\n'));
    const box = await env.page.$eval('#diff-ruler', el => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.top + r.height * 0.75 };
    });
    await env.page.mouse.click(box.x, box.y);
    const at = await scroller(() => {
        const sc = document.querySelector('.tools-container');
        return { top: sc.scrollTop, want: 0.75 * sc.scrollHeight - sc.clientHeight / 2 };
    });
    assert.ok(Math.abs(at.top - at.want) < 2, `scrolled to ${at.top}, wanted ${at.want}`);
});

test('the ruler and nav stay out of the way when there is nothing to show', async () => {
    const text = lines(80).join('\n');
    await compare(text, text);   // identical: scrollable, but no changes
    assert.ok(await env.page.$eval('#diff-ruler', e => e.hidden));
    assert.ok(await env.page.$eval('#diff-nav', e => e.hidden));
    assert.equal((await env.page.$$('.diff-fold-btn')).length, 0, 'nothing to fold against');
    assert.equal((await env.page.$$('.diff-table tr')).length, 80, 'the whole file still shows');

    await env.page.click('#btn-diff-clear');
    assert.ok(await env.page.$eval('#diff-nav', e => e.hidden));
});

test('the ruler needs a scrollbar to mirror', async () => {
    const page = await env.browser.newPage();
    await page.setViewportSize({ width: 1280, height: 1600 });   // nothing to scroll
    await page.goto(`${env.server.base}/diff.html`, { waitUntil: 'networkidle' });
    const b = lines(3);
    b[1] = 'changed';
    await page.fill('#diff-a', lines(3).join('\n'));
    await page.fill('#diff-b', b.join('\n'));
    await page.click('#btn-diff-run');
    assert.ok(await page.evaluate(() => {
        const sc = document.querySelector('.tools-container');
        return sc.scrollHeight <= sc.clientHeight;
    }), 'the page really does fit');
    assert.ok(await page.$eval('#diff-ruler', e => e.hidden), 'no ruler without a scrollbar');
    assert.ok(!await page.$eval('#diff-nav', e => e.hidden), 'nav still works');
    await page.close();
});

test('↑ / ↓ and n / p walk the changes and wrap around', async () => {
    const a = lines(120);
    const b = lines(120);
    [10, 60, 110].forEach(i => { b[i] = 'changed ' + i; });
    await compare(a.join('\n'), b.join('\n'));

    const count = () => env.page.$eval('#diff-nav-count', e => e.textContent);
    const focused = () => env.page.$$eval('tr.diff-focus .diff-side.new', ts => ts.map(t => t.textContent));
    const settle = () => env.page.waitForTimeout(700);   // scroll-behavior: smooth
    // Dispatched, not clicked: the toolbar is sticky, and Playwright's
    // scroll-into-view uses its unstuck layout box, which would scroll the page
    // back to the top before every click.
    const press = id => env.page.$eval(id, e => e.click());
    // What a jump has to deliver: the target hunk actually on screen.
    const targetVisible = () => env.page.evaluate(() => {
        const sc = document.querySelector('.tools-container');
        const tr = document.querySelector('tr.diff-focus');
        const r = tr.getBoundingClientRect(), box = sc.getBoundingClientRect();
        return r.top >= box.top && r.bottom <= box.bottom;
    });

    assert.equal(await count(), '1 / 3');
    await press('#btn-diff-next');
    await settle();
    assert.deepEqual(await focused(), ['changed 10']);
    assert.equal(await count(), '1 / 3');
    assert.ok(await targetVisible(), 'the change it jumped to is on screen');

    await press('#btn-diff-next');
    await settle();
    assert.deepEqual(await focused(), ['changed 60']);
    assert.equal(await count(), '2 / 3');
    assert.ok(await targetVisible());

    await env.page.keyboard.press('n');
    await settle();
    assert.deepEqual(await focused(), ['changed 110']);
    assert.equal(await count(), '3 / 3');

    await env.page.keyboard.press('n');   // wraps to the top
    await settle();
    assert.deepEqual(await focused(), ['changed 10']);

    await env.page.keyboard.press('p');   // and back around to the bottom
    await settle();
    assert.deepEqual(await focused(), ['changed 110']);
    assert.ok(await targetVisible());
});

test('n / p stay typable inside the textareas', async () => {
    const text = lines(40).join('\n');
    await compare(text, text.replace('line 20', 'changed'));
    await env.page.click('#diff-a');
    await env.page.keyboard.type('np');
    assert.ok((await env.page.inputValue('#diff-a')).includes('np'));
});

test('a diffed line that matches a dictionary key is not translated', async () => {
    const page = await env.browser.newPage();
    await page.addInitScript(() => localStorage.setItem('localutil-lang', 'ko'));
    await page.goto(`${env.server.base}/diff.html`, { waitUntil: 'networkidle' });
    const a = lines(40);
    const b = lines(40);
    b[3] = 'Compare';       // also the label of this page's own button
    await page.fill('#diff-a', a.join('\n'));
    await page.fill('#diff-b', b.join('\n'));
    await page.click('#btn-diff-run');
    const dict = await page.evaluate(() => window.LOCALUTIL_I18N.ko);
    assert.ok(dict['Compare'], 'the dictionary does translate this string elsewhere');
    const cells = await page.$$eval('.diff-side.new', ts => ts.map(t => t.textContent));
    assert.ok(cells.includes('Compare'), 'user text survives verbatim: ' + cells.join('|'));
    // ...while the tool's own dynamic label does get translated.
    assert.ok(await page.$eval('.diff-fold-btn',
        (e, want) => e.textContent.includes(want), dict['unchanged lines hidden']));
    await page.close();
});

// ----------------------------------------------------------------------------
// Loading a side by drag & drop
// ----------------------------------------------------------------------------
// Bytes, not strings: half of what these tests drop is deliberately not UTF-8.
const file = (name, bytes) => ({
    name,
    bytes: Array.from(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes)),
});

// The DataTransfer has to be built inside the page — a File cannot cross the
// bridge — and the drop is dispatched for real so the page's own handler runs.
async function drop(paneId, files) {
    await env.page.evaluate(({ paneId, files }) => {
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(new File([new Uint8Array(f.bytes)], f.name)));
        const pane = document.getElementById(paneId);
        pane.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
        pane.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
        pane.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    }, { paneId, files });
}

const note = side => env.page.$eval('#diff-file-' + side, e => (e.hidden ? '' : e.textContent));
const toast = () => env.page.$eval('#toast', e => (e.classList.contains('show') ? e.textContent : ''));
const settled = (side, want) =>
    env.page.waitForFunction(([side, want]) =>
        document.getElementById('diff-' + side).value === want, [side, want]);

test('dropping a file on a side loads it, and compares once both are in', async () => {
    await env.goto('diff.html');
    await drop('diff-pane-a', [file('before.txt', 'one\ntwo\nthree')]);
    await settled('a', 'one\ntwo\nthree');
    assert.match(await note('a'), /^before\.txt · 13 B · UTF-8$/);

    await drop('diff-pane-b', [file('after.txt', 'one\nTWO\nthree')]);
    await settled('b', 'one\nTWO\nthree');
    assert.match(await note('b'), /^after\.txt · 13 B · UTF-8$/);
    assert.match(await toast(), /Loaded after\.txt/);

    // Loading a file runs the comparison — no second trip to the button.
    const seen = await env.page.$$eval('.diff-table tr', trs => trs.map(tr => tr.className));
    assert.deepEqual(seen, ['row-eq', 'row-chg', 'row-eq']);
});

test('two files dropped at once fill both sides in order', async () => {
    await env.goto('diff.html');
    await drop('diff-pane-a', [file('v1.txt', 'x\ny'), file('v2.txt', 'x\nz')]);
    await settled('b', 'x\nz');
    assert.equal(await env.page.inputValue('#diff-a'), 'x\ny');
    assert.match(await toast(), /Loaded v1\.txt and v2\.txt/);
    assert.equal((await env.page.$$('.row-chg')).length, 1);

    // Dropped on the other side, the first file lands there instead.
    await drop('diff-pane-b', [file('v3.txt', 'x\nq'), file('v4.txt', 'x\nr')]);
    await settled('b', 'x\nq');
    assert.equal(await env.page.inputValue('#diff-a'), 'x\nr');
});

test('a third file is ignored, and said to be ignored', async () => {
    await env.goto('diff.html');
    await drop('diff-pane-a', [file('1.txt', 'a'), file('2.txt', 'b'), file('3.txt', 'c')]);
    await settled('b', 'b');
    assert.match(await toast(), /Loaded 1\.txt and 2\.txt — the rest were ignored/);
});

test('editing a loaded side drops the file note', async () => {
    await env.goto('diff.html');
    await drop('diff-pane-a', [file('x.txt', 'hello')]);
    await settled('a', 'hello');
    assert.ok(await note('a'));
    await env.page.click('#btn-diff-inputs');   // the drop collapsed them
    await env.page.click('#diff-a');
    await env.page.keyboard.type('!');
    assert.equal(await note('a'), '', 'the text is no longer what the file said');
});

test('swap and clear keep the file notes with their text', async () => {
    await env.goto('diff.html');
    await drop('diff-pane-a', [file('left.txt', 'l'), file('right.txt', 'r')]);
    await settled('b', 'r');
    await env.page.click('#btn-diff-swap');
    assert.equal(await env.page.inputValue('#diff-a'), 'r');
    assert.match(await note('a'), /^right\.txt/);
    assert.match(await note('b'), /^left\.txt/);
    await env.page.click('#btn-diff-clear');
    assert.equal(await note('a'), '');
    assert.equal(await note('b'), '');
});

test('a real binary is refused instead of pasted as mojibake', async () => {
    await env.goto('diff.html');
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < 400; i++) png.push(i % 5 === 0 ? 0 : 0x41 + (i % 26));
    await drop('diff-pane-a', [file('logo.png', png)]);
    await env.page.waitForFunction(() =>
        document.getElementById('toast').classList.contains('show'));
    assert.match(await toast(), /logo\.png — binary data, not text/);
    assert.equal(await env.page.inputValue('#diff-a'), '', 'the side is left alone');
    assert.equal(await note('a'), '');
});

test('a file that is mostly text loads, with its control bytes made visible', async () => {
    await env.goto('diff.html');
    const bytes = Buffer.concat([
        Buffer.from('id,name,note\n1,ok,fine\n2,od'),
        Buffer.from([0x00]),
        Buffer.from('d,'),
        Buffer.from([0x07]),
        Buffer.from('bell\n'),
        Buffer.from('3,rest,'.repeat(40) + '\n'),
    ]);
    await drop('diff-pane-a', [file('export.csv', bytes)]);
    await env.page.waitForFunction(() => document.getElementById('diff-a').value !== '');
    const text = await env.page.inputValue('#diff-a');
    assert.ok(text.includes('2,od␀d,␇bell'), 'shown, not silently dropped: ' + text.slice(0, 60));
    assert.match(await note('a'), /· 2 control bytes shown as ␀$/);
});

test('UTF-16 and CRLF are read the way the file meant them', async () => {
    await env.goto('diff.html');
    // The same three lines, saved as UTF-16LE with a BOM and CRLF endings…
    await drop('diff-pane-a', [file('utf16.txt', Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('alpha\r\nbeta\r\ngamma', 'utf16le'),
    ]))]);
    await settled('a', 'alpha\nbeta\ngamma');
    assert.match(await note('a'), /· UTF-16LE BOM · CRLF → LF$/);

    // …and as plain UTF-8 with LF. Same content, so no changes.
    await drop('diff-pane-b', [file('utf8.txt', 'alpha\nbeta\ngamma')]);
    await settled('b', 'alpha\nbeta\ngamma');
    await env.page.waitForSelector('.diff-summary .same');
    assert.match(await env.page.$eval('.diff-summary', e => e.textContent), /identical/);
});

test('a BOM-less UTF-16 file is not mistaken for binary', async () => {
    await env.goto('diff.html');
    await drop('diff-pane-a', [file('ps.txt', Buffer.from('one\ntwo\nthree\nfour', 'utf16le'))]);
    await settled('a', 'one\ntwo\nthree\nfour');
    assert.match(await note('a'), /· UTF-16LE$/);
});

test('bytes that are not UTF-8 still show, flagged as a guess', async () => {
    await env.goto('diff.html');
    // 0xE9 alone is invalid UTF-8 — latin-1 for "é".
    await drop('diff-pane-a', [file('latin.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))]);
    await settled('a', 'café\n');
    assert.match(await note('a'), /· Windows-1252 · encoding guessed$/);
});

test('a file dropped beside the panes is swallowed, not opened', async () => {
    await env.goto('diff.html');
    await drop('diff-pane-a', [file('keep.txt', 'do not lose me')]);
    await settled('a', 'do not lose me');
    const stopped = await env.page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array([65])], 'stray.txt'));
        const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
        document.querySelector('.diff-toolbar').dispatchEvent(ev);
        return ev.defaultPrevented;
    });
    assert.ok(stopped, 'the browser would have navigated to the file');
    assert.equal(await env.page.inputValue('#diff-a'), 'do not lose me');
});

test('an oversized file is refused before it is read', async () => {
    await env.goto('diff.html');
    // A sparse File of the right size — the bytes never have to exist.
    await env.page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(17 * 1024 * 1024).fill(0x41)], 'huge.log'));
        const pane = document.getElementById('diff-pane-a');
        pane.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
        pane.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    });
    await env.page.waitForFunction(() =>
        document.getElementById('toast').classList.contains('show'));
    assert.match(await toast(), /huge\.log — too large, 16\.0 MB is the limit/);
    assert.equal(await env.page.inputValue('#diff-a'), '');
});

// ----------------------------------------------------------------------------
// Size of the comparison itself
// ----------------------------------------------------------------------------
// page.fill drives the whole input pipeline, which stalls for a minute on texts
// this big — these two tests are about the diff, not about typing.
async function compareBig(oldText, newText) {
    await env.goto('diff.html');
    await env.page.evaluate(([o, n]) => {
        document.getElementById('diff-a').value = o;
        document.getElementById('diff-b').value = n;
    }, [oldText, newText]);
    const started = Date.now();
    await env.page.click('#btn-diff-run');
    return Date.now() - started;
}

test('two mostly identical big files compare fast', async () => {
    // 20k lines each: the full LCS table for these would be 1.6 GB, so this only
    // finishes because the matching head and tail are peeled off first.
    const a = lines(20000);
    const b = lines(20000);
    b[9000] = 'changed';
    const ms = await compareBig(a.join('\n'), b.join('\n'));
    assert.equal((await env.page.$$('.row-chg')).length, 1);
    assert.equal(await env.page.$eval('#diff-nav-count', e => e.textContent), '1 / 1');
    assert.ok(ms < 5000, 'compared in ' + ms + 'ms — the common head and tail are not being trimmed');
});

test('5000 lines against 5000 entirely different ones still compares', async () => {
    const a = Array.from({ length: 5000 }, (_, i) => 'left ' + i);
    const b = Array.from({ length: 5000 }, (_, i) => 'right ' + i);
    const ms = await compareBig(a.join('\n'), b.join('\n'));
    assert.match(await env.page.$eval('.diff-summary', e => e.textContent),
        /\+5000 added.*5000 removed/);
    assert.ok(ms < 5000, 'compared in ' + ms + 'ms');
});

test('a diff with more rows than the table will draw says what it left out', async () => {
    const a = lines(60000);
    const b = a.map((l, i) => (i % 2 ? l : 'changed ' + i));   // nothing folds away
    await compareBig(a.join('\n'), b.join('\n'));
    const drawn = await env.page.$$eval('.diff-table tr[data-type]', trs => trs.length);
    assert.equal(drawn, 50000, 'stops at RENDER_MAX');
    assert.match(await env.page.$eval('.diff-cut', e => e.textContent), /10,000 more rows not shown/);
    // The summary still counts the whole diff, not just the drawn part.
    assert.match(await env.page.$eval('.diff-summary', e => e.textContent), /\+30000 added/);
});

// ----------------------------------------------------------------------------
// Inside a changed pair
// ----------------------------------------------------------------------------
const marks = side => env.page.$$eval('.row-chg .diff-side.' + side + ' .diff-tok',
    ts => ts.map(t => t.textContent));

test('a changed line marks only the tokens that differ', async () => {
    await compare('const total = price * qty;', 'const total = price * quantity;');
    assert.deepEqual(await marks('old'), ['qty']);
    assert.deepEqual(await marks('new'), ['quantity']);
    // The unchanged part of the line is text, not a mark.
    assert.equal(await env.page.$eval('.row-chg .diff-side.new', e => e.textContent),
        'const total = price * quantity;');
});

test('marks cover every run that moved, not just the first', async () => {
    await compare('a=1, b=2, c=3', 'a=9, b=2, c=7');
    assert.deepEqual(await marks('old'), ['1', '3']);
    assert.deepEqual(await marks('new'), ['9', '7']);
});

test('a line with nothing in common is left to the row tint', async () => {
    await compare('alpha beta gamma', 'once upon time');
    assert.deepEqual(await marks('old'), [], 'marking every token says nothing');
    assert.equal((await env.page.$$('.row-chg')).length, 1);
});

test('a diffed line is still safe to render', async () => {
    await compare('<b>tag</b> and & amp', '<i>tag</i> and & amp');
    assert.equal(await env.page.$eval('.row-chg .diff-side.old', e => e.textContent),
        '<b>tag</b> and & amp');
    assert.deepEqual(await marks('new'), ['i', 'i']);
});

// ----------------------------------------------------------------------------
// Collapsing the inputs
// ----------------------------------------------------------------------------
const shownInputs = () => env.page.$eval('#diff-split', e => !e.hidden);
const sourceNote = side => env.page.$eval('#diff-source-' + side,
    e => (document.getElementById('diff-sources').hidden ? '' : e.textContent));

test('dropping a file collapses the panes and says what is being compared', async () => {
    await env.goto('diff.html');
    assert.ok(await shownInputs(), 'panes are there for typing into');
    await drop('diff-pane-a', [file('one.txt', 'x\ny\nz'), file('two.txt', 'x\nY\nz')]);
    await settled('b', 'x\nY\nz');
    assert.equal(await shownInputs(), false, 'a 10 MB textarea is pure layout cost');
    assert.match(await sourceNote('a'), /^one\.txt · 5 B · UTF-8 · 3 lines$/);
    assert.match(await sourceNote('b'), /^two\.txt · 5 B · UTF-8 · 3 lines$/);
    assert.equal((await env.page.$$('.row-chg')).length, 1, 'the diff is what is left on screen');

    // And they come back on demand.
    await env.page.click('#btn-diff-inputs');
    assert.ok(await shownInputs());
    assert.equal(await env.page.$eval('#btn-diff-inputs', e => e.textContent), 'Hide inputs');
    assert.equal(await sourceNote('a'), '');
});

test('the toggle also collapses text that was typed in', async () => {
    await compare('one\ntwo', 'one\n2');
    assert.ok(await shownInputs());
    await env.page.click('#btn-diff-inputs');
    assert.equal(await shownInputs(), false);
    assert.match(await sourceNote('a'), /^pasted text · 2 lines$/);
    assert.equal(await env.page.$eval('#btn-diff-inputs', e => e.textContent), 'Show inputs');
});

test('Clear brings the panes back to type into', async () => {
    await env.goto('diff.html');
    await drop('diff-pane-a', [file('gone.txt', 'a\nb')]);
    await settled('a', 'a\nb');
    assert.equal(await shownInputs(), false);
    await env.page.click('#btn-diff-clear');
    assert.ok(await shownInputs());
    assert.ok(await env.page.$eval('#diff-sources', e => e.hidden));
});

test('the ruler and nav still measure the diff with the panes collapsed', async () => {
    await env.goto('diff.html');
    const a = lines(300);
    const b = a.map((l, i) => (i % 7 === 0 ? 'changed ' + i : l));
    await drop('diff-pane-a', [file('a.txt', a.join('\n')), file('b.txt', b.join('\n'))]);
    await settled('b', b.join('\n'));
    assert.equal(await shownInputs(), false);
    assert.ok(!await env.page.$eval('#diff-nav', e => e.hidden));
    assert.ok(!await env.page.$eval('#diff-ruler', e => e.hidden));
    // A mark has to land where the scrollbar thumb needs to be, which it cannot
    // do if the rows were measured against the layout the panes used to have.
    const { markTop, rowTop, view, total } = await env.page.evaluate(() => {
        const sc = document.querySelector('.tools-container');
        const tr = document.querySelector('.row-chg');
        return {
            markTop: parseFloat(document.querySelector('.diff-mark').style.top),
            rowTop: tr.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop,
            view: sc.clientHeight, total: sc.scrollHeight,
        };
    });
    assert.ok(Math.abs(markTop - rowTop / total * view) < 1.5,
        `mark at ${markTop} should track the row at ${rowTop} of ${total}`);
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
