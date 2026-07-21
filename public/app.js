/* ============================================================
   LocalUtil — app shell
   Renders sidebar, header, landing grid, theme, search, copy.
   Every page ships a minimal skeleton; this file fills the chrome.
   ============================================================ */

// --- Icon set (inner SVG markup, feather-style) ---
const ICONS = {
    base64: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    url: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    hex: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
    beautify: '<line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="10" x2="7" y2="10"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="7" y2="18"/>',
    minify: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
    jwt: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>',
    gpg: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="M11.4 11.6 22 1"/><path d="m17 6 3 3"/>',
    password: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    eth: '<path d="M12 2 5 12l7 4 7-4z"/><path d="m5 13.5 7 8.5 7-8.5"/>',
    wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
    qrgen: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><line x1="14" y1="14" x2="14" y2="14.01"/><line x1="21" y1="14" x2="21" y2="14.01"/><line x1="14" y1="21" x2="14" y2="21.01"/><line x1="21" y1="21" x2="21" y2="21.01"/><line x1="17.5" y1="17.5" x2="17.5" y2="17.51"/>',
    qrscan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/>',
    telegram: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    markdown: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 15V9l3 3 3-3v6"/><path d="M17 9v4"/><polyline points="15 11 17 13 19 11"/>',
    json: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/>',
    diff: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>',
    hash: '<rect x="14" y="14" width="4" height="6" rx="2"/><rect x="6" y="4" width="4" height="6" rx="2"/><path d="M6 20h4"/><path d="M14 10h4"/><path d="M6 14h2v6"/><path d="M14 4h2v6"/>',
    totp: '<rect x="5" y="2" width="14" height="20" rx="2.5"/><path d="M9 6h6"/><circle cx="12" cy="14" r="3.2"/><path d="M12 12.6V14l1 .8"/>',
    regex: '<path d="M17 3v10"/><path d="m12.67 5.5 8.66 5"/><path d="m12.67 10.5 8.66-5"/><circle cx="6.5" cy="16.5" r="2.5"/>',
    cron: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    tablecsv: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="12" y1="3" x2="12" y2="21"/>',
    ico: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    gif: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M9 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 2-1v-1.5H9.5"/><line x1="15" y1="9.5" x2="15" y2="14.5"/>',
    passport: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M6.5 21c.9-3 3-4.5 5.5-4.5s4.6 1.5 5.5 4.5"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 8.3-8.3"/><path d="m16 5 3 3"/><path d="m13 8 2 2"/>',
    keystore: '<path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M4 8V6a2 2 0 0 1 2-2h5l2 2"/><circle cx="12" cy="13" r="2"/><path d="M12 15v2.5"/>',
    passkey: '<path d="M12 11a4 4 0 1 0-4-4 4 4 0 0 0 4 4z"/><path d="M4 21c.9-3.5 4-6 8-6 1 0 2 .16 2.9.46"/><circle cx="17.5" cy="15.5" r="2"/><path d="M17.5 17.5V21l1.5-1"/>',
    resize: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
    svgimage: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m8.5 9.5-2.5 2.5 2.5 2.5"/><path d="m15.5 9.5 2.5 2.5-2.5 2.5"/><path d="m13 8-2 8"/>',
    seocheck: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><circle cx="11" cy="14" r="2.5"/><path d="m13 16 2.5 2.5"/>',
    pwacheck: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M12 8v5"/><polyline points="9.5 11 12 13.5 14.5 11"/><line x1="10.5" y1="18" x2="13.5" y2="18"/>',
    // chrome
    search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    sun: '<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.9" y1="4.9" x2="6.3" y2="6.3"/><line x1="17.7" y1="17.7" x2="19.1" y2="19.1"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.9" y1="19.1" x2="6.3" y2="17.7"/><line x1="17.7" y1="6.3" x2="19.1" y2="4.9"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
    github: '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    sidebar: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    spark: '<path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/>',
};

function svg(name, size) {
    const s = size || 24;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + s + '" height="' + s +
        '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
        (ICONS[name] || '') + '</svg>';
}

