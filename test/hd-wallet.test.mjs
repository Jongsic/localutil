import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// Well-known test key (ethers docs) and its address.
const TEST_PK = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const TEST_PK_ADDR = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
// Chain-specific values for TEST_PK. XRP cross-checked against
// ripple-keypairs deriveAddress + ripple-address-codec decodeAccountID;
// TON (Ed25519 seed) against @ton/crypto keyPairFromSeed + @ton/ton
// WalletContractV4 / WalletContractV3R2.
const TEST_PK_CHAINS = {
    'XRP Address': 'rEBsWSAtNxGLQ7m4FhwQEaatwAwQFa5gWs',
    // Full decode: version byte 00 ++ accountID ++ 4-byte checksum
    // (= ripple-address-codec@2 decode(address)).
    'XRP Address (hex)': '0x009b78039087bd663f20ace711f15be0eaf7d070052872c368',
    'TON Public key (Ed25519)': '80c8c02fd8526709aff4b62492d9725940ee512c9ad36d49f2df8e6e0526875d',
    'TON Address (v4r2, bounceable)': 'EQDIQREPI-rtBaW2ls_CYABBk7ySORv5KQnF3K9QqaAsM5Q7',
    'TON Address (v4r2, non-bounceable)': 'UQDIQREPI-rtBaW2ls_CYABBk7ySORv5KQnF3K9QqaAsM8n-',
    'TON Address (v3r2, bounceable)': 'EQAdNCH3f6vyHACeaPtsTRb_UZ8VhY65ia_24UlpCpj79zWS',
    'TON Address (v3r2, non-bounceable)': 'UQAdNCH3f6vyHACeaPtsTRb_UZ8VhY65ia_24UlpCpj792hX',
};

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

test('hex mode: derives live from messy input, no button needed', async () => {
    await env.goto('hd-wallet.html');
    await env.page.click('#hd-mode button[data-mode="hex"]');
    // Whitespace + no 0x prefix; results must appear from the input event alone.
    await env.page.fill('#hd-hex', `  ${TEST_PK.slice(0, 32)}\n${TEST_PK.slice(32)}  `);
    await env.page.waitForSelector('#hd-summary .card');

    assert.equal(await summaryValue(env.page, 'ETH Address'), TEST_PK_ADDR);
    for (const [key, expected] of Object.entries(TEST_PK_CHAINS)) {
        assert.equal(await summaryValue(env.page, key), expected, key);
    }
    // Derivation note must explain the seed-vs-key distinction.
    assert.match(await env.page.$eval('#hd-derive-note', e => e.textContent), /chain code/);
    assert.equal(await env.page.$$eval('#hd-table-wrap tbody tr', r => r.length), 30);

    // On blur the field shows the parsed, 0x-prefixed form.
    await env.page.$eval('#hd-hex', e => e.blur());
    await env.page.dispatchEvent('#hd-hex', 'change');
    assert.equal(await env.page.$eval('#hd-hex', e => e.value), '0x' + TEST_PK);
});

test('hex mode: rejects bad input with a clear error', async () => {
    await env.goto('hd-wallet.html');
    await env.page.click('#hd-mode button[data-mode="hex"]');

    // Non-hex characters error immediately while typing.
    await env.page.fill('#hd-hex', '0xzz');
    assert.match(await env.page.$eval('#hd-error', e => e.textContent), /non-hex/);

    // Short-but-plausible hex stays quiet while typing, errors on blur.
    await env.page.fill('#hd-hex', '0xabcd');
    assert.equal(await env.page.$eval('#hd-error', e => e.style.display), 'none');
    await env.page.dispatchEvent('#hd-hex', 'change');
    assert.match(await env.page.$eval('#hd-error', e => e.textContent), /64 hex characters/);
});

test('mode tabs refresh the output from the active tab', async () => {
    await env.goto('hd-wallet.html');
    await env.page.fill('#hd-mnemonic', TEST_MNEMONIC);
    await env.page.click('#btn-hd-generate');
    await env.page.waitForSelector('#hd-summary .card');
    const seedAddr = await summaryValue(env.page, 'ETH Address');

    // Switching to the (empty) hex tab clears the stale seed output.
    await env.page.click('#hd-mode button[data-mode="hex"]');
    assert.equal(await env.page.$eval('#hd-summary', e => e.style.display), 'none');

    await env.page.fill('#hd-hex', TEST_PK);
    await env.page.waitForSelector('#hd-summary .card');
    assert.equal(await summaryValue(env.page, 'ETH Address'), TEST_PK_ADDR);

    // Switching back re-derives from the seed phrase without pressing the button.
    await env.page.click('#hd-mode button[data-mode="seed"]');
    await env.page.waitForSelector('#hd-summary .card');
    assert.equal(await summaryValue(env.page, 'ETH Address'), seedAddr);
    assert.notEqual(seedAddr, TEST_PK_ADDR);
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
