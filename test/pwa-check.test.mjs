import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

async function checklistRows() {
    return env.page.$$eval('#pwa-checklist .pwa-check-row', rows =>
        rows.map(r => ({
            status: [...r.classList].find(c => ['ok', 'warn', 'fail', 'opt'].includes(c)),
            label: r.querySelector('.pwa-check-label').textContent,
            note: r.querySelector('.pwa-check-note').textContent,
        })));
}

const row = (rows, label) => rows.find(r => r.label === label);

// A manifest that satisfies every install requirement. Icon paths stay
// relative and no URL is set in most tests, so nothing hits the network.
const GOOD_MANIFEST = JSON.stringify({
    name: 'Demo App',
    short_name: 'Demo',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: '#123456',
    background_color: '#ffffff',
    description: 'demo',
    icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: 'mask-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    screenshots: [{ src: 'shot.png', sizes: '1080x1920' }],
});

const GOOD_HTML = `<html lang="en"><head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#123456">
    <link rel="manifest" href="manifest.json">
    <link rel="apple-touch-icon" href="apple-touch-icon.png">
    <script>navigator.serviceWorker.register('/sw.js')</scr` + `ipt>
</head></html>`;

test('missing manifest link is a blocking failure', async () => {
    await env.goto('pwa-check.html');
    assert.equal(await env.page.$eval('#pwa-results', e => e.style.display), 'none');

    await env.page.fill('#pwa-src', '<html><head><title>x</title></head></html>');
    const rows = await checklistRows();
    assert.equal(row(rows, 'Manifest link').status, 'fail');
    assert.equal(row(rows, 'Viewport meta').status, 'warn');
    assert.equal(row(rows, 'Apple touch icon').status, 'warn');
});