// --- Tool registry (single source of truth) ---
const CATEGORIES = ['Encoding', 'Text & Data', 'Crypto & Auth', 'Web3', 'QR Codes', 'Images', 'Utilities'];

const TOOLS = [
    { file: 'base64.html', name: 'Base64', desc: 'Encode & decode Base64 text', icon: 'base64', cat: 'Encoding' },
    { file: 'url-encode.html', name: 'URL Encode / Decode', desc: 'Percent-encode & decode URLs and components', icon: 'url', cat: 'Encoding' },
    { file: 'hex-ascii.html', name: 'Hex / ASCII', desc: 'Convert between hexadecimal and ASCII text', icon: 'hex', cat: 'Encoding' },
    { file: 'js-beautify.html', name: 'JS Beautifier', desc: 'Format and prettify JavaScript', icon: 'beautify', cat: 'Text & Data' },
    { file: 'js-minify.html', name: 'JS Minify', desc: 'Minify or beautify JavaScript code', icon: 'minify', cat: 'Text & Data' },
    { file: 'markdown-preview.html', name: 'Markdown Preview', desc: 'Paste Markdown and preview the formatted result', icon: 'markdown', cat: 'Text & Data' },
    { file: 'json.html', name: 'JSON Formatter', desc: 'Format, validate & explore JSON as a tree', icon: 'json', cat: 'Text & Data' },
    { file: 'csv-md.html', name: 'CSV ⇄ Markdown', desc: 'Convert between CSV and Markdown tables', icon: 'tablecsv', cat: 'Text & Data' },
    { file: 'diff.html', name: 'Diff / Compare', desc: 'Compare two texts side by side', icon: 'diff', cat: 'Text & Data' },
    { file: 'regex.html', name: 'Regex Tester', desc: 'Test regular expressions with live match highlighting', icon: 'regex', cat: 'Text & Data' },
    { file: 'jwt.html', name: 'JWT Decode', desc: 'Decode and inspect JSON Web Tokens', icon: 'jwt', cat: 'Crypto & Auth' },
    { file: 'gpg.html', name: 'GPG Key Inspector', desc: 'Inspect GPG / PGP key details', icon: 'gpg', cat: 'Crypto & Auth' },
    { file: 'ssh-key.html', name: 'SSH Key Converter', desc: 'Extract public keys and convert between PEM and PuTTY .ppk', icon: 'key', cat: 'Crypto & Auth' },
    { file: 'keystore.html', name: 'Keystore Inspector', desc: 'Read Android / Java keystore contents and signing SHA-1 / SHA-256 fingerprints', icon: 'keystore', cat: 'Crypto & Auth' },
    { file: 'password.html', name: 'Password Generator', desc: 'Create strong, random passwords', icon: 'password', cat: 'Crypto & Auth' },
    { file: 'hash.html', name: 'Hash & HMAC', desc: 'MD5, SHA & HMAC digests computed locally', icon: 'hash', cat: 'Crypto & Auth' },
    { file: 'totp.html', name: 'TOTP Generator', desc: 'Generate 2FA codes from a TOTP secret', icon: 'totp', cat: 'Crypto & Auth' },
    { file: 'passkey.html', name: 'Passkey Debugger', desc: 'Create, sign in with, and inspect WebAuthn passkeys against a simulated local server — every byte decoded and verified', icon: 'passkey', cat: 'Crypto & Auth' },
    { file: 'hd-wallet.html', name: 'Web3 Wallet', desc: 'Create a root key from a seed phrase or raw hex, inspect addresses, derive HD accounts', icon: 'wallet', cat: 'Web3' },
    { file: 'calldata.html', name: 'ABI / Calldata', desc: 'Encode calldata & event topics, decode calldata and logs — from a signature or ABI', icon: 'eth', cat: 'Web3' },
    { file: 'qr-generator.html', name: 'QR Generator', desc: 'Create QR codes with an optional logo', icon: 'qrgen', cat: 'QR Codes' },
    { file: 'qr-reader.html', name: 'QR Reader', desc: 'Read QR codes from an image', icon: 'qrscan', cat: 'QR Codes' },
    { file: 'ico.html', name: 'ICO Converter', desc: 'Build multi-resolution .ico files and inspect existing ones', icon: 'ico', cat: 'Images' },
    { file: 'gif.html', name: 'GIF Studio', desc: 'Create animated GIFs from images and inspect GIF frames', icon: 'gif', cat: 'Images' },
    { file: 'passport-photo.html', name: 'Passport Photo', desc: 'Fit a photo into a 3.5×4.5cm frame and export 413×531px @ 300dpi', icon: 'passport', cat: 'Images' },
    { file: 'image-resize.html', name: 'Image Resizer', desc: 'Place an image on a custom-sized canvas (cm/inch/px + dpi) and export it', icon: 'resize', cat: 'Images' },
    { file: 'svg-to-image.html', name: 'SVG to Image', desc: 'Rasterize SVG markup or files to PNG / JPEG — copy or download', icon: 'svgimage', cat: 'Images' },
    { file: 'epoch.html', name: 'Epoch Converter', desc: 'Convert Unix timestamps and dates', icon: 'clock', cat: 'Utilities' },
    { file: 'cron.html', name: 'Cron Parser', desc: 'Explain cron expressions and preview next runs', icon: 'cron', cat: 'Utilities' },
    { file: 'tg-bot.html', name: 'Telegram Bot Logger', desc: 'Log and inspect Telegram bot updates', icon: 'telegram', cat: 'Utilities' },
    { file: 'seo-check.html', name: 'SEO Checker', desc: 'Audit SEO meta tags from page HTML — checklist, search and social previews', icon: 'seocheck', cat: 'Utilities' },
    { file: 'pwa-check.html', name: 'PWA Checker', desc: 'Audit PWA install readiness from page HTML and manifest JSON — checklist, icons, install preview', icon: 'pwacheck', cat: 'Utilities' },
];

