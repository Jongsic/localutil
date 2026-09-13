// ssh-key.html — public-key tab: any representation in (OpenSSH one-line,
// PEM SPKI, RFC 4716, bare blob, fingerprint), every representation out,
// plus fingerprint comparison. Fixture values are ssh-keygen's own output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env, page;
before(async () => {
    env = await startEnv();
    page = env.page;
    await env.goto('ssh-key.html');
});
after(async () => { await env.close(); });

const ED = {
    line: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHz2wFfYf66fCCqF9SdLTuUfb+LYHahImy05s+kQywgK test@localutil',
    sha256: 'SHA256:qsFkLP6UobieFhKN5OguULncP7YrE1/WagLGWLuvvJc',
    md5: 'MD5:3a:f1:f4:3e:15:c8:2c:92:98:ea:f0:2a:a2:dc:79:35',
    pem: '-----BEGIN PUBLIC KEY-----\n' +
        'MCowBQYDK2VwAyEAfPbAV9h/rp8IKoX1J0tO5R9v4tgdqEibLTmz6RDLCAo=\n' +
        '-----END PUBLIC KEY-----\n',
};
const RSA = {
    b64: 'AAAAB3NzaC1yc2EAAAADAQABAAABAQCp0Hq1fDMRJTTv/ElutgYOUOM8BIo9eJLxRuNVcn6avkgg8Gca/5N6jruJul8CwZkTiaGSy+fb2kxT+yZ0eA5qe2sSWFdS0mhQ9bDwppi69V3mkE9U/6pJWL+jx0r5rD7bVOcTmKrjIS1v9Bsy92ieaXORHp5ZetAC5KnEVNyxXPT5rHo98uZScfJ/g7mdcduwehMvG+Clvx7wtHLzEupZcpvqkzCWp4hmD4ob7ftj61J+hCHKUQ5NUqtCiQ50T1sumNWYJ55y886eyp2fEpbzGc5t20oXuPZwyIAEh3+7PXF1Zv5yPv+/e7NY1Ne9Oo/jNg5NCtWxVm5VVhuhHMQJ',
    sha256: 'SHA256:Wz0CmnNmTYAXZosydncdNOKqUFrk5WZINdTC6wLMySU',
    pem: '-----BEGIN PUBLIC KEY-----\n' +
        'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqdB6tXwzESU07/xJbrYG\n' +
        'DlDjPASKPXiS8UbjVXJ+mr5IIPBnGv+Teo67ibpfAsGZE4mhksvn29pMU/smdHgO\n' +
        'antrElhXUtJoUPWw8KaYuvVd5pBPVP+qSVi/o8dK+aw+21TnE5iq4yEtb/QbMvdo\n' +
        'nmlzkR6eWXrQAuSpxFTcsVz0+ax6PfLmUnHyf4O5nXHbsHoTLxvgpb8e8LRy8xLq\n' +
        'WXKb6pMwlqeIZg+KG+37Y+tSfoQhylEOTVKrQokOdE9bLpjVmCeecvPOnsqdnxKW\n' +
        '8xnObdtKF7j2cMiABId/uz1xdWb+cj7/v3uzWNTXvTqP4zYOTQrVsVZuVVYboRzE\n' +
        'CQIDAQAB\n' +
        '-----END PUBLIC KEY-----\n',
};
const EC = {
    b64: 'AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBLo7RfG9emGezTyXWCNnpvNQA+9T3YMYden8DOEJHRGZyKAmO/xl0pkVF2KjMuAZBgV1o7trW5CU6Jbnz5sM3uA=',
    sha256: 'SHA256:vMkhZ3kRuW51B5TqQ3X54Tj0S21W3xpR25skt2yXzYc',
    rfc4716: '---- BEGIN SSH2 PUBLIC KEY ----\n' +
        'Comment: "ec@localutil"\n' +
        'AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBLo7RfG9emGezTyXWC\n' +
        'NnpvNQA+9T3YMYden8DOEJHRGZyKAmO/xl0pkVF2KjMuAZBgV1o7trW5CU6Jbnz5sM3uA=\n' +
        '---- END SSH2 PUBLIC KEY ----\n',
    pem: '-----BEGIN PUBLIC KEY-----\n' +
        'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEujtF8b16YZ7NPJdYI2em81AD71Pd\n' +
        'gxh16fwM4QkdEZnIoCY7/GXSmRUXYqMy4BkGBXWju2tbkJTolufPmwze4A==\n' +
        '-----END PUBLIC KEY-----\n',
};

const openPublicTab = () => page.click('#sk-tabs button[data-tab="public"]');
const fpValues = () => page.$$eval('#skp-fps .skp-fp-val', els => els.map(e => e.textContent));
const badges = () => page.$$eval('#skp-badges .sk-badge', els => els.map(e => e.textContent));
const waitResults = () => page.waitForSelector('#skp-results', { state: 'visible' });
// results update asynchronously after a debounce — wait for the format badge
// of the just-pasted input, not merely for the panel to be visible
const waitFormat = fmt => page.waitForFunction(f =>
    [...document.querySelectorAll('#skp-badges .sk-badge')].some(e => e.textContent === f), fmt);

test('tabs switch between private and public panels', async () => {
    assert.equal(await page.isVisible('#sk-tab-private'), true);
    assert.equal(await page.isVisible('#sk-tab-public'), false);
    await openPublicTab();
    assert.equal(await page.isVisible('#sk-tab-private'), false);
    assert.equal(await page.isVisible('#sk-tab-public'), true);
});

