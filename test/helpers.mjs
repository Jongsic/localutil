// Shared test plumbing: a tiny static server for ../public plus a browser page.
// Tests always run against the real files that get deployed — no fixtures.
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
};

export async function listPages() {
    return (await readdir(PUBLIC_DIR)).filter(f => f.endsWith('.html'));
}

export async function startServer() {
    const server = http.createServer(async (req, res) => {
        try {
            const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
            const rel = normalize(pathname).replace(/^[/\\]+/, '') || 'index.html';
            const file = join(PUBLIC_DIR, rel);
            if (!file.startsWith(PUBLIC_DIR)) throw new Error('forbidden');
            const body = await readFile(file);
            res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
            res.end(body);
        } catch (e) {
            res.writeHead(404);
            res.end('not found');
        }
    });
    await new Promise(resolve => server.listen(0, resolve));
    return {
        base: `http://localhost:${server.address().port}`,
        close: () => new Promise(resolve => server.close(resolve)),
    };
}

// CDP virtual authenticator — lets headless Chromium complete real WebAuthn
// create()/get() ceremonies (used by passkey.test.mjs).
export async function attachVirtualAuthenticator(page, options = {}) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
            ...options,
        },
    });
    return {
        cdp,
        authenticatorId,
        remove: () => cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }),
    };
}

// One browser + server per test file; page errors always fail loudly.
export async function startEnv(contextOptions = {}) {
    const server = await startServer();
    const browser = await chromium.launch();
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    return {
        server, browser, page, errors,
        goto: (file) => page.goto(`${server.base}/${file}`, { waitUntil: 'networkidle' }),
        close: async () => { await browser.close(); await server.close(); },
    };
}