function currentFile() {
    const f = location.pathname.split('/').pop();
    return f && f.length ? f : 'index.html';
}

document.addEventListener('DOMContentLoaded', () => {
    renderSidebar();
    renderHeaderChrome();
    renderHeaderTitle();
    renderLanding();
    initTheme();
    initNavCollapse();
    initSearch();
    initCopyButtons();
});

// ------------------------------------------------------------
// Sidebar
// ------------------------------------------------------------
function renderSidebar() {
    const sidebar = document.getElementById('app-sidebar');
    if (!sidebar) return;
    const active = currentFile();

    let nav = '';
    CATEGORIES.forEach(cat => {
        const items = TOOLS.filter(t => t.cat === cat);
        if (!items.length) return;
        nav += '<div class="nav-group" data-group="' + cat + '">';
        nav += '<div class="nav-group-title">' + cat + '</div>';
        items.forEach(t => {
            const isActive = t.file === active ? ' active' : '';
            nav += '<a class="nav-item' + isActive + '" href="' + t.file + '" title="' + t.name +
                '" data-name="' + t.name.toLowerCase() +
                '">' + svg(t.icon, 18) + '<span>' + t.name + '</span></a>';
        });
        nav += '</div>';
    });

    sidebar.innerHTML =
        '<div class="sidebar-header">' +
        '  <div class="sidebar-brand-row">' +
        '    <a class="brand" href="index.html">' +
        '      <span class="brand-mark">' + svg('spark', 18) + '</span>' +
        '      <span class="brand-name">Local<span>Util</span></span>' +
        '    </a>' +
        '    <button class="btn-icon nav-collapse-toggle" id="nav-collapse-toggle" title="Collapse sidebar" aria-label="Collapse sidebar">' +
        svg('sidebar', 18) + '</button>' +
        '  </div>' +
        '  <div class="search-container">' + svg('search', 16) +
        '    <input type="search" id="tool-search" placeholder="Search tools  (' + (navigator.platform.includes('Mac') ? '⌘S' : 'Ctrl+S') + ')" autocomplete="off">' +
        '  </div>' +
        '</div>' +
        '<nav class="tool-list" id="tool-list">' + nav +
        '  <div class="nav-empty" id="nav-empty" style="display:none;">No tools match your search.</div>' +
        '</nav>' +
        '<div class="sidebar-footer">' +
        '  <a href="LICENSE.txt" target="_blank" rel="noopener">MIT License</a> · provided “as is”, no warranty' +
        '</div>';

    // Restore persisted collapsed state before paint to avoid a flash.
    if (localStorage.getItem('localutil-nav-collapsed') === '1') {
        sidebar.classList.add('collapsed');
    }
}

