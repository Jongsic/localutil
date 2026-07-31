import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

async function setCidr(expr) {
    await env.page.fill('#cidr-input', expr);
}

async function details() {
    return Object.fromEntries(await env.page.$$eval('#cidr-details .result-row', rows =>
        rows.map(r => [
            r.querySelector('.result-label').textContent,
            r.querySelector('.result-val').textContent.trim(),
        ])));
}

test('IPv4 /24 details', async () => {
    await env.goto('cidr.html');
    await setCidr('192.168.1.0/24');
    assert.equal(await env.page.textContent('#cidr-headline'), '192.168.1.0/24');
    const d = await details();
    assert.equal(d['Network address'], '192.168.1.0');
    assert.equal(d['Broadcast address'], '192.168.1.255');
    assert.equal(d['Netmask'], '255.255.255.0');
    assert.equal(d['Wildcard mask'], '0.0.0.255');
    assert.equal(d['First usable host'], '192.168.1.1');
    assert.equal(d['Last usable host'], '192.168.1.254');
    assert.equal(d['Total addresses'], '256');
    assert.equal(d['Usable hosts'], '254');
    assert.match(d['Address type'], /Private \(RFC 1918\)/);
    assert.match(d['Address type'], /Class C/);
    assert.equal(d['Address as integer'], '3232235776');
    assert.equal(d['Address as hex'], '0xC0A80100');
    assert.equal(d['Binary netmask'], '11111111.11111111.11111111.00000000');
});

test('host bits are masked to the network', async () => {
    await env.goto('cidr.html');
    await setCidr('10.20.30.40/16');
    assert.equal(await env.page.textContent('#cidr-headline'), '10.20.0.0/16');
    const d = await details();
    assert.equal(d['Input address'], '10.20.30.40');
    assert.equal(d['Network address'], '10.20.0.0');
    assert.equal(d['Broadcast address'], '10.20.255.255');
});

test('/31 and /32 edge prefixes', async () => {
    await env.goto('cidr.html');
    await setCidr('10.0.0.0/31');
    let d = await details();
    assert.match(d['Broadcast address'], /—/);
    assert.equal(d['Usable hosts'], '2');
    assert.equal(d['First usable host'], '10.0.0.0');
    assert.equal(d['Last usable host'], '10.0.0.1');

    await setCidr('10.0.0.7');           // bare address → /32
    assert.equal(await env.page.textContent('#cidr-headline'), '10.0.0.7/32');
    d = await details();
    assert.equal(d['Usable hosts'], '1');
});

test('adjacent blocks: previous, next, parent — and click-to-load', async () => {
    await env.goto('cidr.html');
    await setCidr('192.168.1.0/24');
    assert.equal(await env.page.textContent('#nav-prev'), '← 192.168.0.0/24');
    assert.equal(await env.page.textContent('#nav-next'), '192.168.2.0/24 →');
    assert.equal(await env.page.textContent('#nav-parent'), '↑ 192.168.0.0/23');

    await env.page.click('#nav-next');
    assert.equal(await env.page.inputValue('#cidr-input'), '192.168.2.0/24');
    assert.equal(await env.page.textContent('#cidr-headline'), '192.168.2.0/24');

    await env.page.click('#nav-prev');
    assert.equal(await env.page.textContent('#cidr-headline'), '192.168.1.0/24');
});

test('adjacent blocks disabled at the address-space edges', async () => {
    await env.goto('cidr.html');
    await setCidr('0.0.0.0/0');
    assert.ok(await env.page.$eval('#nav-prev', b => b.disabled));
    assert.ok(await env.page.$eval('#nav-next', b => b.disabled));
    assert.ok(await env.page.$eval('#nav-parent', b => b.disabled));

    await setCidr('0.0.0.0/8');
    assert.ok(await env.page.$eval('#nav-prev', b => b.disabled));
    assert.ok(!(await env.page.$eval('#nav-next', b => b.disabled)));

    await setCidr('255.255.255.255/32');
    assert.ok(await env.page.$eval('#nav-next', b => b.disabled));
    assert.ok(!(await env.page.$eval('#nav-prev', b => b.disabled)));
});

