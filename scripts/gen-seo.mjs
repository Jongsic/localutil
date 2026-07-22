// Injects SEO metadata into public/*.html and regenerates sitemap.xml / robots.txt.
// Idempotent — run after adding, renaming, or editing a tool page:  node scripts/gen-seo.mjs
//
// Per page:
//   - <title>, meta description, og:title, og:description — from the SEO map below
//   - <link rel="canonical">          — the page's live URL
//   - JSON-LD (schema.org)            — WebApplication per tool, WebSite on index
// Plus: prefills the static <h1>/<p> title placeholders so crawlers that skip
// JavaScript still see the tool name and description (app.js overwrites them
// with the same registry values at runtime).
//
// SEO copy style: titles are plain keyword phrases anyone can recognize at a
// glance ("SVG to PNG / JPEG Converter"), descriptions state exactly what the
// tool does in the first sentence, then the runs-locally note.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUB = join(ROOT, 'public');
const BASE = 'https://jongsic.github.io/localutil/';
const REPO = 'https://github.com/Jongsic/localutil';

const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = s => escapeHtml(s).replace(/"/g, '&quot;');

// --- Per-page SEO copy (title is used without the "— LocalUtil" suffix as the JSON-LD name) ---
const LOCAL = 'Runs 100% in your browser — nothing is uploaded.';
const SEO = {
    'index.html': {
        title: 'LocalUtil — Free Online Developer Tools, 100% Local & Private',
        desc: 'Free online developer tools — Base64, JWT decoder, JSON formatter, epoch converter, QR codes, hashes, and more. Everything runs locally in your browser; your data never leaves your machine.',
    },
    'base64.html': {
        title: 'Base64 Encode / Decode Online',
        desc: `Encode text to Base64 and decode Base64 back to text. ${LOCAL}`,
    },
    'url-encode.html': {
        title: 'URL Encode / Decode Online',
        desc: `Percent-encode and decode URLs, query strings, and cookies, with a full URL breakdown. ${LOCAL}`,
    },
    'hex-ascii.html': {
        title: 'Hex to ASCII / ASCII to Hex Converter',
        desc: `Convert hexadecimal to ASCII text and ASCII text to hex bytes. ${LOCAL}`,
    },
    'js-minify.html': {
        title: 'JavaScript Beautifier & Minifier (Terser)',
        desc: `Beautify minified or messy JavaScript into readable code, minify it with Terser, and validate JSON with exact error locations. ${LOCAL}`,
    },
    'markdown-preview.html': {
        title: 'Markdown Preview Online',
        desc: `Paste Markdown and see the rendered result instantly. ${LOCAL}`,
    },
    'json.html': {
        title: 'JSON Formatter & Validator',
        desc: `Format, validate, and explore JSON in a collapsible tree view. ${LOCAL}`,
    },
    'csv-md.html': {
        title: 'CSV to Markdown Table Converter',
        desc: `Convert CSV to a Markdown table, and Markdown tables back to CSV. ${LOCAL}`,
    },
    'diff.html': {
        title: 'Text Diff / Compare Tool',
        desc: `Compare two texts side by side and highlight the differences. ${LOCAL}`,
    },
    'regex.html': {
        title: 'Regex Tester (JavaScript)',
        desc: `Test JavaScript regular expressions with live match highlighting and capture groups. ${LOCAL}`,
    },
    'jwt.html': {
        title: 'JWT Decoder',
        desc: 'Decode a JWT (JSON Web Token) and inspect its header, payload, and signature. Runs 100% in your browser — tokens never leave your machine.',
    },
    'gpg.html': {
        title: 'GPG / PGP Key Inspector',
        desc: 'Inspect a GPG / PGP key: key ID, fingerprint, algorithm, subkeys, and expiry. Runs 100% in your browser — keys never leave your machine.',
    },
    'ssh-key.html': {
        title: 'SSH Key Converter (PEM / PuTTY PPK)',
        desc: 'Extract the public key from an SSH private key and convert between OpenSSH / PEM and PuTTY .ppk formats. Runs 100% in your browser — keys never leave your machine.',
    },
    'keystore.html': {
        title: 'Java / Android Keystore Inspector',
        desc: 'Read a Java or Android keystore (.jks / .keystore): aliases, certificates, and SHA-1 / SHA-256 signing fingerprints. Runs 100% in your browser — keystores never leave your machine.',
    },
    'password.html': {
        title: 'Password Generator',
        desc: `Generate strong random passwords with custom length and character sets. ${LOCAL}`,
    },
    'hash.html': {
        title: 'MD5 / SHA-256 Hash & HMAC Generator',
        desc: `Compute MD5, SHA-1, SHA-256, SHA-512 digests and HMAC signatures from text. ${LOCAL}`,
    },
    'totp.html': {
        title: 'TOTP Code Generator (2FA)',
        desc: 'Generate time-based one-time passwords (TOTP) from a 2FA secret key. Runs 100% in your browser — secrets never leave your machine.',
    },
    'passkey.html': {
        title: 'Passkey / WebAuthn Debugger & Tester',
        desc: 'Create and test WebAuthn passkeys against a simulated local server: decode authenticatorData, CBOR and COSE keys, and verify signatures step by step. Runs 100% in your browser — credentials never leave your machine.',
    },
    'hd-wallet.html': {
        title: 'HD Wallet Deriver (BIP-39 Seed Phrase)',
        desc: 'Derive HD wallet accounts from a BIP-39 seed phrase or raw hex root key: addresses, public and private keys. Runs 100% in your browser — keys never leave your machine.',
    },
    'calldata.html': {
        title: 'Ethereum ABI Encoder / Calldata Decoder',
        desc: `Encode Ethereum calldata and event topics, or decode calldata and logs — from a function signature or ABI. ${LOCAL}`,
    },
    'qr-generator.html': {
        title: 'QR Code Generator',
        desc: `Create QR codes from text or URLs, with an optional center logo. ${LOCAL}`,
    },
    'qr-reader.html': {
        title: 'QR Code Reader from Image',
        desc: 'Read and decode a QR code from an image file or screenshot. Runs 100% in your browser — images are never uploaded.',
    },
    'ico.html': {
        title: 'ICO Converter (PNG to ICO)',
        desc: 'Convert PNG images into a multi-resolution Windows .ico favicon file, or inspect an existing .ico. Runs 100% in your browser — images are never uploaded.',
    },
    'gif.html': {
        title: 'GIF Maker / Frame Inspector',
        desc: 'Create an animated GIF from images, and inspect the frames of an existing GIF. Runs 100% in your browser — images are never uploaded.',
    },
    'passport-photo.html': {
        title: 'Passport Photo Maker (3.5 x 4.5 cm)',
        desc: 'Fit a photo into a 3.5 x 4.5 cm passport frame and export 413 x 531 px at 300 DPI. Runs 100% in your browser — photos are never uploaded.',
    },
    'image-resize.html': {
        title: 'Image Resizer (cm / inch / px + DPI)',
        desc: 'Place an image on a custom-size canvas in cm, inches, or pixels at a chosen DPI, and export it. Runs 100% in your browser — images are never uploaded.',
    },
    'svg-to-image.html': {
        title: 'SVG to PNG / JPEG Converter',
        desc: `Convert SVG markup or .svg files to PNG or JPEG — copy the result or download it. ${LOCAL}`,
    },
    'epoch.html': {
        title: 'Epoch / Unix Timestamp Converter',
        desc: `Convert Unix timestamps (seconds or milliseconds) to human-readable dates, and dates back to timestamps. ${LOCAL}`,
    },
    'cron.html': {
        title: 'Cron Expression Parser',
        desc: `Explain a cron expression in plain English and preview its next run times. ${LOCAL}`,
    },
    'seo-check.html': {
        title: 'SEO Meta Tag Checker',
        desc: 'Audit title, description, canonical, robots, Open Graph, and JSON-LD from a page URL or pasted HTML — with search and social previews. Runs in your browser.',
    },
    'tg-bot.html': {
        title: 'Telegram Bot Update Logger',
        desc: 'Poll a Telegram bot\'s getUpdates from your browser and inspect incoming updates as JSON. Your bot token is only ever sent to api.telegram.org.',
    },
};

// --- Tool registry, parsed from app.js (single source of truth) ---
const appJs = await readFile(join(PUB, 'app.js'), 'utf8');
const tools = new Map();
for (const m of appJs.matchAll(/\{ file: '([^']+)', name: '([^']+)', desc: '([^']+)'/g)) {
    tools.set(m[1], { name: m[2], desc: m[3] });
}
if (!tools.size) throw new Error('could not parse TOOLS from public/app.js');

function gitLastMod(file) {
    try {
        const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', join('public', file)],
            { cwd: ROOT, encoding: 'utf8' }).trim();
        if (out) return out;
    } catch { /* fall through */ }
    return new Date().toISOString().slice(0, 10);
}