// ------------------------------------------------------------
// Sidebar collapse (icon-only rail) — persists across pages
// ------------------------------------------------------------
function setNavCollapsed(collapsed) {
    const sidebar = document.getElementById('app-sidebar');
    const btn = document.getElementById('nav-collapse-toggle');
    if (!sidebar) return;
    sidebar.classList.toggle('collapsed', collapsed);
    localStorage.setItem('localutil-nav-collapsed', collapsed ? '1' : '0');
    if (btn) {
        const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
        btn.title = label;
        btn.setAttribute('aria-label', label);
    }
}

function initNavCollapse() {
    const sidebar = document.getElementById('app-sidebar');
    const btn = document.getElementById('nav-collapse-toggle');
    if (!sidebar || !btn) return;
    // Sync button label with the state restored in renderSidebar().
    setNavCollapsed(sidebar.classList.contains('collapsed'));
    btn.addEventListener('click', () => {
        setNavCollapsed(!sidebar.classList.contains('collapsed'));
    });
}

// ------------------------------------------------------------
// Header chrome (menu button, theme toggle, backdrop)
// ------------------------------------------------------------
function renderHeaderChrome() {
    const topbar = document.getElementById('app-topbar');
    if (!topbar) return;

    // wrap existing title block with a menu button
    const titleBlock = topbar.querySelector('.topbar-title');
    const lead = document.createElement('div');
    lead.className = 'topbar-lead';

    const menuBtn = document.createElement('button');
    menuBtn.className = 'btn-icon menu-toggle';
    menuBtn.id = 'menu-toggle';
    menuBtn.setAttribute('aria-label', 'Open menu');
    menuBtn.innerHTML = svg('menu', 18);
    lead.appendChild(menuBtn);
    if (titleBlock) lead.appendChild(titleBlock);
    topbar.prepend(lead);

    const actions = document.createElement('div');
    actions.className = 'topbar-actions';

    const ghLink = document.createElement('a');
    ghLink.className = 'gh-link';
    ghLink.href = 'https://github.com/Jongsic/localutil';
    ghLink.target = '_blank';
    ghLink.rel = 'noopener';
    ghLink.title = 'Star or fork LocalUtil on GitHub';
    ghLink.innerHTML = svg('github', 16) + '<span>Star on GitHub</span>' + svg('star', 14);
    actions.appendChild(ghLink);

    const themeBtn = document.createElement('button');
    themeBtn.className = 'btn-icon';
    themeBtn.id = 'theme-toggle';
    themeBtn.title = 'Toggle dark / light mode';
    actions.appendChild(themeBtn);
    topbar.appendChild(actions);

    // backdrop for mobile drawer
    const backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    backdrop.id = 'sidebar-backdrop';
    document.body.appendChild(backdrop);

    const sidebar = document.getElementById('app-sidebar');
    const openMenu = () => { sidebar && sidebar.classList.add('open'); backdrop.classList.add('show'); };
    const closeMenu = () => { sidebar && sidebar.classList.remove('open'); backdrop.classList.remove('show'); };
    menuBtn.addEventListener('click', openMenu);
    backdrop.addEventListener('click', closeMenu);
}

// ------------------------------------------------------------
// Header title — document.title is left alone: each page ships a static,
// SEO-managed <title> (see scripts/gen-seo.mjs).
// ------------------------------------------------------------
function renderHeaderTitle() {
    const file = currentFile();
    const tool = TOOLS.find(t => t.file === file);
    const h1 = document.getElementById('current-tool-title');
    const desc = document.getElementById('current-tool-desc');

    if (file === 'index.html' || !tool) {
        if (h1 && !h1.textContent) h1.textContent = 'LocalUtil';
        if (desc && !desc.textContent) desc.textContent = 'A clean set of developer utilities';
        return;
    }
    if (h1) h1.textContent = tool.name;
    if (desc) desc.textContent = tool.desc;
}

