// Extract translatable UI strings from every page, exactly as the i18n
// runtime in app.js will see them: rendered text nodes (whitespace-normalized)
// plus placeholder / title / aria-label attributes. Skips the same subtrees
// the runtime skips (script/style/textarea/pre/code/[data-i18n-skip]).
//
// Usage:  node scripts/gen-i18n.mjs [out.json]
// Runs with the test harness dependencies: cd test && npm run setup first.
import { writeFile } from 'node:fs/promises';
import { startEnv, listPages } from '../test/helpers.mjs';

const OUT = process.argv[2] || 'i18n-strings.json';

const env = await startEnv();
const result = {};

for (const file of (await listPages()).sort()) {
    await env.page.goto(`${env.server.base}/${file}`, { waitUntil: 'networkidle' });
    const strings = await env.page.evaluate(() => {
        const SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, PRE: 1, CODE: 1 };
        const skipped = el => {
            for (let e = el; e; e = e.parentElement) {
                if (SKIP[e.tagName] || e.hasAttribute('data-i18n-skip')) return true;
            }
            return false;
        };
        const norm = s => s.replace(/\s+/g, ' ').trim();
        const out = new Set();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (n.parentElement && skipped(n.parentElement)) continue;
            const key = norm(n.nodeValue || '');
            if (key) out.add(key);
        }
        document.querySelectorAll('[placeholder], [title], [aria-label]').forEach(el => {
            if (skipped(el)) return;
            ['placeholder', 'title', 'aria-label'].forEach(a => {
                const v = el.getAttribute(a);
                if (v && norm(v)) out.add(norm(v));
            });
        });
        return [...out];
    });
    result[file] = strings;
    console.error(`${file}: ${strings.length} strings`);
}

await env.close();

// Strings appearing on 3+ pages are shared chrome / common UI — bucket them
// once so translators handle them a single time, consistently.
const counts = new Map();
for (const list of Object.values(result)) {
    for (const s of list) counts.set(s, (counts.get(s) || 0) + 1);
}
const shared = [...counts.entries()].filter(([, c]) => c >= 3).map(([s]) => s).sort();
const sharedSet = new Set(shared);
const perPage = {};
for (const [file, list] of Object.entries(result)) {
    const own = list.filter(s => !sharedSet.has(s));
    if (own.length) perPage[file] = own;
}

const total = counts.size;
console.error(`\n${total} unique strings (${shared.length} shared, rest page-specific)`);
await writeFile(OUT, JSON.stringify({ _shared: shared, ...perPage }, null, 2));
console.error(`wrote ${OUT}`);