const sitemapEntries = [];
const files = (await readdir(PUB)).filter(f => f.endsWith('.html')).sort();

for (const file of files) {
    let html = await readFile(join(PUB, file), 'utf8');

    // Redirect stubs (meta refresh) stay out of the sitemap and get no metadata.
    if (html.includes('http-equiv="refresh"')) continue;

    const isIndex = file === 'index.html';
    const url = isIndex ? BASE : BASE + file;
    const tool = tools.get(file);

    // --- title / description / OG copy from the SEO map ---
    const seo = SEO[file];
    if (!seo) console.warn(`! no SEO entry for ${file} — add one to scripts/gen-seo.mjs`);
    const fullTitle = seo ? (isIndex ? seo.title : `${seo.title} — LocalUtil`) : null;
    if (seo) {
        html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(fullTitle)}</title>`);
        html = html.replace(/(<meta name="description" content=")[^"]*(">)/, `$1${escapeAttr(seo.desc)}$2`);
        html = html.replace(/(<meta property="og:title" content=")[^"]*(">)/, `$1${escapeAttr(fullTitle)}$2`);
        html = html.replace(/(<meta property="og:description" content=")[^"]*(">)/, `$1${escapeAttr(seo.desc)}$2`);
    }
    const description = seo ? seo.desc
        : html.match(/<meta name="description" content="([^"]*)">/)?.[1].replace(/&amp;/g, '&') ?? '';

    // --- canonical: drop any existing one, re-insert after the description meta ---
    html = html.replace(/^\s*<link rel="canonical"[^>]*>\n/m, '');
    html = html.replace(/^(\s*)(<meta name="description"[^>]*>\n)/m,
        `$1$2$1<link rel="canonical" href="${url}">\n`);

    // --- JSON-LD: drop any existing block, re-insert before <!-- /social --> ---
    const ld = isIndex
        ? {
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'LocalUtil',
            url: BASE,
            description,
            sameAs: [REPO],
        }
        : {
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: seo ? seo.title : tool ? tool.name : file,
            url,
            description,
            applicationCategory: 'DeveloperApplication',
            operatingSystem: 'Any',
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
            isPartOf: { '@type': 'WebSite', name: 'LocalUtil', url: BASE },
        };
    html = html.replace(/^\s*<script type="application\/ld\+json">[\s\S]*?<\/script>\n/m, '');
    html = html.replace(/^(\s*)(<!-- \/social -->)/m,
        `$1<script type="application/ld+json">${JSON.stringify(ld)}</script>\n$1$2`);

    // --- static <h1>/<p> prefill so the heading survives without JavaScript ---
    const h1 = tool ? tool.name : (isIndex ? 'LocalUtil' : null);
    const desc = tool ? tool.desc : (isIndex ? 'A clean set of developer utilities' : null);
    if (h1) {
        html = html.replace(/(<h1 id="current-tool-title">)[^<]*(<\/h1>)/, `$1${escapeHtml(h1)}$2`);
        html = html.replace(/(<p id="current-tool-desc" class="topbar-desc">)[^<]*(<\/p>)/, `$1${escapeHtml(desc)}$2`);
    }

    await writeFile(join(PUB, file), html);
    sitemapEntries.push({ url, lastmod: gitLastMod(file), priority: isIndex ? '1.0' : '0.8' });
}

// --- sitemap.xml ---
const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    sitemapEntries.map(e =>
        `  <url>\n    <loc>${e.url}</loc>\n    <lastmod>${e.lastmod}</lastmod>\n    <priority>${e.priority}</priority>\n  </url>`
    ).join('\n') + '\n</urlset>\n';
await writeFile(join(PUB, 'sitemap.xml'), sitemap);

// --- robots.txt ---
await writeFile(join(PUB, 'robots.txt'),
    `User-agent: *\nAllow: /\n\nSitemap: ${BASE}sitemap.xml\n`);

console.log(`updated ${sitemapEntries.length} pages, sitemap.xml, robots.txt`);