test('complete HTML + manifest passes the install checklist', async () => {
    await env.goto('pwa-check.html');
    await env.page.fill('#pwa-src', GOOD_HTML);
    await env.page.fill('#pwa-manifest', GOOD_MANIFEST);
    const rows = await checklistRows();
    for (const label of ['Manifest link', 'Manifest JSON', 'name / short_name', 'Icon ≥ 192px',
        'Icon 512px', 'Maskable icon', 'display', 'start_url', 'scope', 'id',
        'theme_color', 'background_color', 'Richer install UI', 'Viewport meta',
        'Apple touch icon', 'Service worker']) {
        assert.equal(row(rows, label).status, 'ok', label + ': ' + row(rows, label).note);
    }
    // The SW register path is surfaced from the source.
    assert.match(row(rows, 'Service worker').note, /\/sw\.js/);
    // Ordering: worst problems first.
    const rank = { fail: 0, warn: 1, opt: 2, ok: 3 };
    const order = rows.map(r => rank[r.status]);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('invalid manifest JSON and display:browser are blocking', async () => {
    await env.goto('pwa-check.html');
    await env.page.fill('#pwa-manifest', '{oops}');
    let rows = await checklistRows();
    assert.equal(row(rows, 'Manifest JSON').status, 'fail');

    await env.page.fill('#pwa-manifest', JSON.stringify({ name: 'x', display: 'browser', icons: [] }));
    rows = await checklistRows();
    assert.equal(row(rows, 'display').status, 'fail');
    assert.equal(row(rows, 'Icons').status, 'fail');
});

test('icon under 192px and missing maskable are flagged', async () => {
    await env.goto('pwa-check.html');
    await env.page.fill('#pwa-manifest', JSON.stringify({
        name: 'x', display: 'standalone', start_url: '/',
        icons: [{ src: 'a.png', sizes: '144x144' }],
    }));
    const rows = await checklistRows();
    assert.equal(row(rows, 'Icon ≥ 192px').status, 'fail');
    assert.equal(row(rows, 'Maskable icon').status, 'warn');
});

test('theme_color mismatch between HTML and manifest warns', async () => {
    await env.goto('pwa-check.html');
    await env.page.fill('#pwa-src', '<head><meta name="theme-color" content="#ffffff"><link rel="manifest" href="m.json"></head>');
    await env.page.fill('#pwa-manifest', JSON.stringify({ name: 'x', theme_color: '#000000' }));
    const rows = await checklistRows();
    assert.equal(row(rows, 'theme_color').status, 'warn');
    assert.match(row(rows, 'theme_color').note, /#000000.*#ffffff/);
});

test('http URL fails the secure-context check, localhost passes', async () => {
    await env.goto('pwa-check.html');
    await env.page.fill('#pwa-src', GOOD_HTML);
    await env.page.fill('#pwa-url', 'http://example.com/');
    let rows = await checklistRows();
    assert.equal(row(rows, 'HTTPS').status, 'fail');

    await env.page.fill('#pwa-url', 'http://localhost:3000/');
    rows = await checklistRows();
    assert.equal(row(rows, 'HTTPS').status, 'ok');
});

test('manifest icons render as preview cells with maskable safe zone', async () => {
    await env.goto('pwa-check.html');
    await env.page.fill('#pwa-manifest', GOOD_MANIFEST);
    const cells = await env.page.$$eval('#pwa-icon-grid .pwa-icon-cell', cs => cs.length);
    assert.equal(cells, 3);
    const maskable = await env.page.$$eval('#pwa-icon-grid .pwa-icon-frame.maskable', cs => cs.length);
    assert.equal(maskable, 1);
    // Without a page URL relative srcs are not fetched — no network in tests.
    const placeholders = await env.page.$$eval('#pwa-icon-grid .pwa-icon-missing', els => els.map(e => e.textContent));
    assert.equal(placeholders.length, 3);
    assert.match(placeholders[0], /enter the page URL/);
});

test('install prompt preview shows short_name and description', async () => {
    await env.goto('pwa-check.html');
    await env.page.fill('#pwa-manifest', GOOD_MANIFEST);
    assert.equal(await env.page.$eval('.pwa-prompt-name', e => e.textContent), 'Demo');
    assert.equal(await env.page.$eval('.pwa-prompt-desc', e => e.textContent), 'demo');
});

test('load example produces a checklist with no blockers', async () => {
    await env.goto('pwa-check.html');
    await env.page.click('#btn-pwa-example');
    const rows = await checklistRows();
    assert.equal(rows.filter(r => r.status === 'fail').length, 0,
        JSON.stringify(rows.filter(r => r.status === 'fail')));
    assert.equal(row(rows, 'HTTPS').status, 'ok');
});

test('service worker helper has copyable snippet and chrome:// address', async () => {
    await env.goto('pwa-check.html');
    await env.page.fill('#pwa-src', '<head><link rel="manifest" href="m.json"></head>');
    assert.match(await env.page.$eval('#pwa-sw-snippet', e => e.textContent), /getRegistrations/);
    assert.ok(await env.page.$('#btn-pwa-snippet'));
    assert.ok(await env.page.$('#btn-pwa-swinternals'));
    assert.match(await env.page.$eval('#pwa-sw-status', e => e.textContent), /No register\(\) call/);
});

test('view-source copy enables with a URL; manifest link becomes clickable', async () => {
    await env.goto('pwa-check.html');
    assert.ok(await env.page.$eval('#pwa-view-source', e => e.disabled));
    await env.page.fill('#pwa-url', 'https://example.com/app/');
    assert.equal(await env.page.$eval('#pwa-view-source', e => e.disabled), false);

    // Relative manifest href resolves against the URL and becomes a raw-JSON link.
    await env.page.fill('#pwa-src', '<head><link rel="manifest" href="manifest.webmanifest"></head>');
    const href = await env.page.$eval('#pwa-manifest-hint a', a => a.href);
    assert.equal(href, 'https://example.com/app/manifest.webmanifest');

    // Without a base URL the hint still names the path but has no link.
    await env.page.fill('#pwa-url', '');
    assert.equal(await env.page.$('#pwa-manifest-hint a'), null);
    assert.match(await env.page.$eval('#pwa-manifest-hint', e => e.textContent), /relative — enter the page URL/);
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