// ------------------------------------------------------------
// Landing grid (index.html)
// ------------------------------------------------------------
function renderLanding() {
    const mount = document.getElementById('landing');
    if (!mount) return;

    let html = '<div class="landing-hero">' +
        '<h2>Developer utilities, one clean workspace</h2>' +
        '<p>' + TOOLS.length + ' fast, private tools — everything runs locally in your browser and your data is never sent to a server.</p>' +
        '</div>';

    CATEGORIES.forEach(cat => {
        const items = TOOLS.filter(t => t.cat === cat);
        if (!items.length) return;
        html += '<div class="landing-group-title">' + cat + '</div>';
        html += '<div class="tool-grid">';
        items.forEach(t => {
            html += '<a class="tool-card" href="' + t.file + '">' +
                '<span class="tool-card-icon">' + svg(t.icon, 21) + '</span>' +
                '<span class="tool-card-body">' +
                '<span class="tool-card-name">' + t.name + '</span>' +
                '<span class="tool-card-desc">' + t.desc + '</span>' +
                '</span></a>';
        });
        html += '</div>';
    });

    html += '<footer class="landing-footer">' +
        'LocalUtil is open source under the <a href="LICENSE.txt" target="_blank" rel="noopener">MIT License</a>. ' +
        'It is provided “as is”, without warranty of any kind — the authors accept no liability for any damages ' +
        'arising from its use. Verify results independently before relying on them, especially for keys and wallets.' +
        '</footer>';

    mount.innerHTML = html;
}

// ------------------------------------------------------------
// Theme
// ------------------------------------------------------------
function initTheme() {
    const toggleBtn = document.getElementById('theme-toggle');

    let theme = localStorage.getItem('localutil-theme');
    if (!theme) {
        theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    apply(theme);

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme');
            apply(current === 'dark' ? 'light' : 'dark');
        });
    }

    function apply(t) {
        document.documentElement.setAttribute('data-theme', t);
        localStorage.setItem('localutil-theme', t);
        if (toggleBtn) toggleBtn.innerHTML = svg(t === 'dark' ? 'sun' : 'moon', 18);
    }
}

// ------------------------------------------------------------
// Search (filters nav; hides empty groups)
// ------------------------------------------------------------
function initSearch() {
    const searchInput = document.getElementById('tool-search');

    document.addEventListener('keydown', (e) => {
        // Cmd/Ctrl+S — deliberately not Cmd+F, which must stay the browser's find-in-page.
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            // Search is hidden while collapsed — expand so it's usable.
            const sidebar = document.getElementById('app-sidebar');
            if (sidebar && sidebar.classList.contains('collapsed')) setNavCollapsed(false);
            if (searchInput) searchInput.focus();
        }
        if (e.key === 'Escape' && document.activeElement === searchInput) {
            searchInput.value = '';
            filter('');
            searchInput.blur();
        }
    });

    if (!searchInput) return;
    searchInput.addEventListener('input', (e) => filter(e.target.value.toLowerCase().trim()));

    function filter(val) {
        let anyVisible = false;
        document.querySelectorAll('.nav-group').forEach(group => {
            let groupVisible = false;
            group.querySelectorAll('.nav-item').forEach(item => {
                const match = !val || item.getAttribute('data-name').includes(val);
                item.style.display = match ? '' : 'none';
                if (match) groupVisible = true;
            });
            group.style.display = groupVisible ? '' : 'none';
            if (groupVisible) anyVisible = true;
        });
        const empty = document.getElementById('nav-empty');
        if (empty) empty.style.display = anyVisible ? 'none' : 'block';
    }
}

// ------------------------------------------------------------
// Copy buttons + toast
// ------------------------------------------------------------
function initCopyButtons() {
    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = document.querySelector(btn.getAttribute('data-clipboard-target'));
            if (!target || !target.value) return;
            navigator.clipboard.writeText(target.value)
                .then(() => showToast('Copied to clipboard'))
                .catch(() => showToast('Copy failed', true));
        });
    });
}

function showToast(msg, isError) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.style.backgroundColor = isError ? 'var(--danger)' : '';
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 1900);
}

// expose for page scripts that want the shared toast
window.showToast = showToast;
