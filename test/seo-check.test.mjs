import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

async function checklistRows() {
    return env.page.$$eval('#seo-checklist .seo-check-row', rows =>
        rows.map(r => ({
            status: [...r.classList].find(c => ['ok', 'warn', 'fail', 'opt'].includes(c)),
            label: r.querySelector('.seo-check-label').textContent,
            note: r.querySelector('.seo-check-note').textContent,
        })));
}

const row = (rows, label) => rows.find(r => r.label === label);

test('bare-bones source: missing description and OG tags are flagged', async () => {
    await env.goto('seo-check.html');
    assert.equal(await env.page.$eval('#seo-results', e => e.style.display), 'none');

    await env.page.fill('#seo-src', '<html><head><title>Hello Page</title></head><body><h1>Hi</h1></body></html>');
    const rows = await checklistRows();
    assert.equal(row(rows, 'Title').status, 'ok');
    assert.equal(row(rows, 'Meta description').status, 'fail');
    assert.equal(row(rows, 'Canonical URL').status, 'warn');
    assert.equal(row(rows, 'Open Graph').status, 'warn');
    assert.equal(row(rows, 'H1 heading').status, 'ok');
    assert.equal(row(rows, 'Language').status, 'warn');

    // SERP preview uses the title and marks the missing description.
    assert.equal(await env.page.$eval('#serp-desktop .serp-title', e => e.textContent), 'Hello Page');
    assert.match(await env.page.$eval('#serp-desktop .serp-desc', e => e.textContent), /no meta description/);
});

test('relative og:image resolves against the page URL and becomes a link', async () => {
    await env.goto('seo-check.html');
    await env.page.fill('#seo-url', 'https://example.com/sub/page.html');
    await env.page.fill('#seo-src', `<html lang="en"><head>
        <title>T</title>
        <meta property="og:image" content="../img/og.png">
    </head></html>`);
    const href = await env.page.$eval('#og-card .og-card-image a', a => a.href);
    assert.equal(href, 'https://example.com/img/og.png');
});

test('known tags get plain-language explanations', async () => {
    await env.goto('seo-check.html');
    await env.page.fill('#seo-src', `<head><title>T</title>
        <meta name="twitter:card" content="summary_large_image">
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
    </head>`);
    const helps = await env.page.$$eval('#seo-tags .tag-help', els => els.map(e => e.textContent));
    assert.ok(helps.some(h => /large full-width image card/.test(h)), 'twitter:card value explained');
    assert.ok(helps.some(h => /home screen/.test(h)), 'apple-touch-icon purpose explained');
    // The icon row carries its declared size.
    const keys = await env.page.$$eval('#seo-tags .seo-table td.k', els => els.map(e => e.textContent));
    assert.ok(keys.includes('apple-touch-icon 180x180'));
});

test('items the page lacks still appear, and problems sort first', async () => {
    await env.goto('seo-check.html');
    await env.page.fill('#seo-src', '<html><head><title>Hello</title></head></html>');
    const rows = await checklistRows();

    // Optional extras are listed even when absent — this is a to-do list.
    assert.equal(row(rows, 'Web app manifest').status, 'opt');
    assert.equal(row(rows, 'Theme color').status, 'opt');
    assert.equal(row(rows, 'hreflang').status, 'opt');

    // Ordering: every fail before every warn, before opt, before ok.
    const rank = { fail: 0, warn: 1, opt: 2, ok: 3 };
    const order = rows.map(r => rank[r.status]);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));

    // Summary counts on top.
    assert.match(await env.page.$eval('#seo-check-summary', e => e.textContent),
        /\d+ broken · \d+ to fix · \d+ optional not set · \d+ OK/);
});

test('noindex robots is a hard failure', async () => {
    await env.goto('seo-check.html');
    await env.page.fill('#seo-src', '<head><title>T</title><meta name="robots" content="noindex, nofollow"></head>');
    const rows = await checklistRows();
    assert.equal(row(rows, 'Robots').status, 'fail');
    assert.match(row(rows, 'Robots').note, /NOT appear/);
});

test('invalid JSON-LD is flagged; valid blocks show their @type', async () => {
    await env.goto('seo-check.html');
    await env.page.fill('#seo-src', `<head><title>T</title>
        <script type="application/ld+json">{"@type":"WebSite","name":"x"}</script>
    </head>`);
    let rows = await checklistRows();
    assert.equal(row(rows, 'Structured data').status, 'ok');
    assert.match(await env.page.$eval('#seo-jsonld summary', e => e.textContent), /@type: WebSite/);

    await env.page.fill('#seo-src', `<head><title>T</title>
        <script type="application/ld+json">{oops}</script>
    </head>`);
    rows = await checklistRows();
    assert.equal(row(rows, 'Structured data').status, 'fail');
});

test('entering a URL enables view-source copy and the site-level file links', async () => {
    await env.goto('seo-check.html');
    assert.ok(await env.page.$eval('#seo-view-source', e => e.disabled));

    await env.page.fill('#seo-url', 'https://example.com/sub/a.html');
    assert.equal(await env.page.$eval('#seo-view-source', e => e.disabled), false);

    // Site-level card links robots.txt / sitemap.xml at the origin.
    await env.page.fill('#seo-src', '<head><title>T</title></head>');
    const hrefs = await env.page.$$eval('#seo-site-table a', as => as.map(a => a.href));
    assert.deepEqual(hrefs, ['https://example.com/robots.txt', 'https://example.com/sitemap.xml']);
});

test('"Check this page" audits the checker itself cleanly', async () => {
    await env.goto('seo-check.html');
    await env.page.click('#btn-seo-self');
    await env.page.waitForSelector('#seo-results[style*="flex"]');
    const rows = await checklistRows();
    for (const label of ['Title', 'Meta description', 'Canonical URL', 'Open Graph', 'Twitter card', 'Structured data']) {
        assert.equal(row(rows, label).status, 'ok', label + ': ' + row(rows, label).note);
    }
});

test('no page errors', () => {
    assert.deepEqual(env.errors, []);
});
