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

// --- Keystore export dialog ---------------------------------------------------
// Every file is opened again with ethers' own decryptKeystoreJson — an
// independent implementation — so a passing round trip means the KDF, cipher,
// counter mode and MAC all match what wallets expect.

async function openExport(page) {
    await page.click('#hd-summary .hd-kx-open');
    await page.waitForSelector('#hd-kx[open]');
}

async function exportKeystore(page, { password = '', kdf = 'scrypt', n = '1024', c = null, prf = null, dklen = null } = {}) {
    await page.fill('#hd-kx-pass', password);
    await page.fill('#hd-kx-pass2', password);
    await page.click(`#hd-kx-kdf button[data-kdf="${kdf}"]`);
    if (kdf === 'scrypt') await page.selectOption('#hd-kx-n', n);
    if (c) await page.fill('#hd-kx-c', c);
    if (prf) await page.selectOption('#hd-kx-prf', prf);
    if (dklen) await page.fill('#hd-kx-dklen', dklen);
    await page.click('#hd-kx-build');
    await page.waitForFunction(() => document.getElementById('hd-kx-result').style.display === 'block');
    return page.$eval('#hd-kx-out', e => e.textContent);
}

const decryptInPage = (page, json, password) =>
    page.evaluate(async ({ j, pw }) => (await ethers.decryptKeystoreJson(j, pw)).privateKey, { j: json, pw: password });

test('keystore export: defaults are geth standard scrypt, and the file reopens', async () => {
    await env.goto('hd-wallet.html');
    await env.page.click('#hd-mode button[data-mode="hex"]');
    await env.page.fill('#hd-hex', TEST_PK);
    await env.page.waitForSelector('#hd-summary .card');
    await openExport(env.page);

    assert.equal(await env.page.$eval('#hd-kx-address', e => e.textContent), TEST_PK_ADDR);
    assert.equal(await env.page.inputValue('#hd-kx-n'), '262144');
    assert.equal(await env.page.inputValue('#hd-kx-r'), '8');
    assert.equal(await env.page.inputValue('#hd-kx-p'), '1');
    assert.equal(await env.page.inputValue('#hd-kx-dklen'), '32');
    assert.match(await env.page.$eval('#hd-kx-presets .active', e => e.textContent), /Standard/);
    assert.match(await env.page.$eval('#hd-kx-cost', e => e.textContent), /256 MiB/);
    // Blank password is allowed, with a warning.
    assert.equal(await env.page.$eval('#hd-kx-nopass', e => e.style.display), 'block');

    const text = await exportKeystore(env.page, { password: KS_PASSWORD });
    const json = JSON.parse(text);
    assert.equal(json.version, 3);
    assert.equal(json.address, TEST_PK_ADDR.slice(2).toLowerCase());
    assert.match(json.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(Object.keys(json.crypto), ['cipher', 'ciphertext', 'cipherparams', 'kdf', 'kdfparams', 'mac']);
    assert.equal(json.crypto.cipher, 'aes-128-ctr');
    assert.equal(json.crypto.kdf, 'scrypt');
    assert.deepEqual({ ...json.crypto.kdfparams, salt: undefined }, { dklen: 32, n: 1024, p: 1, r: 8, salt: undefined });
    assert.match(json.crypto.kdfparams.salt, /^[0-9a-f]{64}$/);
    assert.match(json.crypto.cipherparams.iv, /^[0-9a-f]{32}$/);
    assert.equal(await decryptInPage(env.page, text, KS_PASSWORD), '0x' + TEST_PK);

    // Pretty-print only changes whitespace.
    await env.page.click('label.switch:has(#hd-kx-pretty)');
    const compact = await env.page.$eval('#hd-kx-out', e => e.textContent);
    assert.ok(!compact.includes('\n'));
    assert.deepEqual(JSON.parse(compact), json);

    // The download is exactly the shown text, under a geth-style name.
    const [download] = await Promise.all([
        env.page.waitForEvent('download'),
        env.page.click('#hd-kx-download'),
    ]);
    assert.match(download.suggestedFilename(), new RegExp('^UTC--\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\d\\.\\d{3}Z--' + json.address + '\\.json$'));
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), compact);

    // Changing an option drops the stale file; closing forgets the password.
    await env.page.fill('#hd-kx-r', '4');
    assert.equal(await env.page.$eval('#hd-kx-result', e => e.style.display), 'none');
    await env.page.click('#hd-kx-close');
    assert.equal(await env.page.$eval('#hd-kx', e => e.open), false);
    await openExport(env.page);
    assert.equal(await env.page.inputValue('#hd-kx-pass'), '');
});

