// Shared PDF logic for the PDF tools (pdf-imposition, pdf-recolor, pdf-upscale). Classic script: needs vendor/pdf-lib.min.js loaded first and
// exposes window.PdfCore. Everything works on pdf-lib PDFDocument objects and
// leaves text and vector content untouched — only the operators and image
// streams a tool is asked to change are rewritten.
(function () {
    'use strict';
    const { PDFDocument, PDFName, PDFRawStream, PDFDict, PDFArray, PDFNumber, PDFRef,
        degrees, decodePDFRawStream } = PDFLib;

    const N = s => PDFName.of(s);
    const PT_PER_MM = 72 / 25.4;
    const PAPERS = { a4: [595.28, 841.89], letter: [612, 792], a3: [841.89, 1190.55], a5: [419.53, 595.28] };

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------
    function num(o) { return o instanceof PDFNumber ? o.asNumber() : undefined; }
    function lookup(dict, key) { return dict ? dict.lookup(N(key)) : undefined; }
    function toHex(rgb) {
        return '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
    }
    function parseHex(s) {
        const h = String(s).trim().replace(/^#/, '');
        if (!/^[0-9a-f]{6}$/i.test(h)) return null;
        return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    }
    function colorDist(a, b) {
        const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
        return Math.sqrt(dr * dr + dg * dg + db * db);
    }

    async function deflate(bytes) {
        const cs = new CompressionStream('deflate');
        const out = new Blob([bytes]).stream().pipeThrough(cs);
        return new Uint8Array(await new Response(out).arrayBuffer());
    }

    // "1-3, 7, 10-" → 0-based indices within [0, count)
    function parseRange(spec, count) {
        const s = String(spec || '').trim();
        if (!s) return [...Array(count).keys()];
        const out = [];
        for (const part of s.split(',')) {
            const p = part.trim();
            if (!p) continue;
            const m = p.match(/^(\d*)\s*-\s*(\d*)$/);
            let a, b;
            if (m) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : count; }
            else if (/^\d+$/.test(p)) { a = b = +p; }
            else throw new Error('Bad page range: ' + p);
            for (let i = Math.max(1, a); i <= Math.min(count, b); i++) out.push(i - 1);
        }
        return out;
    }

    // ------------------------------------------------------------------
    // Content-stream scanning: find fill-color operators without touching
    // anything else. A minimal tokenizer that knows enough to skip strings,
    // hex strings, comments, arrays, dicts and inline images.
    // ------------------------------------------------------------------
    const FILL_OPS = { rg: 3, sc: 3, scn: 3, k: 4, g: 1 };
    const STROKE_OPS = { RG: 3, SC: 3, SCN: 3, K: 4, G: 1 };
    const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
    const isWs = c => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;

    // Calls onOp(op, operands) for every operator; operands are {v, start, end}
    // for numbers, {name} for names, null for anything else.
    function scanOps(bytes, onOp) {
        const n = bytes.length;
        let i = 0;
        let operands = []; // {v, start, end} or null (non-number operand)
        let depth = 0;     // inside [ ] or << >>
        while (i < n) {
            const c = bytes[i];
            if (isWs(c)) { i++; continue; }
            if (c === 0x25) { while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++; continue; } // %
            if (c === 0x28) { // ( string )
                let lvl = 1; i++;
                while (i < n && lvl > 0) {
                    const d = bytes[i];
                    if (d === 0x5c) { i += 2; continue; }
                    if (d === 0x28) lvl++;
                    else if (d === 0x29) lvl--;
                    i++;
                }
                operands.push(null); continue;
            }
            if (c === 0x3c) {
                if (bytes[i + 1] === 0x3c) { depth++; i += 2; operands.push(null); continue; }
                while (i < n && bytes[i] !== 0x3e) i++;
                i++; operands.push(null); continue;
            }
            if (c === 0x3e && bytes[i + 1] === 0x3e) { depth = Math.max(0, depth - 1); i += 2; continue; }
            if (c === 0x5b) { depth++; i++; operands.push(null); continue; }
            if (c === 0x5d) { depth = Math.max(0, depth - 1); i++; continue; }
            if (c === 0x2f) { // /Name
                const s0 = ++i;
                while (i < n && !isWs(bytes[i]) && !DELIM.has(bytes[i])) i++;
                let name = '';
                for (let j = s0; j < i; j++) name += String.fromCharCode(bytes[j]);
                operands.push(depth === 0 ? { name } : null); continue;
            }
            // regular token: number or operator
            const start = i;
            while (i < n && !isWs(bytes[i]) && !DELIM.has(bytes[i])) i++;
            if (i === start) { i++; continue; }
            let tok = '';
            for (let j = start; j < i; j++) tok += String.fromCharCode(bytes[j]);
            if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
                if (depth === 0) operands.push({ v: parseFloat(tok), start, end: i });
                continue;
            }
            if (depth > 0) continue;
            if (tok === 'BI') { // inline image: skip to EI
                const id = indexOfToken(bytes, 'ID', i);
                if (id < 0) return;
                let k = id + 3;
                while (k < n) {
                    if (bytes[k] === 0x45 && bytes[k + 1] === 0x49 && isWs(bytes[k - 1]) &&
                        (k + 2 >= n || isWs(bytes[k + 2]))) break;
                    k++;
                }
                i = k + 2; operands = []; continue;
            }
            onOp(tok, operands);
            operands = [];
        }
    }

    // Calls onColor({op, values, start, end}) for every color operator whose
    // operands are plain numbers; start/end span the operands.
    function scanColorOps(bytes, onColor, withStroke) {
        scanOps(bytes, (tok, operands) => {
            const want = FILL_OPS[tok] || (withStroke ? STROKE_OPS[tok] : 0);
            if (!want || operands.length < want) return;
            const ops = operands.slice(-want);
            if (ops.every(o => o && o.v !== undefined)) {
                onColor({ op: tok, values: ops.map(o => o.v), start: ops[0].start, end: ops[want - 1].end });
            }
        });
    }
    function indexOfToken(bytes, tok, from) {
        const a = tok.charCodeAt(0), b = tok.charCodeAt(1);
        for (let k = from; k < bytes.length - 1; k++) {
            if (bytes[k] === a && bytes[k + 1] === b && isWs(bytes[k - 1]) && (k + 2 >= bytes.length || isWs(bytes[k + 2]))) return k;
        }
        return -1;
    }

    // Color operator → RGB 0..255. sc/scn with 3 operands are assumed RGB.
    function opRgb(op, v) {
        const o = op.toLowerCase();
        if (o === 'rg' || o === 'sc' || o === 'scn') return v.map(x => x * 255);
        if (o === 'g') return [v[0] * 255, v[0] * 255, v[0] * 255];
        if (o === 'k') { const [c, m, y, k] = v; return [c, m, y].map(x => 255 * (1 - x) * (1 - k)); }
        return null;
    }
    function rgbOperands(op, rgb) {
        const f = x => (Math.round(x / 255 * 10000) / 10000).toString();
        const o = op.toLowerCase();
        if (o === 'g') return f((rgb[0] + rgb[1] + rgb[2]) / 3);
        if (o === 'k') {
            const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
            const k = 1 - Math.max(r, g, b);
            if (k >= 1) return '0 0 0 1';
            return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k]
                .map(x => (Math.round(x * 10000) / 10000).toString()).join(' ');
        }
        return rgb.map(f).join(' ');
    }

    // Every content stream: page contents (with page index) and form XObjects.
    function contentStreams(doc) {
        const out = [];
        doc.getPages().forEach((page, pageIndex) => {
            const c = page.node.get(N('Contents'));
            const refs = c instanceof PDFArray ? c.asArray() : [c];
            for (const ref of refs) if (ref instanceof PDFRef) out.push({ ref, pageIndex });
        });
        for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
            if (obj instanceof PDFRawStream && lookup(obj.dict, 'Subtype') === N('Form')) out.push({ ref, pageIndex: -1 });
        }
        return out;
    }
    function streamBytes(obj) {
        if (!(obj instanceof PDFRawStream)) return null;
        try { return decodePDFRawStream(obj).decode(); } catch (e) { return null; }
    }

    function scanFillColors(doc, withStroke) {
        const counts = new Map();
        for (const { ref } of contentStreams(doc)) {
            const bytes = streamBytes(doc.context.lookup(ref));
            if (!bytes) continue;
            scanColorOps(bytes, ({ op, values }) => {
                const rgb = opRgb(op, values);
                if (!rgb) return;
                const hex = toHex(rgb);
                counts.set(hex, (counts.get(hex) || 0) + 1);
            }, withStroke);
        }
        return [...counts].map(([hex, count]) => ({ hex, rgb: parseHex(hex), count })).sort((a, b) => b.count - a.count);
    }

    // Rewrite matching color operators to `to`. Returns {count, pages:Set}.
    async function recolorVectors(doc, targets, tol, to, withStroke) {
        let count = 0;
        const pages = new Set();
        for (const { ref, pageIndex } of contentStreams(doc)) {
            const obj = doc.context.lookup(ref);
            const bytes = streamBytes(obj);
            if (!bytes) continue;
            const edits = [];
            scanColorOps(bytes, ({ op, values, start, end }) => {
                const rgb = opRgb(op, values);
                if (rgb && targets.some(t => colorDist(t, rgb) < tol)) edits.push({ start, end, text: rgbOperands(op, to) });
            }, withStroke);
            if (!edits.length) continue;
            const parts = [];
            let pos = 0;
            for (const e of edits) {
                parts.push(bytes.subarray(pos, e.start), new TextEncoder().encode(e.text));
                pos = e.end;
            }
            parts.push(bytes.subarray(pos));
            const merged = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
            let o = 0;
            for (const p of parts) { merged.set(p, o); o += p.length; }
            const dict = obj.dict;
            dict.set(N('Filter'), N('FlateDecode'));
            dict.delete(N('DecodeParms'));
            const z = await deflate(merged);
            dict.set(N('Length'), PDFNumber.of(z.length));
            doc.context.assign(ref, PDFRawStream.of(dict, z));
            count += edits.length;
            if (pageIndex >= 0) pages.add(pageIndex);
        }
        return { count, pages };
    }

    // ------------------------------------------------------------------
    // Images
    // ------------------------------------------------------------------
    function filters(dict) {
        const f = lookup(dict, 'Filter');
        if (!f) return [];
        if (f instanceof PDFName) return [f.asString().slice(1)];
        if (f instanceof PDFArray) return f.asArray().map(x => doc_name(x));
        return [];
    }
    function doc_name(x) { return x instanceof PDFName ? x.asString().slice(1) : ''; }

    // Image XObjects with the pages that use them (through forms too).
    function listImages(doc) {
        const images = new Map(); // ref.tag → info
        const visit = (resources, pageIndex, seen) => {
            const xobjs = resources instanceof PDFDict ? resources.lookup(N('XObject')) : null;
            if (!(xobjs instanceof PDFDict)) return;
            for (const [, ref] of xobjs.entries()) {
                if (!(ref instanceof PDFRef) || seen.has(ref.tag)) continue;
                seen.add(ref.tag);
                const obj = doc.context.lookup(ref);
                if (!(obj instanceof PDFRawStream)) continue;
                const sub = lookup(obj.dict, 'Subtype');
                if (sub === N('Image')) {
                    if (!images.has(ref.tag)) images.set(ref.tag, describeImage(doc, ref, obj));
                    images.get(ref.tag).pages.add(pageIndex);
                } else if (sub === N('Form')) {
                    visit(obj.dict.lookup(N('Resources')), pageIndex, seen);
                }
            }
        };
        doc.getPages().forEach((page, i) => visit(page.node.Resources(), i, new Set()));
        return [...images.values()];
    }
    function describeImage(doc, ref, obj) {
        const d = obj.dict;
        let cs = lookup(d, 'ColorSpace');
        let comps = 0, csName = '';
        if (cs instanceof PDFName) {
            csName = cs.asString().slice(1);
            comps = { DeviceRGB: 3, DeviceGray: 1, DeviceCMYK: 4, CalRGB: 3, CalGray: 1 }[csName] || 0;
        } else if (cs instanceof PDFArray) {
            csName = doc_name(cs.get(0));
            if (csName === 'ICCBased') comps = num(lookup(cs.lookup(1), 'N')) || 0;
            else if (csName === 'CalRGB') comps = 3;
            else if (csName === 'CalGray') comps = 1;
        }
        const f = filters(d);
        return {
            ref, width: num(lookup(d, 'Width')), height: num(lookup(d, 'Height')),
            bpc: num(lookup(d, 'BitsPerComponent')), comps, colorSpace: csName, filters: f,
            imageMask: lookup(d, 'ImageMask') && String(lookup(d, 'ImageMask')) === 'true',
            pages: new Set(),
            supported: false,
        };
    }
    function canDecode(info) {
        if (info.imageMask || info.bpc !== 8) return false;
        if (info.comps !== 3 && info.comps !== 1) return false;
        const f = info.filters;
        if (f.includes('JPXDecode') || f.includes('JBIG2Decode') || f.includes('CCITTFaxDecode')) return false;
        if (f.includes('DCTDecode') && f[f.length - 1] !== 'DCTDecode') return false;
        return true;
    }

    function undoPredictor(data, parms, comps, width) {
        const pred = num(lookup(parms, 'Predictor')) || 1;
        if (pred < 10) return data; // TIFF predictor 2 is rare in practice
        const colors = num(lookup(parms, 'Colors')) || comps;
        const cols = num(lookup(parms, 'Columns')) || width;
        const bpp = colors, row = cols * colors;
        const rows = Math.floor(data.length / (row + 1));
        const out = new Uint8Array(rows * row);
        for (let y = 0; y < rows; y++) {
            const t = data[y * (row + 1)];
            const src = y * (row + 1) + 1, dst = y * row, up = dst - row;
            for (let x = 0; x < row; x++) {
                const raw = data[src + x];
                const a = x >= bpp ? out[dst + x - bpp] : 0;
                const b = y > 0 ? out[up + x] : 0;
                const c = x >= bpp && y > 0 ? out[up + x - bpp] : 0;
                let v;
                switch (t) {
                    case 1: v = raw + a; break;
                    case 2: v = raw + b; break;
                    case 3: v = raw + ((a + b) >> 1); break;
                    case 4: { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                        v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
                    default: v = raw;
                }
                out[dst + x] = v & 255;
            }
        }
        return out;
    }

    function makeCanvas(w, h) {
        if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        return c;
    }

    // Decode an image to {w, h, data: Uint8ClampedArray RGBA}. Null if unsupported.
    async function decodeImage(doc, info) {
        if (!canDecode(info)) return null;
        const obj = doc.context.lookup(info.ref);
        const { width: w, height: h, comps } = info;
        if (info.filters[info.filters.length - 1] === 'DCTDecode') {
            let bytes = obj.contents;
            if (info.filters.length > 1) {
                // strip the outer filters, leaving the JPEG
                const d = obj.dict.clone(doc.context);
                d.set(N('Filter'), N(info.filters[0]));
                bytes = decodePDFRawStream(PDFRawStream.of(d, obj.contents)).decode();
            }
            const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
            const cv = makeCanvas(bmp.width, bmp.height);
            const ctx = cv.getContext('2d');
            ctx.drawImage(bmp, 0, 0);
            bmp.close && bmp.close();
            const id = ctx.getImageData(0, 0, cv.width, cv.height);
            return { w: cv.width, h: cv.height, data: id.data };
        }
        let raw = info.filters.length ? decodePDFRawStream(obj).decode() : obj.contents;
        const parms = lookup(obj.dict, 'DecodeParms');
        if (parms instanceof PDFDict) raw = undoPredictor(raw, parms, comps, w);
        if (raw.length < w * h * comps) return null;
        const data = new Uint8ClampedArray(w * h * 4);
        for (let p = 0, q = 0; p < w * h; p++, q += comps) {
            data[p * 4] = raw[q];
            data[p * 4 + 1] = comps === 3 ? raw[q + 1] : raw[q];
            data[p * 4 + 2] = comps === 3 ? raw[q + 2] : raw[q];
            data[p * 4 + 3] = 255;
        }
        return { w, h, data };
    }

    // Replace the image stream with an RGB JPEG of `img`. Keeps SMask etc.
    async function writeImage(doc, info, img, quality) {
        const cv = makeCanvas(img.w, img.h);
        cv.getContext('2d').putImageData(new ImageData(img.data, img.w, img.h), 0, 0);
        const blob = cv.convertToBlob
            ? await cv.convertToBlob({ type: 'image/jpeg', quality: quality || 0.9 })
            : await new Promise(r => cv.toBlob(r, 'image/jpeg', quality || 0.9));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const obj = doc.context.lookup(info.ref);
        const d = obj.dict;
        d.set(N('Width'), PDFNumber.of(img.w));
        d.set(N('Height'), PDFNumber.of(img.h));
        d.set(N('ColorSpace'), N('DeviceRGB'));
        d.set(N('BitsPerComponent'), PDFNumber.of(8));
        d.set(N('Filter'), N('DCTDecode'));
        d.delete(N('DecodeParms'));
        d.delete(N('Decode'));
        d.set(N('Length'), PDFNumber.of(bytes.length));
        doc.context.assign(info.ref, PDFRawStream.of(d, bytes));
        info.width = img.w; info.height = img.h; info.comps = 3; info.colorSpace = 'DeviceRGB'; info.filters = ['DCTDecode'];
    }

    // Replace the image stream with ready JPEG bytes (w × h, RGB).
    function writeJpeg(doc, info, bytes, w, h) {
        const obj = doc.context.lookup(info.ref);
        const d = obj.dict;
        d.set(N('Width'), PDFNumber.of(w));
        d.set(N('Height'), PDFNumber.of(h));
        d.set(N('ColorSpace'), N('DeviceRGB'));
        d.set(N('BitsPerComponent'), PDFNumber.of(8));
        d.set(N('Filter'), N('DCTDecode'));
        d.delete(N('DecodeParms'));
        d.delete(N('Decode'));
        d.set(N('Length'), PDFNumber.of(bytes.length));
        doc.context.assign(info.ref, PDFRawStream.of(d, bytes));
    }

    async function encodeJpeg(img, quality) {
        const cv = makeCanvas(img.w, img.h);
        cv.getContext('2d').putImageData(new ImageData(img.data, img.w, img.h), 0, 0);
        const blob = cv.convertToBlob
            ? await cv.convertToBlob({ type: 'image/jpeg', quality: quality || 0.9 })
            : await new Promise(r => cv.toBlob(r, 'image/jpeg', quality || 0.9));
        return blob;
    }

    // How much of a page each fill color paints with rectangles (re … f).
    // → [{hex, rgb, share (largest share of one page), pages, uses}]
    function fillAreas(doc) {
        const stats = new Map();
        doc.getPages().forEach((page, pi) => {
            const box = pageBox(page);
            const pageArea = (box.right - box.left) * (box.top - box.bottom) || 1;
            const perPage = new Map();
            let ctm = IDENTITY.slice(), saved = [], color = null, area = 0, pb = null;
            // area of the current path: rectangles exactly, curves by their bounding box
            const addPt = (u, v) => {
                const x = ctm[0] * u + ctm[2] * v + ctm[4], y = ctm[1] * u + ctm[3] * v + ctm[5];
                if (!pb) pb = [x, y, x, y];
                else { pb[0] = Math.min(pb[0], x); pb[1] = Math.min(pb[1], y); pb[2] = Math.max(pb[2], x); pb[3] = Math.max(pb[3], y); }
            };
            const clipArea = b => {
                const x0 = Math.max(box.left, b[0]), x1 = Math.min(box.right, b[2]);
                const y0 = Math.max(box.bottom, b[1]), y1 = Math.min(box.top, b[3]);
                return x1 > x0 && y1 > y0 ? (x1 - x0) * (y1 - y0) : 0;
            };
            const flushPath = () => { if (pb) area += clipArea(pb); pb = null; };
            const bytes = pageContentBytes(doc, page);
            scanOps(bytes, (op, a) => {
                const nums = a.filter(x => x && x.v !== undefined).map(x => x.v);
                if (op === 'q') saved.push([ctm, color]);
                else if (op === 'Q') { const s0 = saved.pop(); if (s0) { ctm = s0[0]; color = s0[1]; } }
                else if (op === 'cm' && nums.length >= 6) ctm = mulM(nums.slice(-6), ctm);
                else if (FILL_OPS[op] && nums.length >= FILL_OPS[op] && a.length === FILL_OPS[op]) color = toHex(opRgb(op, nums.slice(-FILL_OPS[op])));
                else if (op === 'cs' || ((op === 'sc' || op === 'scn') && nums.length !== 3)) color = null;
                else if (op === 're' && nums.length >= 4) {
                    flushPath();
                    const [x, y, w, h] = nums.slice(-4);
                    addPt(x, y); addPt(x + w, y + h); addPt(x, y + h); addPt(x + w, y);
                    flushPath();
                } else if (op === 'm') { flushPath(); if (nums.length >= 2) addPt(nums[nums.length - 2], nums[nums.length - 1]); }
                else if (op === 'l' || op === 'c' || op === 'v' || op === 'y') {
                    for (let k = 0; k + 1 < nums.length; k += 2) addPt(nums[k], nums[k + 1]);
                } else if (/^(f\*?|F|B\*?|b\*?)$/.test(op)) {
                    flushPath();
                    if (color && area) perPage.set(color, (perPage.get(color) || 0) + area);
                    area = 0;
                } else if (op === 'n' || op === 'S' || op === 's' || op === 'W' || op === 'W*') {
                    if (op === 'n' || op === 'S' || op === 's') { pb = null; area = 0; }
                }
            });
            for (const [hex, a] of perPage) {
                const e = stats.get(hex) || { hex, rgb: parseHex(hex), share: 0, pages: 0 };
                e.share = Math.max(e.share, Math.min(1, a / pageArea));
                e.pages++;
                stats.set(hex, e);
            }
        });
        const uses = new Map(scanFillColors(doc).map(c => [c.hex, c.count]));
        for (const [hex, n] of uses) if (!stats.has(hex)) stats.set(hex, { hex, rgb: parseHex(hex), share: 0, pages: 0 });
        return [...stats.values()].map(e => Object.assign(e, { uses: uses.get(e.hex) || 0 }))
            .sort((a, b) => b.share - a.share || b.uses - a.uses);
    }

    // Dominant border color of an image, if one color covers > 30% of the border.
    function borderColor(img) {
        const { w, h, data } = img;
        const counts = new Map();
        let total = 0;
        const add = (x, y) => {
            const i = (y * w + x) * 4;
            const key = [data[i], data[i + 1], data[i + 2]].map(v => (v >> 3 << 3) + 4).join(',');
            counts.set(key, (counts.get(key) || 0) + 1);
            total++;
        };
        for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
        for (let y = 0; y < h; y++) { add(0, y); add(w - 1, y); }
        let best = null, bestN = 0;
        for (const [k, v] of counts) if (v > bestN) { best = k; bestN = v; }
        return best && bestN > total * 0.3 ? best.split(',').map(Number) : null;
    }

    // Box blur (mean filter) with clamped edges — scipy uniform_filter stand-in.
    function boxBlur(src, w, h, size) {
        const r = size >> 1;
        const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let s = 0;
                for (let k = -r; k <= r; k++) s += src[y * w + Math.min(w - 1, Math.max(0, x + k))];
                tmp[y * w + x] = s / size;
            }
        }
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let s = 0;
                for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
                out[y * w + x] = s / size;
            }
        }
        return out;
    }

    // Repaint the background of an image: pixels near `targets` that are
    // connected to the image edge (or form large patches) become `to`; a 2px
    // halo is pulled toward `to` in proportion to how much target color it
    // holds, so no colored fringe is left around objects. Returns true if changed.
    // Distance of every pixel to the nearest target color (+ which target).
    function targetDistances(data, n, targets) {
        const d = new Float32Array(n), near = new Uint8Array(n);
        for (let p = 0; p < n; p++) {
            const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
            let best = Infinity, bi = 0;
            for (let i = 0; i < targets.length; i++) {
                const t = targets[i], dr = r - t[0], dg = g - t[1], db = b - t[2];
                const v = dr * dr + dg * dg + db * db;
                if (v < best) { best = v; bi = i; }
            }
            d[p] = Math.sqrt(best); near[p] = bi;
        }
        return { d, near };
    }

    // Paint the background mask with `to`; pull a 2px halo toward `to` in
    // proportion to how much target color it holds (no colored fringe).
    function paintMask(img, bg, d, near, targets, tol, to) {
        const { w, h, data } = img;
        const n = w * h;
        let grown = bg.slice();
        for (let it = 0; it < 2; it++) {
            const g2 = grown.slice();
            for (let p = 0; p < n; p++) {
                if (grown[p]) continue;
                const x = p % w, y = (p / w) | 0;
                if ((x > 0 && grown[p - 1]) || (x < w - 1 && grown[p + 1]) || (y > 0 && grown[p - w]) || (y < h - 1 && grown[p + w])) g2[p] = 1;
            }
            grown = g2;
        }
        const reach = tol * 2.75;
        let any = false;
        for (let p = 0; p < n; p++) {
            if (bg[p]) {
                data[p * 4] = to[0]; data[p * 4 + 1] = to[1]; data[p * 4 + 2] = to[2];
                any = true;
            } else if (grown[p]) {
                const wgt = Math.max(0, Math.min(1, 1 - d[p] / reach));
                if (!wgt) continue;
                const t = targets[near[p]];
                for (let c = 0; c < 3; c++) data[p * 4 + c] = data[p * 4 + c] + (to[c] - t[c]) * wgt;
            }
        }
        return any;
    }

    // Region growing from seed pixels: a neighbor joins when it continues
    // smoothly from the pixel it is reached from (localTol) and stays within
    // wideTol of the targets. Printed parts are outlined, so growth stops at
    // their edges instead of leaking into similar colors.
    function growMask(data, w, h, d, mask, wideTol, localTol) {
        const n = w * h, stack = new Int32Array(n);
        let sp = 0;
        for (let p = 0; p < n; p++) if (mask[p]) stack[sp++] = p;
        const lt2 = localTol * localTol;
        const step = (q, r) => {
            if (mask[r] || d[r] >= wideTol) return;
            const a = q * 4, b = r * 4;
            const dr = data[a] - data[b], dg = data[a + 1] - data[b + 1], db = data[a + 2] - data[b + 2];
            if (dr * dr + dg * dg + db * db >= lt2) return;
            mask[r] = 1; stack[sp++] = r;
        };
        while (sp) {
            const q = stack[--sp];
            const x = q % w, y = (q / w) | 0;
            if (x > 0) step(q, q - 1);
            if (x < w - 1) step(q, q + 1);
            if (y > 0) step(q, q - w);
            if (y < h - 1) step(q, q + w);
        }
        return mask;
    }

    // Per-picture method (used when a picture's place on the page is unknown).
    function recolorImage(img, targets, tol, to, opts) {
        const { w, h, data } = img;
        const n = w * h;
        const { d, near } = targetDistances(data, n, targets);
        // connected components (4-neighborhood) of the near-target mask
        const label = new Int32Array(n).fill(0);
        const sizes = [0], touches = [false];
        const stack = new Int32Array(n);
        let next = 1;
        for (let p = 0; p < n; p++) {
            if (label[p] || d[p] >= tol) continue;
            let sp = 0, size = 0, edge = false;
            stack[sp++] = p; label[p] = next;
            while (sp) {
                const q = stack[--sp];
                size++;
                const x = q % w, y = (q / w) | 0;
                if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
                if (x > 0 && !label[q - 1] && d[q - 1] < tol) { label[q - 1] = next; stack[sp++] = q - 1; }
                if (x < w - 1 && !label[q + 1] && d[q + 1] < tol) { label[q + 1] = next; stack[sp++] = q + 1; }
                if (y > 0 && !label[q - w] && d[q - w] < tol) { label[q - w] = next; stack[sp++] = q - w; }
                if (y < h - 1 && !label[q + w] && d[q + w] < tol) { label[q + w] = next; stack[sp++] = q + w; }
            }
            sizes.push(size); touches.push(edge);
            next++;
        }
        if (next === 1) return false;
        // Background = areas touching the picture edge, plus any area covering
        // ≥ 10% of the picture (scans often have a white margin around the
        // background). Smaller enclosed areas (background seen through a gap)
        // only when asked: a part can have the background color too.
        const interior = !opts || opts.interior !== false;
        const big = Math.max(50, 0.01 * n), huge = 0.1 * n;
        const keep = sizes.map((s, i) => i > 0 && (touches[i] || s >= huge || (interior && s > big)));
        if (!keep.some(Boolean)) return false;
        const bg = new Uint8Array(n);
        for (let p = 0; p < n; p++) if (label[p] && keep[label[p]]) bg[p] = 1;
        const o = Object.assign({ grow: true, localTol: 12, wideTol: tol * 2 }, opts);
        if (o.grow) growMask(data, w, h, d, bg, o.wideTol, o.localTol);
        return paintMask(img, bg, d, near, targets, tol, to);
    }

    // ------------------------------------------------------------------
    // Content-stream geometry (used to measure fill areas)
    // ------------------------------------------------------------------
    const IDENTITY = [1, 0, 0, 1, 0, 0];
    function mulM(m, n) {
        return [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
            m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
    }
    function pageContentBytes(doc, page) {
        const c = page.node.get(N('Contents'));
        const parts = (c instanceof PDFArray ? c.asArray() : [c]).map(r => streamBytes(doc.context.lookup(r))).filter(Boolean);
        const out = new Uint8Array(parts.reduce((s, p) => s + p.length + 1, 0));
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 0x0a; }
        return out;
    }

    // ------------------------------------------------------------------
    // Upscale safety check: where the upscaled image, scaled back down, no
    // longer matches the original (e.g. a model "denoised" away a dense stud
    // pattern), blend in a plain smooth upscale instead.
    // ------------------------------------------------------------------
    function mismatchBlend(orig, big, fallback, scale, lo, hi) {
        // Sharpening alone moves edges by ~20–25; a model that wipes out a
        // pattern scores ~40. Only the latter should be replaced.
        lo = lo || 28; hi = hi || 36;
        const { w, h } = orig;
        const W = big.w, H = big.h;
        const err = new Float32Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let s0 = 0, s1 = 0, s2 = 0, cnt = 0;
                for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
                    const X = x * scale + dx, Y = y * scale + dy;
                    if (X >= W || Y >= H) continue;
                    const i = (Y * W + X) * 4;
                    s0 += big.data[i]; s1 += big.data[i + 1]; s2 += big.data[i + 2]; cnt++;
                }
                const j = (y * w + x) * 4;
                err[y * w + x] = (Math.abs(s0 / cnt - orig.data[j]) + Math.abs(s1 / cnt - orig.data[j + 1]) + Math.abs(s2 / cnt - orig.data[j + 2])) / 3;
            }
        }
        const e = boxBlur(err, w, h, 7);
        let m = new Float32Array(w * h), any = false;
        for (let p = 0; p < w * h; p++) { m[p] = Math.max(0, Math.min(1, (e[p] - lo) / (hi - lo))); if (m[p] > 0) any = true; }
        if (!any) return false;
        m = boxBlur(m, w, h, 5);
        for (let Y = 0; Y < H; Y++) {
            const fy = Math.min(h - 1, Math.max(0, (Y + 0.5) / scale - 0.5));
            const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
            for (let X = 0; X < W; X++) {
                const fx = Math.min(w - 1, Math.max(0, (X + 0.5) / scale - 0.5));
                const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
                const a = m[y0 * w + x0] * (1 - tx) + m[y0 * w + x1] * tx;
                const b = m[y1 * w + x0] * (1 - tx) + m[y1 * w + x1] * tx;
                const k = a * (1 - ty) + b * ty;
                if (k <= 0) continue;
                const i = (Y * W + X) * 4;
                for (let c = 0; c < 3; c++) big.data[i + c] = big.data[i + c] * (1 - k) + fallback.data[i + c] * k;
            }
        }
        return true;
    }

    function smoothUpscale(img, scale) {
        const src = makeCanvas(img.w, img.h);
        src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.w, img.h), 0, 0);
        const dst = makeCanvas(img.w * scale, img.h * scale);
        const ctx = dst.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, 0, 0, dst.width, dst.height);
        return { w: dst.width, h: dst.height, data: ctx.getImageData(0, 0, dst.width, dst.height).data };
    }

    // Snap near-white to white (upscalers leave faint gray specks on paper white).
    function cleanWhite(img, threshold) {
        const t = threshold || 248, d = img.data;
        for (let i = 0; i < d.length; i += 4) if (d[i] >= t && d[i + 1] >= t && d[i + 2] >= t) { d[i] = d[i + 1] = d[i + 2] = 255; }
    }

    // ------------------------------------------------------------------
    // Upscaler (onnxruntime-web). Needs vendor/ort/ort.webgpu.min.js loaded.
    // ------------------------------------------------------------------
    const MODEL_CACHE = 'localutil-models-v1';

    async function fetchModel(url, onProgress) {
        let cache = null;
        try { cache = await caches.open(MODEL_CACHE); } catch (e) { /* no Cache API */ }
        if (cache) {
            const hit = await cache.match(url);
            if (hit) { const b = new Uint8Array(await hit.arrayBuffer()); onProgress && onProgress(b.length, b.length, true); return b; }
        }
        const res = await fetch(url);
        if (!res.ok) throw new Error('Model download failed: HTTP ' + res.status);
        const total = +res.headers.get('content-length') || 0;
        const reader = res.body.getReader();
        const chunks = [];
        let got = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value); got += value.length;
            onProgress && onProgress(got, total, false);
        }
        const bytes = new Uint8Array(got);
        let o = 0;
        for (const c of chunks) { bytes.set(c, o); o += c.length; }
        if (cache) { try { await cache.put(url, new Response(bytes)); } catch (e) { /* quota */ } }
        return bytes;
    }

    async function isModelCached(url) {
        try { const c = await caches.open(MODEL_CACHE); return !!(await c.match(url)); } catch (e) { return false; }
    }
    async function clearModelCache() {
        try { await caches.delete(MODEL_CACHE); } catch (e) { /* ignore */ }
    }

    async function createUpscaler(modelBytes, opts) {
        const o = opts || {};
        const ort = window.ort;
        if (!ort) throw new Error('onnxruntime-web is not loaded');
        // must be absolute: ORT import()s the loader from here
        ort.env.wasm.wasmPaths = new URL(o.wasmPaths || 'vendor/ort/', location.href).href;
        ort.env.wasm.numThreads = 1; // no cross-origin isolation on static hosting
        const wantGpu = o.backend !== 'wasm' && typeof navigator !== 'undefined' && navigator.gpu;
        let session = null, backend = 'wasm';
        if (wantGpu) {
            try { session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['webgpu'] }); backend = 'webgpu'; }
            catch (e) { session = null; }
        }
        if (!session) session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] });
        const inName = session.inputNames[0], outName = session.outputNames[0];
        const tile = o.tile || 192, pad = 12;

        async function runTile(img, x0, y0, tw, th) {
            const plane = tw * th, input = new Float32Array(3 * plane);
            for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
                const i = ((y0 + y) * img.w + (x0 + x)) * 4, p = y * tw + x;
                input[p] = img.data[i] / 255; input[plane + p] = img.data[i + 1] / 255; input[2 * plane + p] = img.data[i + 2] / 255;
            }
            const res = await session.run({ [inName]: new ort.Tensor('float32', input, [1, 3, th, tw]) });
            const t = res[outName];
            const [, , oh, ow] = t.dims;
            return { data: t.data, ow, oh };
        }

        async function upscale(img, onTile) {
            // probe the scale on a tiny tile
            let scale = o.scale;
            const W0 = img.w, H0 = img.h;
            const tilesX = Math.ceil(W0 / tile), tilesY = Math.ceil(H0 / tile);
            let out = null, done = 0;
            for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) {
                const cx0 = tx * tile, cy0 = ty * tile;
                const cw = Math.min(tile, W0 - cx0), ch = Math.min(tile, H0 - cy0);
                const x0 = Math.max(0, cx0 - pad), y0 = Math.max(0, cy0 - pad);
                const x1 = Math.min(W0, cx0 + cw + pad), y1 = Math.min(H0, cy0 + ch + pad);
                const r = await runTile(img, x0, y0, x1 - x0, y1 - y0);
                if (!scale) scale = Math.round(r.ow / (x1 - x0));
                if (!out) out = { w: W0 * scale, h: H0 * scale, data: new Uint8ClampedArray(W0 * scale * H0 * scale * 4) };
                const plane = r.ow * r.oh;
                for (let y = 0; y < ch * scale; y++) {
                    const sy = (cy0 - y0) * scale + y;
                    for (let x = 0; x < cw * scale; x++) {
                        const sx = (cx0 - x0) * scale + x;
                        const s = sy * r.ow + sx;
                        const d = ((cy0 * scale + y) * out.w + (cx0 * scale + x)) * 4;
                        out.data[d] = r.data[s] * 255;
                        out.data[d + 1] = r.data[plane + s] * 255;
                        out.data[d + 2] = r.data[2 * plane + s] * 255;
                        out.data[d + 3] = 255;
                    }
                }
                done++;
                onTile && onTile(done, tilesX * tilesY);
            }
            return { img: out, scale };
        }

        return { upscale, backend, release: () => session.release && session.release() };
    }

    // ------------------------------------------------------------------
    // Imposition (2 pages per sheet side)
    // ------------------------------------------------------------------
    // Visible page area: the CropBox clipped to the MediaBox (PDF 32000 §14.11.2).
    // Some print-ready files carry a CropBox larger than the page.
    function pageBox(page) {
        const m = page.getMediaBox(), c = page.getCropBox();
        const left = Math.max(m.x, c.x), bottom = Math.max(m.y, c.y);
        const right = Math.min(m.x + m.width, c.x + c.width), top = Math.min(m.y + m.height, c.y + c.height);
        if (right - left < 1 || top - bottom < 1) return { left: m.x, bottom: m.y, right: m.x + m.width, top: m.y + m.height };
        return { left, bottom, right, top };
    }

    // Crop helpers. Returns a box in page coordinates.
    function cropBox(page, crop) {
        const full = pageBox(page);
        if (!crop || crop.mode === 'none') return full;
        if (crop.mode === 'trim') {
            const t = page.node.lookup(N('TrimBox'));
            if (t instanceof PDFArray) {
                const v = t.asArray().map(num);
                return { left: Math.min(v[0], v[2]), bottom: Math.min(v[1], v[3]), right: Math.max(v[0], v[2]), top: Math.max(v[1], v[3]) };
            }
            return full;
        }
        if (crop.mode === 'size') { // center-crop to w × h points
            const cx = (full.left + full.right) / 2, cy = (full.bottom + full.top) / 2;
            const w = Math.min(crop.width, full.right - full.left), h = Math.min(crop.height, full.top - full.bottom);
            return { left: cx - w / 2, right: cx + w / 2, bottom: cy - h / 2, top: cy + h / 2 };
        }
        if (crop.mode === 'margins') { // mm from each edge
            const m = k => (crop[k] || 0) * PT_PER_MM;
            return { left: full.left + m('left'), right: full.right - m('right'), bottom: full.bottom + m('bottom'), top: full.top - m('top') };
        }
        return full;
    }

    // Layout plan — pure geometry so it can be unit-tested and previewed.
    // items: [{w, h}] page sizes (after crop and /Rotate), in order.
    // opts: {mode: 'booklet'|'cut'|'nup', binding: 'side'|'top', duplex: 'long'|'short',
    //        paper, marginMm, gutterMm, keepBackCover}
    // Returns {sheetW, sheetH, sides: [{cells: [{rect, item (index|null), rot}], marks}], blanks}
    function planImposition(items, opts) {
        const o = Object.assign({ mode: 'booklet', binding: 'side', duplex: 'long', paper: 'a4', marginMm: 5, gutterMm: 2, keepBackCover: true }, opts);
        const [pw, ph] = PAPERS[o.paper] || PAPERS.a4;
        const first = items[0] || { w: pw, h: ph };

        // stacked = two cells one above the other on a portrait sheet
        let stacked;
        if (o.mode === 'booklet') stacked = o.binding === 'top';
        else {
            const fit = (cw, chh) => Math.min(cw / first.w, chh / first.h);
            stacked = fit(pw, ph / 2) >= fit(ph / 2, pw);
        }
        const W = stacked ? pw : ph, H = stacked ? ph : pw;
        const m = o.marginMm * PT_PER_MM, g = o.gutterMm * PT_PER_MM;
        // rects in PDF coords (origin bottom-left). a = top / left, b = bottom / right.
        const A = stacked ? { x: m, y: H / 2 + g, w: W - 2 * m, h: H / 2 - g - m } : { x: m, y: m, w: W / 2 - g - m, h: H - 2 * m };
        const B = stacked ? { x: m, y: m, w: W - 2 * m, h: H / 2 - g - m } : { x: W / 2 + g, y: m, w: W / 2 - g - m, h: H - 2 * m };

        let seq = items.map((_, i) => i);
        let blanks = 0;
        if (o.mode === 'booklet' || o.mode === 'cut') {
            blanks = (4 - seq.length % 4) % 4;
            const pads = Array(blanks).fill(null);
            seq = o.mode === 'booklet' && o.keepBackCover && seq.length > 1
                ? seq.slice(0, -1).concat(pads, seq.slice(-1)) : seq.concat(pads);
        } else if (seq.length % 2) { seq.push(null); blanks = 1; }

        const readingAxis = o.binding === 'top' ? 'h' : 'v';
        const longAxis = W >= H ? 'h' : 'v'; // direction of the sheet's long edge
        const duplexAxis = o.duplex === 'short' ? (longAxis === 'h' ? 'v' : 'h') : longAxis;
        const rotateBack = duplexAxis !== readingAxis;
        const mirror = r => readingAxis === 'v' ? { x: W - r.x - r.w, y: r.y, w: r.w, h: r.h } : { x: r.x, y: H - r.y - r.h, w: r.w, h: r.h };
        const turn = r => ({ x: W - r.x - r.w, y: H - r.y - r.h, w: r.w, h: r.h });

        const sides = [];
        const pushSheet = (front, backPairs, marks) => {
            sides.push({ cells: front, marks, back: false });
            if (!backPairs) return;
            const back = backPairs.map(c => {
                let rect = mirror(c.rect), rot = 0;
                if (rotateBack) { rect = turn(rect); rot = 180; }
                return { rect, item: c.item, rot };
            });
            sides.push({ cells: back, marks: null, back: true });
        };
        const marks = stacked ? 'h' : 'v';

        if (o.mode === 'booklet') {
            const total = seq.length;
            for (let i = 0; i < total / 4; i++) {
                const lo = 2 * i, hi = total - 1 - 2 * i;
                // the half that folds behind (a) shows the back-cover side
                const flipA = o.binding === 'top' ? 180 : 0;
                const front = [{ rect: A, item: seq[hi], rot: flipA }, { rect: B, item: seq[lo], rot: 0 }];
                pushSheet(front, [{ rect: A, item: seq[hi - 1] }, { rect: B, item: seq[lo + 1] }], i === 0 ? marks : null);
            }
        } else if (o.mode === 'cut') {
            for (let i = 0; i < seq.length; i += 4) {
                const front = [{ rect: A, item: seq[i], rot: 0 }, { rect: B, item: seq[i + 2], rot: 0 }];
                pushSheet(front, [{ rect: A, item: seq[i + 1] }, { rect: B, item: seq[i + 3] }], marks);
            }
        } else {
            for (let i = 0; i < seq.length; i += 2) {
                pushSheet([{ rect: A, item: seq[i], rot: 0 }, { rect: B, item: seq[i + 1], rot: 0 }], null, null);
            }
        }
        return { sheetW: W, sheetH: H, stacked, sides, blanks, rotateBack, margin: m };
    }

    // sources: [{doc, indices, crop}] → new PDFDocument
    async function impose(sources, opts) {
        const out = await PDFDocument.create();
        const pages = [];
        for (const s of sources) {
            const docPages = s.doc.getPages();
            for (const idx of s.indices) {
                const page = docPages[idx];
                const box = cropBox(page, s.crop);
                const rot = ((page.getRotation().angle % 360) + 360) % 360;
                pages.push({ page, box, rot });
            }
        }
        if (!pages.length) throw new Error('No pages selected');
        const items = pages.map(p => {
            const w = p.box.right - p.box.left, h = p.box.top - p.box.bottom;
            return p.rot === 90 || p.rot === 270 ? { w: h, h: w } : { w, h };
        });
        const plan = planImposition(items, opts);
        // opts.maxSides: only the first sheet sides (quick preview)
        const sides = opts && opts.maxSides ? plan.sides.slice(0, opts.maxSides) : plan.sides;
        const needed = new Set();
        for (const side of sides) for (const c of side.cells) if (c.item != null) needed.add(c.item);
        // embedPages only takes pages of one document per call
        const embedded = new Array(pages.length);
        for (const s of sources) {
            const idx = pages.map((p, i) => i).filter(i => needed.has(i) && pages[i].page.doc === s.doc);
            if (!idx.length) continue;
            const emb = await out.embedPages(idx.map(i => pages[i].page), idx.map(i => pages[i].box));
            idx.forEach((i, k) => { embedded[i] = emb[k]; });
        }
        for (const side of sides) {
            const sheet = out.addPage([plan.sheetW, plan.sheetH]);
            for (const cell of side.cells) {
                if (cell.item == null) continue;
                const it = items[cell.item], src = pages[cell.item];
                const s = Math.min(cell.rect.w / it.w, cell.rect.h / it.h);
                const bw = it.w * s, bh = it.h * s;
                const x = cell.rect.x + (cell.rect.w - bw) / 2, y = cell.rect.y + (cell.rect.h - bh) / 2;
                // PDF /Rotate is clockwise; pdf-lib rotates counter-clockwise
                const ccw = ((cell.rot - src.rot) % 360 + 360) % 360;
                const anchor = { 0: [x, y], 90: [x + bw, y], 180: [x + bw, y + bh], 270: [x, y + bh] }[ccw];
                sheet.drawPage(embedded[cell.item], { x: anchor[0], y: anchor[1], xScale: s, yScale: s, rotate: degrees(ccw) });
            }
            if (side.marks) {
                const color = PDFLib.rgb(0.6, 0.6, 0.6), L = Math.max(4, plan.margin - 4);
                if (side.marks === 'h') {
                    sheet.drawLine({ start: { x: 0, y: plan.sheetH / 2 }, end: { x: L, y: plan.sheetH / 2 }, thickness: 0.5, color });
                    sheet.drawLine({ start: { x: plan.sheetW - L, y: plan.sheetH / 2 }, end: { x: plan.sheetW, y: plan.sheetH / 2 }, thickness: 0.5, color });
                } else {
                    sheet.drawLine({ start: { x: plan.sheetW / 2, y: 0 }, end: { x: plan.sheetW / 2, y: L }, thickness: 0.5, color });
                    sheet.drawLine({ start: { x: plan.sheetW / 2, y: plan.sheetH - L }, end: { x: plan.sheetW / 2, y: plan.sheetH }, thickness: 0.5, color });
                }
            }
        }
        return { doc: out, plan };
    }

    // ------------------------------------------------------------------
    // Misc
    // ------------------------------------------------------------------
    async function loadPdf(bytes) {
        return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    }
    function download(bytes, name) {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    function fmtBytes(n) {
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1024 / 1024).toFixed(1) + ' MB';
    }

    // Render thumbnails with pdf.js (window.pdfjsLib, set by the page's module script).
    // o.isStale(): return true to abandon (a newer render started)
    async function renderThumbs(bytes, container, opts) {
        const o = Object.assign({ maxPages: 8, width: 220 }, opts);
        const lib = window.pdfjsLib;
        if (!lib) { container.innerHTML = ''; return; }
        const target = container;
        container = document.createElement('div');
        const task = lib.getDocument({ data: bytes.slice(0) });
        const pdf = await task.promise;
        const n = Math.min(pdf.numPages, o.maxPages);
        for (let i = 1; i <= n; i++) {
            const page = await pdf.getPage(i);
            const vp0 = page.getViewport({ scale: 1 });
            const vp = page.getViewport({ scale: o.width / vp0.width * (window.devicePixelRatio || 1) });
            const cv = document.createElement('canvas');
            cv.width = vp.width; cv.height = vp.height;
            cv.style.width = o.width + 'px';
            cv.className = 'pdf-thumb';
            await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
            const fig = document.createElement('figure');
            fig.className = 'pdf-thumb-fig';
            const cap = document.createElement('figcaption');
            cap.textContent = (o.labels && o.labels[i - 1]) || ('Page ' + i);
            fig.append(cv, cap);
            container.appendChild(fig);
        }
        if ((o.total || pdf.numPages) > n) {
            const more = document.createElement('div');
            more.className = 'field-hint';
            more.setAttribute('data-i18n-skip', '');
            more.textContent = '+' + ((o.total || pdf.numPages) - n) + ' more';
            container.appendChild(more);
        }
        task.destroy();
        if (o.isStale && o.isStale()) return;
        target.replaceChildren(...container.childNodes);
    }

    window.PdfCore = {
        PAPERS, PT_PER_MM,
        parseRange, parseHex, toHex, colorDist, fmtBytes,
        loadPdf, download, renderThumbs,
        scanColorOps, scanFillColors, recolorVectors,
        listImages, canDecode, decodeImage, writeImage, writeJpeg, encodeJpeg, borderColor, recolorImage,
        scanOps, fillAreas,
        mismatchBlend, smoothUpscale, cleanWhite,
        fetchModel, isModelCached, clearModelCache, createUpscaler,
        pageBox, cropBox, planImposition, impose,
    };
})();