test('IPv6 details and canonical compression', async () => {
    await env.goto('cidr.html');
    await setCidr('2001:0db8:0000:0000:0000:0000:0000:0001/48');
    assert.equal(await env.page.textContent('#cidr-headline'), '2001:db8::/48');
    const d = await details();
    assert.equal(d['Input address'], '2001:db8::1');
    assert.equal(d['Expanded address'], '2001:0db8:0000:0000:0000:0000:0000:0001');
    assert.equal(d['First address'], '2001:db8::');
    assert.equal(d['Last address'], '2001:db8:0:ffff:ffff:ffff:ffff:ffff');
    assert.match(d['Total addresses'], /= 2\^80$/);
    assert.match(d['Address type'], /Documentation/);
});

test('subnet split renders rows and loads a subnet on click', async () => {
    await env.goto('cidr.html');
    await setCidr('192.168.1.0/24');
    // default new prefix is /25 → 2 subnets
    let rows = await env.page.$$eval('#split-table .sub-cidr', els => els.map(e => e.textContent));
    assert.deepEqual(rows, ['192.168.1.0/25', '192.168.1.128/25']);

    await env.page.selectOption('#split-prefix', '26');
    rows = await env.page.$$eval('#split-table .sub-cidr', els => els.map(e => e.textContent));
    assert.deepEqual(rows, ['192.168.1.0/26', '192.168.1.64/26', '192.168.1.128/26', '192.168.1.192/26']);

    await env.page.click('#split-table .sub-cidr >> nth=1');
    assert.equal(await env.page.textContent('#cidr-headline'), '192.168.1.64/26');
});

test('large splits are capped at 64 rows with a note', async () => {
    await env.goto('cidr.html');
    await setCidr('10.0.0.0/8');
    await env.page.selectOption('#split-prefix', '24');
    const rows = await env.page.$$eval('#split-table .sub-cidr', els => els.length);
    assert.equal(rows, 64);
    assert.match(await env.page.textContent('#split-note'), /64 \/ 65,536/);
});

test('IP membership check', async () => {
    await env.goto('cidr.html');
    await setCidr('192.168.1.0/24');

    await env.page.fill('#check-input', '192.168.1.55');
    let txt = await env.page.textContent('#check-result');
    assert.match(txt, /Inside this network/);
    assert.match(txt, /host offset 55/);

    await env.page.fill('#check-input', '10.0.0.1');
    assert.match(await env.page.textContent('#check-result'), /Outside this network/);

    await env.page.fill('#check-input', '2001:db8::1');
    assert.match(await env.page.textContent('#check-result'), /Version mismatch/);
});

test('IP range to minimal CIDR set', async () => {
    await env.goto('cidr.html');
    await env.page.fill('#range-start', '192.168.1.10');
    await env.page.fill('#range-end', '192.168.1.20');
    const chips = await env.page.$$eval('#range-result .chip', els => els.map(e => e.textContent));
    assert.deepEqual(chips, ['192.168.1.10/31', '192.168.1.12/30', '192.168.1.16/30', '192.168.1.20/32']);

    await env.page.fill('#range-start', '0.0.0.0');
    await env.page.fill('#range-end', '255.255.255.255');
    assert.deepEqual(
        await env.page.$$eval('#range-result .chip', els => els.map(e => e.textContent)),
        ['0.0.0.0/0']);

    await env.page.fill('#range-start', '192.168.1.20');
    await env.page.fill('#range-end', '192.168.1.10');
    assert.match(await env.page.textContent('#range-error'), /must not be greater/);
});

test('invalid input shows an error and clears results', async () => {
    await env.goto('cidr.html');
    await setCidr('192.168.1.300/24');
    assert.match(await env.page.textContent('#cidr-error'), /Invalid IPv4 address/);
    assert.equal(await env.page.textContent('#cidr-headline'), '—');

    await setCidr('192.168.1.0/33');
    assert.match(await env.page.textContent('#cidr-error'), /between 0 and 32/);

    await setCidr('2001:db8::/129');
    assert.match(await env.page.textContent('#cidr-error'), /between 0 and 128/);

    await setCidr('1:2:3:4:5:6:7:8:9');
    assert.match(await env.page.textContent('#cidr-error'), /Invalid IPv6 address/);
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
