# LocalUtil tests

Playwright-driven browser tests that run against the real files in `public/`
(each test file spins up a tiny static server for `public/` — what you test is
exactly what gets deployed, including `app.js`).

```bash
cd test
npm run setup   # npm install + downloads the Playwright chromium binary (once)
npm test        # runs all *.test.mjs with the built-in node:test runner
```

Run a single file with `node --test calldata.test.mjs`.

- `helpers.mjs` — static server + browser bootstrap; collects page errors so any
  uncaught JS error fails the suite.
- `mobile-layout.test.mjs` — every page must not overflow horizontally at 390px.
- The rest are per-tool functional tests.
