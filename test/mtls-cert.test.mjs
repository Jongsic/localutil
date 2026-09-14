import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { startEnv } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

const CLIENT_AUTH = '1.3.6.1.5.5.7.3.2';
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

// Every artifact keeps its PEM in a textarea next to its filename, whether or
// not the user unfolded it — so the test reads exactly what a copy would give.
const artifact = (scope, filename) => env.page.evaluate(([scope, filename]) => {
    const blocks = [...document.querySelectorAll(scope + ' .mc-out')];
    const hit = blocks.find(b => b.querySelector('.mc-out-name').textContent === filename);
    return hit ? hit.querySelector('textarea').value : null;
}, [scope, filename]);

const caStatus = () => env.page.evaluate(() => {
    const el = document.getElementById('ca-status');
    return { level: el.className.split(/\s+/).filter(c => ['ok', 'warn', 'bad'].includes(c))[0], text: el.textContent };
});

const resultRow = (key) => env.page.evaluate(key => {
    const row = [...document.querySelectorAll('#mc-results .mc-row')]
        .find(r => r.querySelector('.mc-row-key').textContent === key);
    return row ? row.querySelector('.mc-row-val').textContent : null;
}, key);

async function createCa(fields = {}) {
    await env.goto('mtls-cert.html');
    for (const [id, value] of Object.entries({ 'ca-cn': 'Test Root CA', 'ca-c': 'KR', ...fields })) {
        await env.page.fill('#' + id, value);
    }
    await env.page.click('#btn-ca-create');
    await env.page.waitForSelector('#ca-outputs .mc-out');
}

async function issue(fields = {}) {
    for (const [id, value] of Object.entries({ 'cl-cn': 'client-01', ...fields })) {
        await env.page.fill('#' + id, value);
    }
    const before = await env.page.$$eval('#mc-results .card', els => els.length);
    await env.page.click('#btn-issue');
    await env.page.waitForFunction(
        n => document.querySelectorAll('#mc-results .card').length > n, before);
}

test('a new CA comes out usable, and its key matches its certificate', async () => {
    await createCa();

    const caPem = await artifact('#ca-outputs', 'ca.crt');
    const caKeyPem = await artifact('#ca-outputs', 'ca.key');
    assert.match(caPem, /^-----BEGIN CERTIFICATE-----/);
    assert.match(caKeyPem, /^-----BEGIN PRIVATE KEY-----/);

    const ca = new X509Certificate(caPem);
    assert.equal(ca.subject.replace(/\n/g, ', '), 'CN=Test Root CA, C=KR');
    assert.equal(ca.issuer, ca.subject, 'a root CA is self-issued');
    assert.equal(ca.ca, true, 'basicConstraints CA:TRUE — an ALB trust store needs it');
    assert.equal(ca.verify(ca.publicKey), true, 'self-signature checks out');
    assert.equal(ca.checkPrivateKey(createPrivateKey(caKeyPem)), true);

    const status = await caStatus();
    assert.equal(status.level, 'ok');
    assert.match(status.text, /CN=Test Root CA/);
});

test('the issued client certificate chains to that CA and is a client certificate', async () => {
    await issue({ 'cl-o': 'Acme', 'cl-san': 'device.example.com\n10.0.0.5\nops@example.com' });

    const caPem = await artifact('#ca-outputs', 'ca.crt');
    const crtPem = await artifact('#mc-results', 'client-01.crt');
    const keyPem = await artifact('#mc-results', 'client-01.key');
    const chainPem = await artifact('#mc-results', 'client-01-fullchain.crt');

    const ca = new X509Certificate(caPem);
    const cert = new X509Certificate(crtPem);

    assert.equal(cert.subject.replace(/\n/g, ', '), 'CN=client-01, O=Acme');
    assert.equal(cert.issuer, ca.subject);
    assert.equal(cert.verify(ca.publicKey), true, 'signed by the CA');
    assert.equal(cert.checkIssued(ca), true);
    assert.equal(cert.ca, false);
    assert.deepEqual(cert.keyUsage, [CLIENT_AUTH], 'clientAuth only, unless serverAuth was asked for');
    assert.equal(cert.checkPrivateKey(createPrivateKey(keyPem)), true);

    assert.match(cert.subjectAltName, /DNS:device\.example\.com/);
    assert.match(cert.subjectAltName, /IP Address:10\.0\.0\.5/);
    assert.match(cert.subjectAltName, /email:ops@example\.com/);

    // fullchain is leaf-then-CA, the order every server expects
    assert.equal(chainPem, crtPem + caPem);
    assert.equal(await resultRow('Chain'), 'verified against the CA above');
    assert.equal(await resultRow('SHA-256'), cert.fingerprint256);
});

