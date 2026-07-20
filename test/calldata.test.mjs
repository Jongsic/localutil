import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

const ADDR_A = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const ADDR_B = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const TRANSFER_EVENT_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

async function freshPage(file = 'calldata.html') {
    await env.goto(file);
    await env.page.evaluate(() => localStorage.clear());
    await env.goto(file);
}

// Expand the nth visible member and fill its arg inputs.
async function openMember(n, args = []) {
    const heads = await env.page.$$('.cd-member .cd-member-head');
    await heads[n].click();
    const body = await env.page.waitForSelector(`.cd-member:nth-child(${n + 1}) .cd-member-body`);
    const inputs = await body.$$('input');
    for (let i = 0; i < args.length; i++) await inputs[i].fill(args[i]);
    return body;
}

test('plain signature lists a function and an event member', async () => {
    await freshPage();
    await env.page.fill('#cd-sig', 'transfer(address to, uint256 amount)');
    const kinds = await env.page.$$eval('.cd-member .cd-member-kind', els => els.map(e => e.textContent));
    assert.deepEqual(kinds, ['fn', 'event']);
    const hashes = await env.page.$$eval('.cd-member .cd-member-hash', els => els.map(e => e.textContent));
    assert.equal(hashes[0], '0xa9059cbb');

    // encode via the function member
    const body = await openMember(0, [ADDR_A, '1000000000000000000']);
    await (await body.$('button.btn-primary')).click();
    await env.page.waitForSelector('.cd-log-item');

    const calldata = await env.page.$eval('.cd-log-item:first-child .cd-log-hex', e => e.textContent);
    const expected = await env.page.evaluate(([a]) =>
        new ethers.Interface(['function transfer(address,uint256)'])
            .encodeFunctionData('transfer', [a, '1000000000000000000']), [ADDR_A]);
    assert.equal(calldata, expected);
});

test('event signature with indexed args: single event member, correct topics', async () => {
    await freshPage();
    await env.page.fill('#cd-sig', 'Transfer(address indexed from, address indexed to, uint256 value)');
    const kinds = await env.page.$$eval('.cd-member .cd-member-kind', els => els.map(e => e.textContent));
    assert.deepEqual(kinds, ['event']);

    const body = await openMember(0, [ADDR_A, ADDR_B, '1000']);
    assert.equal(await body.$$eval('.cd-arg-indexed', els => els.length), 2);
    // member meta shows the full topic0
    const meta = await body.$$eval('.cd-member-meta .v', els => els.map(e => e.textContent));
    assert.ok(meta.includes(TRANSFER_EVENT_TOPIC0));

    await (await body.$('button.btn-primary')).click();
    await env.page.waitForSelector('.cd-log-item');

    const log = JSON.parse(await env.page.$eval('.cd-log-item:first-child .cd-log-hex', e => e.textContent));
    assert.equal(log.topics.length, 3);
    assert.equal(log.topics[0], TRANSFER_EVENT_TOPIC0);
    assert.equal(log.topics[1], '0x000000000000000000000000' + ADDR_A.slice(2).toLowerCase());
    assert.equal(log.topics[2], '0x000000000000000000000000' + ADDR_B.slice(2).toLowerCase());
    assert.equal(BigInt(log.data), 1000n);
});

test('decode card: function calldata round-trips', async () => {
    await freshPage();
    await env.page.fill('#cd-sig', 'transfer(address to, uint256 amount)');
    const calldata = await env.page.evaluate(([a]) =>
        new ethers.Interface(['function transfer(address,uint256)'])
            .encodeFunctionData('transfer', [a, '12345']), [ADDR_A]);

    await env.page.fill('#cd-dec-data', calldata);
    await env.page.click('#btn-cd-decode');
    await env.page.waitForSelector('#cd-decoded-group', { state: 'visible' });

    const decoded = JSON.parse(await env.page.$eval('#cd-decoded', e => e.textContent));
    assert.equal(decoded.type, 'function');
    assert.equal(decoded.selector, '0xa9059cbb');
    assert.equal(decoded.args.to, ADDR_A);
    assert.equal(decoded.args.amount, '12345');
});

