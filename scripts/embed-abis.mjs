// Regenerates public/abis.js from the JSON files in abi/.
// Run after adding or editing an ABI:  node scripts/embed-abis.mjs
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ABI_DIR = join(ROOT, 'abi');
const OUT = join(ROOT, 'public', 'abis.js');

// Display names for the picker; files not listed here fall back to their basename.
const NAMES = {
    'erc20.json': 'ERC-20 (permit, mint/burn/pause)',
    'erc721.json': 'ERC-721 (enumerable, mint/burn/pause)',
    'erc1155.json': 'ERC-1155',
    'weth9.json': 'WETH9',
    'safe.json': 'Gnosis Safe v1.3',
    'uniswap-v2-router.json': 'Uniswap V2 Router02',
    'multisig.json': 'MultiSig Wallet (Gnosis classic)',
};
// Picker order; unlisted files sort after these, alphabetically.
const ORDER = ['erc20.json', 'erc721.json', 'erc1155.json', 'weth9.json', 'safe.json', 'uniswap-v2-router.json', 'multisig.json'];

const files = (await readdir(ABI_DIR)).filter(f => f.endsWith('.json'))
    .sort((a, b) => {
        const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
        return (ia === -1 ? ORDER.length : ia) - (ib === -1 ? ORDER.length : ib) || a.localeCompare(b);
    });

const entries = [];
for (const f of files) {
    const abi = JSON.parse(await readFile(join(ABI_DIR, f), 'utf8'));
    entries.push({ key: f.replace(/\.json$/, ''), name: NAMES[f] || f.replace(/\.json$/, ''), abi });
}

const body = entries.map(e =>
    `  { key: ${JSON.stringify(e.key)}, name: ${JSON.stringify(e.name)},\n    abi: ${JSON.stringify(e.abi)} }`
).join(',\n');

await writeFile(OUT,
    '// GENERATED FILE — do not edit by hand.\n' +
    '// Source: abi/*.json · regenerate with: node scripts/embed-abis.mjs\n' +
    'window.WELLKNOWN_ABIS = [\n' + body + '\n];\n');

console.log(`wrote ${OUT} (${entries.length} ABIs: ${entries.map(e => e.key).join(', ')})`);