test('keystore export: PBKDF2 and an empty password round-trip through the keystore tab', async () => {
    await env.goto('hd-wallet.html');
    await env.page.click('#hd-mode button[data-mode="hex"]');
    await env.page.fill('#hd-hex', TEST_PK);
    await env.page.waitForSelector('#hd-summary .card');
    await openExport(env.page);

    // hmac-sha512 is readable by ethers but not geth — the dialog says so.
    const text512 = await exportKeystore(env.page, { kdf: 'pbkdf2', c: '1000', prf: 'hmac-sha512', password: KS_PASSWORD });
    assert.match(await env.page.$eval('#hd-kx-compat', e => e.textContent), /geth only reads hmac-sha256/);
    const j512 = JSON.parse(text512);
    assert.deepEqual(Object.keys(j512.crypto.kdfparams), ['c', 'dklen', 'prf', 'salt']);
    assert.equal(j512.crypto.kdfparams.prf, 'hmac-sha512');
    assert.equal(await decryptInPage(env.page, text512, KS_PASSWORD), '0x' + TEST_PK);

    const text = await exportKeystore(env.page, { kdf: 'pbkdf2', c: '1000', prf: 'hmac-sha256', password: '' });
    assert.equal(await env.page.$eval('#hd-kx-compat', e => e.style.display), 'none');
    assert.equal(JSON.parse(text).crypto.kdfparams.c, 1000);
    await env.page.click('#hd-kx-close');

    // Open it in the keystore tab with the password field left blank.
    await openKeystoreTab(env.page);
    await env.page.fill('#hd-ks-json', text);
    await env.page.click('#btn-hd-ks-unlock');
    await env.page.waitForSelector('#hd-summary .card');
    assert.equal(await summaryValue(env.page, 'ETH Address'), TEST_PK_ADDR);

    // A real password left blank still explains itself.
    await env.page.fill('#hd-ks-json', await makeKeystore(env.page, { privateKey: TEST_PK }));
    await env.page.click('#btn-hd-ks-unlock');
    await env.page.waitForFunction(() => document.getElementById('hd-error').style.display === 'block');
    assert.match(await env.page.$eval('#hd-error', e => e.textContent), /enter its password/);
});

test('keystore export: the seed root key, custom dklen and input checks', async () => {
    await env.goto('hd-wallet.html');
    await env.page.fill('#hd-mnemonic', TEST_MNEMONIC);
    await env.page.click('#btn-hd-generate');
    await env.page.waitForSelector('#hd-summary .card');
    await openExport(env.page);

    // Mismatched passwords never encrypt.
    await env.page.fill('#hd-kx-pass', 'one');
    await env.page.fill('#hd-kx-pass2', 'two');
    await env.page.click('#hd-kx-build');
    assert.match(await env.page.$eval('#hd-kx-error', e => e.textContent), /do not match/);
    assert.equal(await env.page.$eval('#hd-kx-result', e => e.style.display), 'none');

    // Out-of-range parameters are refused with the reason.
    await env.page.fill('#hd-kx-pass2', 'one');
    await env.page.fill('#hd-kx-r', '0');
    await env.page.click('#hd-kx-build');
    assert.match(await env.page.$eval('#hd-kx-error', e => e.textContent), /r must be a whole number from 1 to 32/);
    await env.page.selectOption('#hd-kx-n', String(2 ** 20));
    await env.page.fill('#hd-kx-r', '16');
    await env.page.click('#hd-kx-build');
    assert.match(await env.page.$eval('#hd-kx-error', e => e.textContent), /2 GiB of memory/);
    await env.page.click('#hd-kx-presets [data-preset="light"]');
    assert.deepEqual(
        [await env.page.inputValue('#hd-kx-n'), await env.page.inputValue('#hd-kx-r'), await env.page.inputValue('#hd-kx-p')],
        ['4096', '8', '6']);

    // dklen 48: ethers refuses it, so check the MAC and the cipher by hand,
    // the way geth reads the file (derivedKey[0:16] for AES, [16:32] for the MAC).
    const text = await exportKeystore(env.page, { password: 'one', dklen: '48' });
    assert.match(await env.page.$eval('#hd-kx-compat', e => e.textContent), /accept only dklen = 32/);
    const opened = await env.page.evaluate(async (j) => {
        const c = JSON.parse(j).crypto, kp = c.kdfparams;
        const dk = ethers.getBytes(await ethers.scrypt(ethers.toUtf8Bytes('one'), '0x' + kp.salt, kp.n, kp.r, kp.p, kp.dklen));
        const ct = ethers.getBytes('0x' + c.ciphertext);
        const macOk = ethers.keccak256(ethers.concat([dk.slice(16, 32), ct])) === '0x' + c.mac;
        const key = await crypto.subtle.importKey('raw', dk.slice(0, 16), 'AES-CTR', false, ['decrypt']);
        const pt = await crypto.subtle.decrypt({ name: 'AES-CTR', counter: ethers.getBytes('0x' + c.cipherparams.iv), length: 128 }, key, ct);
        return { macOk, dklen: kp.dklen, privateKey: ethers.hexlify(new Uint8Array(pt)) };
    }, text);
    const rootKey = await env.page.evaluate((m) => {
        const seed = ethers.pbkdf2(ethers.toUtf8Bytes(m), ethers.toUtf8Bytes('mnemonic'), 2048, 64, 'sha512');
        return ethers.HDNodeWallet.fromSeed(seed).privateKey;
    }, TEST_MNEMONIC);
    assert.deepEqual(opened, { macOk: true, dklen: 48, privateKey: rootKey });
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