test('decode card: event topics + data round-trip with indexed args', async () => {
    await freshPage();
    await env.page.fill('#cd-sig', 'Transfer(address indexed from, address indexed to, uint256 value)');
    const log = await env.page.evaluate(([a, b]) => {
        const iface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
        return iface.encodeEventLog('Transfer', [a, b, 777n]);
    }, [ADDR_A, ADDR_B]);

    await env.page.fill('#cd-dec-data', log.data);
    await env.page.fill('#cd-dec-topics', log.topics.join('\n'));
    await env.page.click('#btn-cd-decode');
    await env.page.waitForSelector('#cd-decoded-group', { state: 'visible' });

    const decoded = JSON.parse(await env.page.$eval('#cd-decoded', e => e.textContent));
    assert.equal(decoded.type, 'event');
    assert.equal(decoded.topic0, TRANSFER_EVENT_TOPIC0);
    assert.equal(decoded.args.from, ADDR_A);
    assert.equal(decoded.args.to, ADDR_B);
    assert.equal(decoded.args.value, '777');
});

test('ABI mode: members list, filter, auto-match on decode', async () => {
    await freshPage();
    await env.page.click('#cd-def-mode button[data-mode="abi"]');
    await env.page.fill('#cd-abi', [
        'function transfer(address to, uint256 amount) returns (bool)',
        'function balanceOf(address owner) view returns (uint256)',
        'event Transfer(address indexed from, address indexed to, uint256 value)',
    ].join('\n'));
    await env.page.waitForSelector('.cd-member');

    const sigs = await env.page.$$eval('.cd-member .cd-member-sig', els => els.map(e => e.textContent));
    assert.deepEqual(sigs, ['transfer(address,uint256)', 'balanceOf(address)', 'Transfer(address,address,uint256)']);

    // filter narrows the list (and its text is findable, unlike a <select>)
    await env.page.fill('#cd-member-filter', 'balance');
    const visible = await env.page.$$eval('.cd-member', els =>
        els.filter(e => e.style.display !== 'none').length);
    assert.equal(visible, 1);
    await env.page.fill('#cd-member-filter', '');

    // decode balanceOf calldata — auto-matched from the ABI by selector
    const calldata = await env.page.evaluate(([a]) =>
        new ethers.Interface(['function balanceOf(address)']).encodeFunctionData('balanceOf', [a]), [ADDR_A]);
    await env.page.fill('#cd-dec-data', calldata);
    await env.page.click('#btn-cd-decode');
    await env.page.waitForSelector('#cd-decoded-group', { state: 'visible' });

    const decoded = JSON.parse(await env.page.$eval('#cd-decoded', e => e.textContent));
    assert.equal(decoded.name, 'balanceOf');
    assert.match(await env.page.$eval('#cd-decode-note', e => e.textContent), /Matched function/);
});

test('well-known ABI picker: fills the editor, includes permit/safe/uniswap', async () => {
    await freshPage();
    await env.page.click('#cd-def-mode button[data-mode="abi"]');

    const options = await env.page.$$eval('#cd-wellknown option', els => els.map(e => e.value));
    assert.deepEqual(options, ['', 'erc20', 'erc721', 'erc1155', 'weth9', 'safe', 'uniswap-v2-router', 'multisig']);

    await env.page.selectOption('#cd-wellknown', 'erc20');
    await env.page.waitForSelector('.cd-member');
    const sigs = await env.page.$$eval('.cd-member .cd-member-sig', els => els.map(e => e.textContent));
    assert.ok(sigs.includes('transfer(address,uint256)'));
    assert.ok(sigs.includes('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)'), 'erc20 should include ERC-2612 permit');
    assert.ok(sigs.includes('Transfer(address,address,uint256)'), 'erc20 should include the Transfer event');

    await env.page.selectOption('#cd-wellknown', 'safe');
    await env.page.waitForSelector('.cd-member');
    const safeSigs = await env.page.$$eval('.cd-member .cd-member-sig', els => els.map(e => e.textContent));
    assert.ok(safeSigs.some(s => s.startsWith('execTransaction(')));

    await env.page.selectOption('#cd-wellknown', 'uniswap-v2-router');
    await env.page.waitForSelector('.cd-member');
    const uniSigs = await env.page.$$eval('.cd-member .cd-member-sig', els => els.map(e => e.textContent));
    assert.ok(uniSigs.some(s => s.startsWith('swapExactTokensForTokens(')));

    // hand-editing the ABI resets the picker to Custom
    await env.page.fill('#cd-abi', '["function foo()"]');
    assert.equal(await env.page.$eval('#cd-wellknown', e => e.value), '');
});