test('the .p12 opens with the password it was given', async () => {
    await env.page.fill('#p12-pass', 'p12-secret');
    await issue({ 'cl-cn': 'client-02' });

    const b64 = await artifact('#mc-results', 'client-02.p12');
    assert.ok(b64.length > 100);

    const opened = await env.page.evaluate(b64 => {
        const der = forge.util.decode64(b64);
        const read = pass => {
            const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), pass);
            const certs = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
            const keys = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag];
            return { certs: certs.map(b => b.cert.subject.getField('CN').value), keys: keys.length };
        };
        const out = { right: read('p12-secret') };
        try { read('wrong'); out.wrongAccepted = true; } catch (e) { out.wrongAccepted = false; }
        return out;
    }, b64);

    assert.deepEqual(opened.right.certs, ['client-02', 'Test Root CA'], 'client and CA are both in the bundle');
    assert.equal(opened.right.keys, 1);
    assert.equal(opened.wrongAccepted, false, 'a wrong password must not open it');
});

test('serverAuth is added only when asked for', async () => {
    await env.page.evaluate(() => { document.querySelector('#client-card details').open = true; });
    // the checkbox itself is the invisible half of a .switch — the track is what a user clicks
    const toggle = 'label.switch:has(#cl-eku-server) span';
    await env.page.click(toggle);
    await issue({ 'cl-cn': 'client-03' });
    const cert = new X509Certificate(await artifact('#mc-results', 'client-03.crt'));
    assert.deepEqual(cert.keyUsage.sort(), [SERVER_AUTH, CLIENT_AUTH].sort());
    await env.page.click(toggle);
});

test('a non-ASCII subject survives the round trip', async () => {
    await issue({ 'cl-cn': '한글-클라이언트', 'cl-o': '루루' });
    const cert = new X509Certificate(await artifact('#mc-results', 'client.crt'));
    assert.match(cert.subject, /CN=한글-클라이언트/);
    assert.match(cert.subject, /O=루루/);
});

test('an existing CA can be pasted back in and keeps signing', async () => {
    const caPem = await artifact('#ca-outputs', 'ca.crt');
    const caKeyPem = await artifact('#ca-outputs', 'ca.key');

    await env.goto('mtls-cert.html');
    await env.page.click('#ca-mode button[data-mode="existing"]');
    await env.page.fill('#ca-crt-in', caPem);
    await env.page.fill('#ca-key-in', caKeyPem);
    await env.page.click('#btn-ca-load');
    await env.page.waitForSelector('#ca-status.ok');

    await issue({ 'cl-cn': 'reloaded' });
    const cert = new X509Certificate(await artifact('#mc-results', 'reloaded.crt'));
    assert.equal(cert.verify(new X509Certificate(caPem).publicKey), true);
});

test('a CA key that does not match the certificate is refused', async () => {
    await createCa({ 'ca-cn': 'One CA' });
    const caPem = await artifact('#ca-outputs', 'ca.crt');
    await createCa({ 'ca-cn': 'Other CA' });
    const otherKey = await artifact('#ca-outputs', 'ca.key');

    await env.goto('mtls-cert.html');
    await env.page.click('#ca-mode button[data-mode="existing"]');
    await env.page.fill('#ca-crt-in', caPem);
    await env.page.fill('#ca-key-in', otherKey);
    await env.page.click('#btn-ca-load');

    const error = await env.page.textContent('#mc-error');
    assert.match(error, /does not belong/);
    assert.equal(await env.page.isVisible('#ca-status'), false);
});

test('an encrypted CA key needs its password, and the right one', async () => {
    await createCa({ 'ca-cn': 'Locked CA', 'ca-newpass': 'ca-secret' });
    const caPem = await artifact('#ca-outputs', 'ca.crt');
    const caKeyPem = await artifact('#ca-outputs', 'ca.key');
    assert.match(caKeyPem, /^-----BEGIN ENCRYPTED PRIVATE KEY-----/);

    await env.goto('mtls-cert.html');
    await env.page.click('#ca-mode button[data-mode="existing"]');
    await env.page.fill('#ca-crt-in', caPem);
    await env.page.fill('#ca-key-in', caKeyPem);

    await env.page.click('#btn-ca-load');
    assert.match(await env.page.textContent('#mc-error'), /encrypted/);

    await env.page.fill('#ca-pass', 'nope');
    await env.page.click('#btn-ca-load');
    assert.match(await env.page.textContent('#mc-error'), /Wrong password/);

    await env.page.fill('#ca-pass', 'ca-secret');
    await env.page.click('#btn-ca-load');
    await env.page.waitForSelector('#ca-status.ok');
});

test('sections 2 and 3 stay inert until a CA is loaded', async () => {
    await env.goto('mtls-cert.html');
    assert.equal(await env.page.evaluate(() =>
        ['client-card', 'issue-card'].every(id => document.getElementById(id).classList.contains('mc-locked'))), true);
    await createCa();
    assert.equal(await env.page.evaluate(() =>
        ['client-card', 'issue-card'].some(id => document.getElementById(id).classList.contains('mc-locked'))), false);
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
