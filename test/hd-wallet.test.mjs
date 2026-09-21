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
    // Cross-checked against @solana/web3.js Keypair.fromSeed().
    'SOL Address': '9fijMemJYwXS5QD85Qxsq7iKqvSebgb6LvpGftgkeigk',
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

// BIP173's example key (hash160 = 751e76e8…): the spec's own P2WPKH address,
// plus the equally well-known P2SH-P2WPKH / P2PKH forms of the same key.
const BIP173_PUB = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const BIP173_ADDRS = {
    'BTC Address (P2PKH, legacy)': '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',
    'BTC Address (P2SH-P2WPKH)': '3JvL6Ymt8MVWiCNHC7oWU6nLeHNJKLZGLN',
    'BTC Address (P2WPKH, bech32)': 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
};
// First BIP86 test vector: x-only internal key → P2TR address.
const BIP86_XONLY = 'cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115';
const BIP86_P2TR = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

test('public key mode: compressed key detected, BIP-verified BTC addresses', async () => {
    await env.goto('hd-wallet.html');
    await env.page.click('#hd-mode button[data-mode="pub"]');
    await env.page.fill('#hd-pub', BIP173_PUB);
    await env.page.waitForSelector('#hd-summary .card');

    assert.match(await summaryValue(env.page, 'Detected type'), /compressed \(short form\)/);
    for (const [key, expected] of Object.entries(BIP173_ADDRS)) {
        assert.equal(await summaryValue(env.page, key), expected, key);
    }
    // No private material → no Derive accounts panel.
    assert.equal(await env.page.$eval('#hd-derive-panel', e => e.style.display), 'none');
});

test('public key mode: long forms (04-prefixed and raw X‖Y) match the private key', async () => {
    await env.goto('hd-wallet.html');
    const unc = await env.page.evaluate((pk) => ethers.SigningKey.computePublicKey('0x' + pk, false), TEST_PK);
    await env.page.click('#hd-mode button[data-mode="pub"]');

    await env.page.fill('#hd-pub', unc);
    await env.page.waitForSelector('#hd-summary .card');
    assert.match(await summaryValue(env.page, 'Detected type'), /uncompressed \(long form\)/);
    assert.equal(await summaryValue(env.page, 'ETH Address'), TEST_PK_ADDR);
    assert.equal(await summaryValue(env.page, 'XRP Address'), TEST_PK_CHAINS['XRP Address']);

    // Same key, Ethereum style: X‖Y without the 04 prefix.
    await env.page.fill('#hd-pub', unc.slice(4));
    assert.match(await summaryValue(env.page, 'Detected type'), /raw X‖Y/);
    assert.equal(await summaryValue(env.page, 'ETH Address'), TEST_PK_ADDR);
});

test('public key mode: 32-byte key shows Ed25519 and x-only readings', async () => {
    await env.goto('hd-wallet.html');
    await env.page.click('#hd-mode button[data-mode="pub"]');

    // The Ed25519 pubkey of TEST_PK must reproduce the hex-mode SOL/TON values.
    await env.page.fill('#hd-pub', TEST_PK_CHAINS['TON Public key (Ed25519)']);
    await env.page.waitForSelector('#hd-summary .card');
    assert.match(await summaryValue(env.page, 'Detected type'), /ambiguous/);
    assert.equal(await summaryValue(env.page, 'SOL Address'), TEST_PK_CHAINS['SOL Address']);
    assert.equal(await summaryValue(env.page, 'TON Address (v4r2, bounceable)'), TEST_PK_CHAINS['TON Address (v4r2, bounceable)']);

    // The x-only reading must reproduce the BIP86 taproot vector.
    await env.page.fill('#hd-pub', BIP86_XONLY);
    assert.equal(await summaryValue(env.page, 'BTC Address (P2TR, key-path)'), BIP86_P2TR);
});