test('ABI editor: format/minify and highlight overlay', async () => {
    await freshPage();
    await env.page.click('#cd-def-mode button[data-mode="abi"]');
    await env.page.fill('#cd-abi', '["function foo(uint256 a)","event Bar(address indexed x)"]');

    await env.page.click('#btn-cd-format');
    const pretty = await env.page.$eval('#cd-abi', e => e.value);
    assert.ok(pretty.includes('\n\t"function foo(uint256 a)"'), 'Format should tab-indent');
    assert.equal(await env.page.$$eval('.cd-member', els => els.length), 2, 'members survive reformat');

    await env.page.click('#btn-cd-minify');
    const mini = await env.page.$eval('#cd-abi', e => e.value);
    assert.equal(mini, '["function foo(uint256 a)","event Bar(address indexed x)"]');

    // the overlay mirrors the text with highlight spans
    const hl = await env.page.$eval('#cd-abi-hl', e => ({ text: e.textContent, spans: e.querySelectorAll('span').length }));
    assert.equal(hl.text.trimEnd(), mini);
    assert.ok(hl.spans >= 2, 'highlighted tokens expected');
});

test('embedded abis.js matches the abi/ source files (when present)', async (t) => {
    const { readFile, readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const ROOT = new URL('..', import.meta.url).pathname;
    let files;
    try {
        files = (await readdir(join(ROOT, 'abi'))).filter(f => f.endsWith('.json'));
    } catch (e) {
        t.skip('abi/ source folder not present (untracked)');
        return;
    }
    await env.goto('calldata.html');
    const embedded = await env.page.evaluate(() =>
        Object.fromEntries(window.WELLKNOWN_ABIS.map(e => [e.key, e.abi])));
    for (const f of files) {
        const key = f.replace(/\.json$/, '');
        const src = JSON.parse(await readFile(join(ROOT, 'abi', f), 'utf8'));
        assert.deepEqual(embedded[key], src, `abis.js is stale for ${f} — run node scripts/embed-abis.mjs`);
    }
});

test('errors: bad signature, empty arg, selector mismatch warning', async () => {
    await freshPage();
    await env.page.fill('#cd-sig', 'transfer(addres to)');
    assert.match(await env.page.$eval('#cd-sig-error', e => e.textContent), /Cannot parse/);
    assert.equal(await env.page.$$eval('.cd-member', els => els.length), 0);

    await env.page.fill('#cd-sig', 'transfer(address to, uint256 amount)');
    const body = await openMember(0);
    await (await body.$('button.btn-primary')).click();
    assert.match(await body.$eval('.cd-error', e => e.textContent), /is empty/);

    // decode with mismatching selector still decodes, but warns
    const calldata = await env.page.evaluate(([a]) =>
        new ethers.Interface(['function approve(address,uint256)']).encodeFunctionData('approve', [a, 5]), [ADDR_A]);
    await env.page.fill('#cd-dec-data', calldata);
    await env.page.click('#btn-cd-decode');
    assert.match(await env.page.$eval('#cd-decode-note', e => e.textContent), /does not match/);
});

test('arg values survive re-render; log persists across reloads', async () => {
    await freshPage();
    await env.page.fill('#cd-sig', 'transfer(address to, uint256 amount)');
    const body = await openMember(0, [ADDR_A, '42']);
    // retype the same signature → members rebuild, args should come back
    await env.page.fill('#cd-sig', 'transfer(address to, uint256 amount)');
    await env.page.waitForSelector('.cd-member.open .cd-member-body input');
    const vals = await env.page.$$eval('.cd-member.open .cd-member-body input', els => els.map(e => e.value));
    assert.deepEqual(vals, [ADDR_A, '42']);

    await (await env.page.$('.cd-member.open button.btn-primary')).click();
    await env.page.waitForSelector('.cd-log-item');
    await env.goto('calldata.html');
    assert.equal(await env.page.$$eval('.cd-log-item', e => e.length), 1);
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