test('OpenSSH ed25519 line → fingerprints, PEM and RFC 4716', async () => {
    await openPublicTab();
    await page.fill('#skp-input', ED.line);
    await waitResults();

    assert.deepEqual(await badges(), ['Ed25519', 'OpenSSH one-line']);
    const fps = await fpValues();
    assert.equal(fps[0], ED.sha256);
    assert.equal(fps[2], ED.md5);
    assert.equal(await page.inputValue('#skp-openssh'), ED.line);
    assert.equal(await page.inputValue('#skp-pem'), ED.pem);
    assert.match(await page.inputValue('#skp-rfc4716'),
        /^---- BEGIN SSH2 PUBLIC KEY ----\nComment: "test@localutil"\n[\s\S]+---- END SSH2 PUBLIC KEY ----\n$/);
});

test('RSA PEM (SPKI) → OpenSSH line and matching fingerprint', async () => {
    await openPublicTab();
    await page.fill('#skp-input', RSA.pem);
    await waitFormat('PEM (SPKI)');

    assert.deepEqual(await badges(), ['RSA 2048', 'PEM (SPKI)']);
    assert.equal((await fpValues())[0], RSA.sha256);
    assert.equal(await page.inputValue('#skp-openssh'), 'ssh-rsa ' + RSA.b64);
    // round-trips back to the same PEM
    assert.equal(await page.inputValue('#skp-pem'), RSA.pem);
});

test('ECDSA RFC 4716 → OpenSSH line, PEM, comment preserved', async () => {
    await openPublicTab();
    await page.fill('#skp-input', EC.rfc4716);
    await waitFormat('RFC 4716 (SSH2)');

    assert.deepEqual(await badges(), ['ECDSA P-256', 'RFC 4716 (SSH2)']);
    assert.equal((await fpValues())[0], EC.sha256);
    assert.equal(await page.inputValue('#skp-openssh'), 'ecdsa-sha2-nistp256 ' + EC.b64 + ' ec@localutil');
    assert.equal(await page.inputValue('#skp-pem'), EC.pem);
});

test('compare field verifies SHA256 and MD5 fingerprints against the key', async () => {
    await openPublicTab();
    await page.fill('#skp-input', ED.line);
    await waitResults();

    await page.fill('#skp-compare', ED.sha256);
    await page.waitForSelector('#skp-cmp-result.ok');
    assert.match(await page.textContent('#skp-cmp-result'), /Same key/);

    await page.fill('#skp-compare', RSA.sha256);
    await page.waitForSelector('#skp-cmp-result.bad');
    assert.match(await page.textContent('#skp-cmp-result'), /Not the same key/);

    await page.fill('#skp-compare', ED.md5);
    await page.waitForSelector('#skp-cmp-result.ok');

    // the same key in another representation also matches
    await page.fill('#skp-compare', ED.pem.replace(/\n/g, ' '));
    await page.waitForSelector('#skp-cmp-result.ok');
});

test('fingerprint-only input shows both forms and compares against a key', async () => {
    await openPublicTab();
    await page.fill('#skp-input', ED.sha256);
    await page.waitForSelector('#skp-fp-only', { state: 'visible' });

    const forms = await page.$$eval('#skp-fp-forms .skp-fp-val', els => els.map(e => e.textContent));
    assert.equal(forms[0], ED.sha256);
    assert.match(forms[1], /^([0-9a-f]{2}:){31}[0-9a-f]{2}$/);

    // hex form pasted back in normalizes to the base64 form
    await page.fill('#skp-input', forms[1]);
    await page.waitForSelector('#skp-fp-only', { state: 'visible' });
    assert.equal((await page.$$eval('#skp-fp-forms .skp-fp-val',
        els => els.map(e => e.textContent)))[0], ED.sha256);

    // reverse comparison: fingerprint above, full key below
    await page.fill('#skp-compare', ED.line);
    await page.waitForSelector('#skp-cmp-result.ok');
    await page.fill('#skp-compare', 'ssh-rsa ' + RSA.b64);
    await page.waitForSelector('#skp-cmp-result.bad');
});

test('wrong-tab pastes get pointed at the right tab', async () => {
    await openPublicTab();
    await page.fill('#skp-input', '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----');
    await page.waitForSelector('#skp-error', { state: 'visible' });
    assert.match(await page.textContent('#skp-error'), /Private key tab/);

    await page.click('#sk-tabs button[data-tab="private"]');
    await page.fill('#sk-input', ED.line);
    await page.waitForSelector('#sk-error', { state: 'visible' });
    assert.match(await page.textContent('#sk-error'), /Public key tab/);
});

test('private tab still extracts a public key from a private key', async () => {
    await page.click('#sk-tabs button[data-tab="private"]');
    const priv = [
        '-----BEGIN OPENSSH PRIVATE KEY-----',
        'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
        'QyNTUxOQAAACB89sBX2H+unwgqhfUnS07lH2/i2B2oSJstObPpEMsICgAAAJgkw9O4JMPT',
        'uAAAAAtzc2gtZWQyNTUxOQAAACB89sBX2H+unwgqhfUnS07lH2/i2B2oSJstObPpEMsICg',
        'AAAEBAAhEajFNzTDGcCJ06ts4hCLsVB/VkiX6ptVDyH9wC1Hz2wFfYf66fCCqF9SdLTuUf',
        'b+LYHahImy05s+kQywgKAAAADnRlc3RAbG9jYWx1dGlsAQIDBAUGBw==',
        '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    await page.fill('#sk-input', priv);
    await page.waitForSelector('#sk-results', { state: 'visible' });
    assert.equal(await page.inputValue('#sk-pub'), ED.line);
});