test('public key mode: clear errors for bad input', async () => {
    await env.goto('hd-wallet.html');
    await env.page.click('#hd-mode button[data-mode="pub"]');

    // 20 bytes is an address, not a key.
    await env.page.fill('#hd-pub', '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
    await env.page.dispatchEvent('#hd-pub', 'change');
    assert.match(await env.page.$eval('#hd-error', e => e.textContent), /address, not a public key/);

    // 65 bytes must carry the 04 prefix.
    await env.page.fill('#hd-pub', '05' + 'ab'.repeat(64));
    await env.page.dispatchEvent('#hd-pub', 'change');
    assert.match(await env.page.$eval('#hd-error', e => e.textContent), /must start with the uncompressed-point prefix 04/);

    // Compressed key whose x is not on the curve.
    await env.page.fill('#hd-pub', '02' + 'ff'.repeat(32));
    await env.page.dispatchEvent('#hd-pub', 'change');
    assert.match(await env.page.$eval('#hd-error', e => e.textContent), /not on the curve/);

    // Incomplete-but-plausible hex stays quiet while typing.
    await env.page.fill('#hd-pub', '02abcd');
    assert.equal(await env.page.$eval('#hd-error', e => e.style.display), 'none');
});

test('public key mode: random buttons generate detectable keys', async () => {
    await env.goto('hd-wallet.html');
    await env.page.click('#hd-mode button[data-mode="pub"]');

    await env.page.click('#btn-hd-pub-compressed');
    await env.page.waitForSelector('#hd-summary .card');
    assert.match(await summaryValue(env.page, 'Detected type'), /compressed \(short form\)/);

    await env.page.click('#btn-hd-pub-uncompressed');
    assert.match(await summaryValue(env.page, 'Detected type'), /uncompressed \(long form\)/);
    assert.match(await env.page.$eval('#hd-pub', e => e.value), /^0x04[0-9a-f]{128}$/);

    await env.page.click('#btn-hd-pub-ed25519');
    assert.match(await summaryValue(env.page, 'Detected type'), /ambiguous/);
    assert.equal(await summaryValue(env.page, 'SOL Address') !== null, true);
});

// Keystores are built in the page itself with ethers, so the tests run against
// the real formats rather than a hand-written fixture. N=1024 keeps scrypt quick.
const KS_PASSWORD = 'correct horse battery staple';

function makeKeystore(page, { mnemonic = null, privateKey = null, password = KS_PASSWORD }) {
    return page.evaluate(async ({ m, pk, pw }) => {
        // fromPhrase lands on the default account path, m/44'/60'/0'/0/0.
        const wallet = m ? ethers.HDNodeWallet.fromPhrase(m) : new ethers.Wallet('0x' + pk);
        const account = { address: wallet.address, privateKey: wallet.privateKey };
        if (m) account.mnemonic = { path: wallet.path, locale: 'en', entropy: wallet.mnemonic.entropy };
        return ethers.encryptKeystoreJson(account, pw, { scrypt: { N: 1024, r: 8, p: 1 } });
    }, { m: mnemonic, pk: privateKey, pw: password });
}

const openKeystoreTab = (page) => page.click('#hd-mode button[data-mode="keystore"]');

test('keystore mode: a v3 keystore carrying a mnemonic recovers the whole tree', async () => {
    await env.goto('hd-wallet.html');
    await openKeystoreTab(env.page);
    await env.page.fill('#hd-ks-json', await makeKeystore(env.page, { mnemonic: TEST_MNEMONIC }));

    // The format is detected on input, and only then is a password asked for.
    const detect = await env.page.$eval('#hd-ks-detect', e => e.textContent);
    assert.match(detect, /Web3 Secret Storage v3 · scrypt \(N=1024/);
    assert.match(detect, /carries an encrypted seed phrase/);
    assert.notEqual(await env.page.$eval('#hd-ks-unlock-row', e => getComputedStyle(e).display), 'none');
    assert.equal(await env.page.$eval('#hd-summary', e => e.style.display), 'none');

    await env.page.fill('#hd-ks-pass', KS_PASSWORD);
    await env.page.click('#btn-hd-ks-unlock');
    await env.page.waitForSelector('#hd-summary .card');

    // The recovered mnemonic rebuilds the master key, not just the one account.
    const expected = await env.page.evaluate(m => ({
        root: ethers.HDNodeWallet.fromPhrase(m, '', 'm').address,
        account: ethers.HDNodeWallet.fromPhrase(m).address,
    }), TEST_MNEMONIC);
    assert.equal(await summaryValue(env.page, 'ETH Address'), expected.root);
    assert.equal(await summaryValue(env.page, 'Address'), expected.account);

    // The base path is pre-filled from the keystore's own account path, so row 0
    // of the table is the account the file was written for.
    assert.equal(await env.page.$eval('#hd-path', e => e.value), "m/44'/60'/0'/0");
    assert.equal(await env.page.$eval('#hd-table-wrap tbody tr td:nth-child(3)', e => e.textContent), expected.account);

    // Read the file, derive the KEK, check the MAC and decrypt, rebuild the tree.
    assert.equal(await env.page.$$eval('#hd-steps .hd-step', s => s.length), 4);
    assert.equal(await env.page.$eval('#hd-warn', e => e.style.display), 'none');
});

test('keystore mode: a key-only keystore derives like a raw key', async () => {
    await env.goto('hd-wallet.html');
    await openKeystoreTab(env.page);
    await env.page.fill('#hd-ks-json', await makeKeystore(env.page, { privateKey: TEST_PK }));
    await env.page.fill('#hd-ks-pass', KS_PASSWORD);
    await env.page.click('#btn-hd-ks-unlock');
    await env.page.waitForSelector('#hd-summary .card');

    assert.equal(await summaryValue(env.page, 'ETH Address'), TEST_PK_ADDR);
    assert.equal(await summaryValue(env.page, 'SOL Address'), TEST_PK_CHAINS['SOL Address']);
    // No mnemonic means no chain code — the same caveat as the raw hex tab.
    assert.match(await env.page.$eval('#hd-derive-note', e => e.textContent), /chain code/);
    assert.equal(await env.page.$$eval('#hd-steps .hd-step', s => s.length), 3);
    assert.equal(await env.page.$$eval('#hd-table-wrap tbody tr', r => r.length), 30);
});

test('keystore mode: a wrong password fails on the MAC, the right one still works', async () => {
    await env.goto('hd-wallet.html');
    await openKeystoreTab(env.page);
    await env.page.fill('#hd-ks-json', await makeKeystore(env.page, { privateKey: TEST_PK }));

    await env.page.fill('#hd-ks-pass', 'not the password');
    await env.page.click('#btn-hd-ks-unlock');
    await env.page.waitForFunction(() => document.getElementById('hd-error').style.display === 'block');
    assert.match(await env.page.$eval('#hd-error', e => e.textContent), /Incorrect password/);
    assert.equal(await env.page.$eval('#hd-summary', e => e.style.display), 'none');
    // The button must come back, not stay stuck mid-unlock.
    assert.equal(await env.page.$eval('#btn-hd-ks-unlock', e => e.disabled), false);

    await env.page.fill('#hd-ks-pass', KS_PASSWORD);
    await env.page.press('#hd-ks-pass', 'Enter');
    await env.page.waitForSelector('#hd-summary .card');
    assert.equal(await summaryValue(env.page, 'ETH Address'), TEST_PK_ADDR);
    assert.equal(await env.page.$eval('#hd-error', e => e.style.display), 'none');
});

test('keystore mode: an unencrypted keypair file needs no password', async () => {
    await env.goto('hd-wallet.html');
    await openKeystoreTab(env.page);

    // Solana CLI id.json: secret then Ed25519 public, as a plain byte array.
    const secret = [...Buffer.from(TEST_PK, 'hex')];
    const pub = [...Buffer.from(TEST_PK_CHAINS['TON Public key (Ed25519)'], 'hex')];
    await env.page.fill('#hd-ks-json', JSON.stringify(secret.concat(pub)));
    await env.page.waitForSelector('#hd-summary .card');

    assert.match(await env.page.$eval('#hd-ks-detect', e => e.textContent), /Solana CLI keypair — 64 raw bytes/);
    assert.equal(await env.page.$eval('#hd-ks-unlock-row', e => getComputedStyle(e).display), 'none');
    assert.equal(await summaryValue(env.page, 'SOL Address'), TEST_PK_CHAINS['SOL Address']);
    assert.equal(await env.page.$eval('#hd-warn', e => e.style.display), 'none');

    // A public half that does not belong to the secret is called out.
    await env.page.fill('#hd-ks-json', JSON.stringify(secret.concat(pub.slice().reverse())));
    await env.page.waitForFunction(() => document.getElementById('hd-warn').style.display === 'block');
    assert.match(await env.page.$eval('#hd-warn', e => e.textContent), /not the Ed25519 public key of its secret half/);
    // Still unlocked — the addresses come from the secret.
    assert.equal(await summaryValue(env.page, 'SOL Address'), TEST_PK_CHAINS['SOL Address']);
});

test('keystore mode: files it cannot open explain themselves', async () => {
    await env.goto('hd-wallet.html');
    await openKeystoreTab(env.page);

    // A binary keystore is a different format entirely.
    await env.page.fill('#hd-ks-json', '0 binary p12 bytes');
    await env.page.dispatchEvent('#hd-ks-json', 'change');
    assert.match(await env.page.$eval('#hd-error', e => e.textContent), /Keystore Inspector/);

    // Valid JSON, but nothing a wallet would write.
    await env.page.fill('#hd-ks-json', '{"hello":"world"}');
    await env.page.dispatchEvent('#hd-ks-json', 'change');
    assert.match(await env.page.$eval('#hd-error', e => e.textContent), /Unrecognized wallet JSON/);

    // A v1 keystore is recognizable, and refused for the right reason.
    await env.page.fill('#hd-ks-json', '{"version":1,"crypto":{"cipher":"aes-128-cbc"}}');
    await env.page.dispatchEvent('#hd-ks-json', 'change');
    assert.match(await env.page.$eval('#hd-error', e => e.textContent), /not a version-3 one/);

    // Half-pasted JSON stays quiet while typing.
    await env.page.fill('#hd-ks-json', '{"version":3,"cry');
    assert.equal(await env.page.$eval('#hd-error', e => e.style.display), 'none');
});

test('keystore mode: a chosen file fills the form and survives a tab round-trip', async () => {
    await env.goto('hd-wallet.html');
    await openKeystoreTab(env.page);
    const json = await makeKeystore(env.page, { privateKey: TEST_PK });

    await env.page.setInputFiles('#hd-ks-file', {
        name: 'UTC--2024-01-01T00-00-00.0Z--2c7536e3605d9c16a7a3d7b1898e529396a65c23',
        mimeType: 'application/json',
        buffer: Buffer.from(json),
    });
    await env.page.waitForFunction(() => document.getElementById('hd-ks-detect').style.display === 'block');
    assert.match(await env.page.$eval('#hd-ks-drop-main', e => e.textContent), /^UTC--2024-01-01/);
    assert.equal(await env.page.$eval('#hd-ks-json', e => e.value), json);

    await env.page.fill('#hd-ks-pass', KS_PASSWORD);
    await env.page.click('#btn-hd-ks-unlock');
    await env.page.waitForSelector('#hd-summary .card');
    assert.equal(await summaryValue(env.page, 'ETH Address'), TEST_PK_ADDR);

    // Leaving the tab clears the output; coming back shows the unlocked key again.
    await env.page.click('#hd-mode button[data-mode="pub"]');
    assert.equal(await env.page.$eval('#hd-summary', e => e.style.display), 'none');
    await openKeystoreTab(env.page);
    await env.page.waitForSelector('#hd-summary .card');
    assert.equal(await summaryValue(env.page, 'ETH Address'), TEST_PK_ADDR);

    // Clear wipes the file, the password and the output.
    await env.page.click('#btn-hd-ks-clear');
    assert.equal(await env.page.$eval('#hd-ks-json', e => e.value), '');
    assert.equal(await env.page.$eval('#hd-ks-pass', e => e.value), '');
    assert.equal(await env.page.$eval('#hd-summary', e => e.style.display), 'none');
    assert.match(await env.page.$eval('#hd-ks-drop-main', e => e.textContent), /Drop a keystore file/);
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
