import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// Well-known test key (ethers docs) and its address.
const TEST_PK = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const TEST_PK_ADDR = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

function summaryValue(page, key) {
    return page.evaluate((k) => {
        const row = [...document.querySelectorAll('#hd-summary .hd-kv')].find(r =>
            r.querySelector('.hd-kv-key')?.textContent === k);
        return row?.querySelector('.hd-kv-val span')?.textContent ?? null;
    }, key);
}

test('seed mode: BIP39 vector derives the expected master key', async () => {
    await env.goto('hd-wallet.html');
    await env.page.fill('#hd-mnemonic', TEST_MNEMONIC);
    await env.page.click('#btn-hd-generate');
    await env.page.waitForSelector('#hd-summary .card');

    assert.equal(await env.page.$$eval('#hd-steps .hd-step', s => s.length), 3);

    // Cross-check the displayed root address against ethers computed in-page.
    const shown = await summaryValue(env.page, 'ETH Address');
    const expected = await env.page.evaluate((m) => {
        const seed = ethers.pbkdf2(ethers.toUtf8Bytes(m), ethers.toUtf8Bytes('mnemonic'), 2048, 64, 'sha512');
        return ethers.HDNodeWallet.fromSeed(seed).address;
    }, TEST_MNEMONIC);
    assert.equal(shown, expected);

    assert.equal(await env.page.$$eval('#hd-table-wrap tbody tr', r => r.length), 30);
});

test('hex mode: parses messy input and shows the right address', async () => {
    await env.goto('hd-wallet.html');
    await env.page.click('#hd-mode button[data-mode="hex"]');
    await env.page.fill('#hd-hex', `  ${TEST_PK.slice(0, 32)}\n${TEST_PK.slice(32)}  `);
    await env.page.click('#btn-hd-hex-use');
    await env.page.waitForSelector('#hd-summary .card');

    assert.equal(await env.page.$eval('#hd-hex', e => e.value), '0x' + TEST_PK);
    assert.equal(await summaryValue(env.page, 'ETH Address'), TEST_PK_ADDR);
    // Derivation note must explain the seed-vs-key distinction.
    assert.match(await env.page.$eval('#hd-derive-note', e => e.textContent), /chain code/);
    assert.equal(await env.page.$$eval('#hd-table-wrap tbody tr', r => r.length), 30);
});

test('hex mode: rejects bad input with a clear error', async () => {
    await env.goto('hd-wallet.html');
    await env.page.click('#hd-mode button[data-mode="hex"]');

    await env.page.fill('#hd-hex', '0xzz');
    await env.page.click('#btn-hd-hex-use');
    assert.match(await env.page.$eval('#hd-error', e => e.textContent), /non-hex/);

    await env.page.fill('#hd-hex', '0xabcd');
    await env.page.click('#btn-hd-hex-use');
    assert.match(await env.page.$eval('#hd-error', e => e.textContent), /64 hex characters/);
});

test('random buttons produce working keys', async () => {
    await env.goto('hd-wallet.html');
    await env.page.click('#btn-hd-random');
    await env.page.waitForSelector('#hd-summary .card');
    assert.equal(await env.page.$$eval('#hd-table-wrap tbody tr', r => r.length), 30);

    await env.page.click('#hd-mode button[data-mode="hex"]');
    await env.page.click('#btn-hd-hex-random');
    await env.page.waitForSelector('#hd-summary .card');
    assert.match(await env.page.$eval('#hd-hex', e => e.value), /^0x[0-9a-f]{64}$/);
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
