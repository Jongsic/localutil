// UI building blocks shared by the PDF tool pages: file list, progress bar,
// print-layout step, Run/Download wiring and the picture grid. Needs pdf-core.js.
(function () {
    'use strict';
    const C = window.PdfCore;

    function el(tag, attrs, children) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v == null || v === false) continue;
            if (k === 'class') e.className = v;
            else if (k === 'text') e.textContent = v;
            else if (k === 'html') e.innerHTML = v;
            else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
            else e.setAttribute(k, v === true ? '' : v);
        }
        for (const c of [].concat(children || [])) if (c != null) e.append(c);
        return e;
    }
    function toast(msg, isError) { if (window.showToast) window.showToast(msg, isError); }
    function switchEl(id, checked) {
        const input = el('input', { type: 'checkbox', id, checked: checked ? true : null });
        return { wrap: el('label', { class: 'switch' }, [input, el('span')]), input };
    }
    const tick = () => new Promise(r => setTimeout(r, 0));

    // ------------------------------------------------------------------
    // Progress
    // ------------------------------------------------------------------
    function progress(container) {
        const bar = el('div');
        const text = el('div', { class: 'pdf-progress-text', 'data-i18n-skip': true });
        const root = el('div', { class: 'pdf-progress hidden' }, [el('div', { class: 'pdf-progress-bar' }, bar), text]);
        container.appendChild(root);
        return {
            show() { root.classList.remove('hidden'); },
            hide() { root.classList.add('hidden'); },
            set(frac, msg) {
                root.classList.remove('hidden');
                bar.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
                if (msg != null) text.textContent = msg;
            },
        };
    }

    // ------------------------------------------------------------------
    // File list (drop zone + per-file page range / crop)
    // ------------------------------------------------------------------
    function fileList(container, opts) {
        const o = Object.assign({ multiple: true, crop: true, range: true, onChange: () => {} }, opts);
        const files = [];
        const input = el('input', { type: 'file', accept: 'application/pdf,.pdf', multiple: o.multiple ? true : null, style: 'display:none', 'data-testid': 'pdf-input' });
        const drop = el('div', { class: 'pdf-drop', tabindex: '0', role: 'button' }, [
            el('div', { class: 'pdf-drop-main', text: o.multiple ? 'Drop PDF files, or click to choose' : 'Drop a PDF, or click to choose' }),
            el('div', { class: 'pdf-drop-sub', text: 'Files stay in your browser — nothing is uploaded.' }),
        ]);
        const list = el('div', { class: 'pdf-files' });
        container.append(drop, input, list);

        drop.addEventListener('click', () => input.click());
        drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
        drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
        drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
        drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('dragover'); add([...e.dataTransfer.files]); });
        input.addEventListener('change', () => { add([...input.files]); input.value = ''; });

        async function add(list) {
            const pdfs = list.filter(f => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
            if (!pdfs.length) { toast('Choose a PDF file', true); return; }
            if (!o.multiple) files.length = 0;
            for (const f of (o.multiple ? pdfs : pdfs.slice(0, 1))) {
                try {
                    const bytes = new Uint8Array(await f.arrayBuffer());
                    const doc = await C.loadPdf(bytes);
                    files.push({ name: f.name, bytes, doc, pages: doc.getPageCount(), range: '', crop: { mode: 'none' } });
                } catch (e) {
                    toast('Could not read ' + f.name + ': ' + e.message, true);
                }
            }
            suggestCrops();
            render();
            o.onChange(files);
        }

        // Most common page size among the other files (for "match" crop)
        function otherSize(file) {
            const counts = new Map();
            for (const f of files) {
                if (f === file) continue;
                for (const p of f.doc.getPages()) {
                    const b = C.pageBox(p);
                    const key = Math.round(b.right - b.left) + 'x' + Math.round(b.top - b.bottom);
                    counts.set(key, (counts.get(key) || 0) + 1);
                }
            }
            let best = null, n = 0;
            for (const [k, v] of counts) if (v > n) { best = k; n = v; }
            if (!best) return null;
            const [w, h] = best.split('x').map(Number);
            return { width: w, height: h };
        }
        // A file whose pages are larger than everyone else's (e.g. a print-shop
        // proof with crop marks) gets "match" pre-selected.
        function suggestCrops() {
            if (!o.crop) return;
            for (const f of files) {
                if (f.crop.touched) continue;
                const sz = otherSize(f);
                const b = C.pageBox(f.doc.getPage(0));
                const w = b.right - b.left, h = b.top - b.bottom;
                if (sz && w > sz.width + 20 && h > sz.height + 20 && Math.abs(w / h - sz.width / sz.height) < 0.3) {
                    f.crop = { mode: 'size', width: sz.width, height: sz.height, auto: true };
                } else if (f.crop.auto) {
                    f.crop = { mode: 'none' };
                }
            }
        }

        function render() {
            list.innerHTML = '';
            files.forEach((f, i) => {
                const b = C.pageBox(f.doc.getPage(0));
                const mm = v => Math.round(v / C.PT_PER_MM);
                const meta = el('div', { class: 'pdf-file-meta', 'data-i18n-skip': true,
                    text: f.pages + ' p · ' + mm(b.right - b.left) + '×' + mm(b.top - b.bottom) + ' mm · ' + C.fmtBytes(f.bytes.length) });
                const actions = el('div', { class: 'pdf-file-actions' }, [
                    o.multiple ? el('button', { class: 'btn btn-small btn-ghost', type: 'button', title: 'Move up', 'aria-label': 'Move up', text: '↑', disabled: i === 0 ? true : null,
                        onclick: () => { files.splice(i - 1, 0, files.splice(i, 1)[0]); render(); o.onChange(files); } }) : null,
                    o.multiple ? el('button', { class: 'btn btn-small btn-ghost', type: 'button', title: 'Move down', 'aria-label': 'Move down', text: '↓', disabled: i === files.length - 1 ? true : null,
                        onclick: () => { files.splice(i + 1, 0, files.splice(i, 1)[0]); render(); o.onChange(files); } }) : null,
                    el('button', { class: 'btn btn-small btn-ghost', type: 'button', title: 'Remove', 'aria-label': 'Remove', text: '✕',
                        onclick: () => { files.splice(i, 1); suggestCrops(); render(); o.onChange(files); } }),
                ]);
                const opts = el('div', { class: 'pdf-file-opts' });
                if (o.range) {
                    const id = 'pdf-range-' + i;
                    const r = el('input', { type: 'text', id, value: f.range, placeholder: 'all pages', 'data-testid': 'range' });
                    r.addEventListener('change', () => {
                        try { C.parseRange(r.value, f.pages); f.range = r.value; o.onChange(files); }
                        catch (e) { toast(e.message, true); r.value = f.range; }
                    });
                    opts.append(el('label', { for: id, text: 'Pages' }), r);
                }
                if (o.crop) {
                    const id = 'pdf-crop-' + i;
                    const sz = otherSize(f);
                    const sel = el('select', { id, 'data-testid': 'crop' }, [
                        el('option', { value: 'none', text: 'No crop' }),
                        el('option', { value: 'trim', text: 'Trim box' }),
                        sz ? el('option', { value: 'size', text: 'Match other files (' + mm(sz.width) + '×' + mm(sz.height) + ' mm)' }) : null,
                        el('option', { value: 'margins', text: 'Margins (mm)' }),
                    ]);
                    sel.value = f.crop.mode;
                    const marg = el('input', { type: 'number', min: '0', step: '0.5', value: f.crop.mm != null ? f.crop.mm : 10, 'aria-label': 'Margin in mm',
                        class: f.crop.mode === 'margins' ? '' : 'hidden' });
                    const apply = () => {
                        const mode = sel.value;
                        if (mode === 'size') f.crop = { mode, width: sz.width, height: sz.height, touched: true };
                        else if (mode === 'margins') { const v = +marg.value || 0; f.crop = { mode, mm: v, left: v, right: v, top: v, bottom: v, touched: true }; }
                        else f.crop = { mode, touched: true };
                        marg.classList.toggle('hidden', mode !== 'margins');
                        o.onChange(files);
                    };
                    sel.addEventListener('change', apply);
                    marg.addEventListener('change', apply);
                    opts.append(el('label', { for: id, text: 'Crop' }), sel, marg);
                }
                list.append(el('div', { class: 'pdf-file', 'data-testid': 'pdf-file' }, [
                    el('div', {}, [el('div', { class: 'pdf-file-name', 'data-i18n-skip': true, text: f.name }), meta]),
                    actions,
                    opts.childNodes.length ? opts : null,
                ]));
            });
        }
        return { files, add, render };
    }

    // ------------------------------------------------------------------
    // Imposition step
    // ------------------------------------------------------------------
    function imposeStep(container, opts) {
        const o = Object.assign({ toggle: false, enabled: true, onChange: () => {}, getItems: () => [] }, opts);
        const sw = switchEl('im-enable', o.enabled);
        const seg = (id, options, value) => {
            const wrap = el('div', { class: 'segmented', id, role: 'tablist' });
            options.forEach(([v, label]) => wrap.append(el('button', { type: 'button', 'data-v': v, class: v === value ? 'active' : '', text: label })));
            wrap.addEventListener('click', e => {
                const b = e.target.closest('button');
                if (!b) return;
                wrap.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
                update();
            });
            return { wrap, get: () => wrap.querySelector('button.active').dataset.v };
        };
        const mode = seg('im-mode', [['booklet', 'Booklet (fold)'], ['cut', 'Cut & stack'], ['nup', '2 per side, in order']], 'booklet');
        const binding = seg('im-binding', [['side', 'Side, like a book'], ['top', 'Top, like a calendar']], 'side');
        const duplex = seg('im-duplex', [['long', 'Long edge'], ['short', 'Short edge']], 'long');
        const paper = el('select', { id: 'im-paper' }, [
            el('option', { value: 'a4', text: 'A4' }), el('option', { value: 'letter', text: 'US Letter' }),
            el('option', { value: 'a3', text: 'A3' }), el('option', { value: 'a5', text: 'A5' }),
        ]);
        const margin = el('input', { type: 'number', id: 'im-margin', min: '0', step: '0.5', value: '5' });
        const gutter = el('input', { type: 'number', id: 'im-gutter', min: '0', step: '0.5', value: '2' });
        const backSw = switchEl('im-backcover', true);
        const summary = el('div', { class: 'pdf-summary', id: 'im-summary' });
        const bindingRow = el('div', { class: 'pdf-row' }, [el('label', { text: 'Binding' }), binding.wrap]);
        const backRow = el('div', { class: 'pdf-row' }, [backSw.wrap, el('label', { for: 'im-backcover', text: 'Keep the last page as the back cover (blank pages go before it)' })]);
        const duplexRow = el('div', { class: 'pdf-row' }, [el('label', { text: 'Printer flips on' }), duplex.wrap]);
        const duplexHint = el('div', { class: 'field-hint', text: 'Most printers and the macOS print dialog flip on the long edge by default. If the back sides come out upside down, switch this.' });
        [paper, margin, gutter].forEach(x => x.addEventListener('change', update));
        backSw.input.addEventListener('change', update);

        const body = el('div', { class: 'pdf-step-body' }, [
            el('div', { class: 'pdf-row' }, [el('label', { text: 'Layout' }), mode.wrap]),
            bindingRow,
            duplexRow, duplexHint,
            backRow,
            el('div', { class: 'pdf-row' }, [el('label', { for: 'im-paper', text: 'Paper' }), paper,
                el('label', { for: 'im-margin', text: 'Margin (mm)' }), margin,
                el('label', { for: 'im-gutter', text: 'Center gap (mm)' }), gutter]),
            summary,
        ]);
        const root = el('div', { class: 'pdf-step' + (o.enabled ? '' : ' off'), id: 'step-impose' }, [
            el('div', { class: 'pdf-step-head' }, [el('div', { class: 'card-title', text: 'Print layout' }), o.toggle ? sw.wrap : null]),
            body,
        ]);
        container.appendChild(root);
        sw.input.addEventListener('change', () => { root.classList.toggle('off', !sw.input.checked); o.onChange(); });

        function options() {
            return { mode: mode.get(), binding: binding.get(), duplex: duplex.get(), paper: paper.value,
                marginMm: +margin.value || 0, gutterMm: +gutter.value || 0, keepBackCover: backSw.input.checked };
        }
        function describe(plan, count) {
            const opt = options();
            const lines = [];
            const sheets = opt.mode === 'nup' ? plan.sides.length : plan.sides.length / 2;
            lines.push(count + ' pages' + (plan.blanks ? ' + ' + plan.blanks + ' blank' : '') + ' → ' + sheets + ' sheets' + (opt.mode === 'nup' ? '' : ', printed on both sides') + '.');
            const name = i => i == null ? '·' : String(i + 1);
            const show = Math.min(plan.sides.length, opt.mode === 'nup' ? 3 : 4);
            for (let s = 0; s < show; s++) {
                const side = plan.sides[s];
                const label = opt.mode === 'nup' ? 'Sheet ' + (s + 1) : 'Sheet ' + (Math.floor(s / 2) + 1) + (side.back ? ' back' : ' front');
                lines.push(label + ': ' + side.cells.map(c => name(c.item) + (c.rot ? '↻' : '')).join(plan.stacked ? ' / ' : ' | '));
            }
            if (plan.sides.length > show) lines.push('…');
            if (opt.mode === 'booklet') lines.push('Stack all sheets in order, fold them together and staple on the fold.');
            if (opt.mode === 'cut') lines.push('Cut each sheet along the middle mark and stack the halves in page order.');
            if (plan.sides.some(s => s.cells.some(c => c.rot))) lines.push('↻ = drawn upside down on purpose; it comes out upright once printed and folded.');
            return lines;
        }
        function update() {
            const m = mode.get();
            bindingRow.classList.toggle('hidden', m === 'nup');
            backRow.classList.toggle('hidden', m !== 'booklet');
            duplexRow.classList.toggle('hidden', m === 'nup');
            duplexHint.classList.toggle('hidden', m === 'nup');
            const items = o.getItems();
            summary.innerHTML = '';
            if (items.length) {
                const plan = C.planImposition(items, options());
                for (const line of describe(plan, items.length)) summary.append(el('div', { 'data-i18n-skip': true, text: line }));
            }
            o.onChange();
        }

        async function run(sources) {
            if (o.toggle && !sw.input.checked) return null;
            return C.impose(sources, options());
        }
        return { run, update, options, enabled: () => !o.toggle || sw.input.checked };
    }

    // Items (page sizes after crop/rotation) for the imposition summary
    function itemsFor(files) {
        const items = [];
        for (const f of files) {
            const pages = f.doc.getPages();
            for (const i of C.parseRange(f.range, f.pages)) {
                const b = C.cropBox(pages[i], f.crop);
                const w = b.right - b.left, h = b.top - b.bottom;
                const rot = pages[i].getRotation().angle % 180;
                items.push(rot ? { w: h, h: w } : { w, h });
            }
        }
        return items;
    }

    // ------------------------------------------------------------------
    // Picture grid: one card per picture in the PDF, built lazily as cards
    // scroll into view (a manual can hold a thousand pictures).
    // ------------------------------------------------------------------

    // Decoded originals, least recently used dropped first.
    function originals(doc, max) {
        const cache = new Map();
        return async info => {
            const key = info.ref.tag;
            if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return v; }
            const img = await C.decodeImage(doc, info);
            cache.set(key, img);
            if (cache.size > (max || 120)) cache.delete(cache.keys().next().value);
            return img;
        };
    }
    function cloneImg(img) { return { w: img.w, h: img.h, data: new Uint8ClampedArray(img.data) }; }
    function makeCanvasEl(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

    // Draw an RGBA image (or an ImageBitmap) into a canvas, fitted to box.
    function drawFit(canvas, src, box) {
        const sw = src.w || src.width, sh = src.h || src.height;
        const s = Math.min(box / sw, box / sh, 4);
        canvas.width = Math.max(1, Math.round(sw * s)); canvas.height = Math.max(1, Math.round(sh * s));
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = s < 1;
        if (src.data) {
            const tmp = makeCanvasEl(sw, sh);
            tmp.getContext('2d').putImageData(new ImageData(src.data, sw, sh), 0, 0);
            ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
        } else {
            ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
        }
    }

    function pagesLabel(info) {
        const p = [...info.pages].sort((a, b) => a - b).map(i => i + 1);
        return 'p. ' + (p.length > 4 ? p.slice(0, 3).join(', ') + ' …+' + (p.length - 3) : p.join(', '));
    }

    // opts: {infos, build(card), show(card) → async render, minSide, onToggle}
    function imageGrid(container, opts) {
        // default: part icons in parts lists can be ~10–20 px; below 8 px it is slivers and dots
        const o = Object.assign({ minSide: 8 }, opts);
        const toolbar = el('div', { class: 'pdf-row pdf-grid-bar' });
        const grid = el('div', { class: 'pdf-grid', id: 'pic-grid' });
        const countEl = el('span', { class: 'field-hint', 'data-i18n-skip': true });
        const minIn = el('input', { type: 'number', id: 'pic-min', min: '0', step: '1', value: String(o.minSide), style: 'width:70px', 'data-testid': 'pic-min' });
        const pageFilter = el('input', { type: 'text', id: 'pic-pages', placeholder: 'pages, e.g. 5-10', style: 'width:130px', 'aria-label': 'Filter by page' });
        const allBtn = el('button', { class: 'btn btn-small', type: 'button', text: 'Select all' });
        const noneBtn = el('button', { class: 'btn btn-small', type: 'button', text: 'Select none' });
        toolbar.append(countEl, pageFilter, allBtn, noneBtn,
            el('label', { for: 'pic-min', text: 'Hide pictures smaller than', style: 'margin:0' }), minIn, el('span', { class: 'field-hint', text: 'px' }));
        container.append(toolbar, grid);

        const cards = [];
        const io = new IntersectionObserver(entries => {
            for (const e of entries) {
                if (!e.isIntersecting) continue;
                const card = e.target._card;
                io.unobserve(e.target);
                if (!card.shown) { card.shown = true; o.show(card).catch(err => { card.status.textContent = err.message; }); }
            }
        }, { rootMargin: '400px' });

        for (const info of o.infos) {
            const enabled = el('input', { type: 'checkbox', checked: true, 'data-testid': 'pic-enable' });
            const before = el('canvas', { class: 'pdf-pic-canvas' });
            const after = el('canvas', { class: 'pdf-pic-canvas' });
            const status = el('div', { class: 'pdf-pic-status', 'data-i18n-skip': true });
            const controls = el('div', { class: 'pdf-pic-controls' });
            const root = el('div', { class: 'pdf-pic', 'data-testid': 'pic', 'data-tag': info.ref.tag }, [
                el('label', { class: 'pdf-pic-head' }, [enabled,
                    el('span', { 'data-i18n-skip': true, text: pagesLabel(info) }),
                    el('small', { 'data-i18n-skip': true, text: info.width + '×' + info.height })]),
                el('div', { class: 'pdf-pic-pair' }, [
                    el('figure', {}, [before, el('figcaption', { text: 'Before' })]),
                    el('figure', {}, [after, el('figcaption', { text: 'After' })]),
                ]),
                controls, status,
            ]);
            const card = { info, root, enabled, before, after, status, controls, shown: false, data: {} };
            root._card = card;
            enabled.addEventListener('change', () => { root.classList.toggle('off', !enabled.checked); o.onToggle && o.onToggle(card); });
            o.build && o.build(card);
            cards.push(card);
        }

        const tiny = c => Math.min(c.info.width, c.info.height) < (+minIn.value || 0);
        let pageSet = null;
        function layout() {
            grid.innerHTML = '';
            let shown = 0;
            for (const c of cards) {
                if (tiny(c)) continue;
                if (pageSet && ![...c.info.pages].some(p => pageSet.has(p))) continue;
                grid.append(c.root);
                if (!c.shown) io.observe(c.root);
                shown++;
            }
            countEl.textContent = shown + ' / ' + cards.length;
        }
        minIn.addEventListener('change', layout);
        pageFilter.addEventListener('change', () => {
            const v = pageFilter.value.trim();
            try { pageSet = v ? new Set(C.parseRange(v, 100000)) : null; } catch (e) { toast(e.message, true); return; }
            layout();
        });
        // Select all / none act on the pictures currently listed
        const setAll = v => { for (const c of cards) { if (!c.root.isConnected) continue; c.enabled.checked = v; c.root.classList.toggle('off', !v); o.onToggle && o.onToggle(c); } };
        allBtn.addEventListener('click', () => setAll(true));
        noneBtn.addEventListener('click', () => setAll(false));
        layout();
        return {
            cards,
            // hidden tiny pictures follow their checkbox too (default: on)
            selected: () => cards.filter(c => c.enabled.checked),
            // ticked and currently listed (respects the page filter / tiny toggle)
            listedSelected: () => cards.filter(c => c.enabled.checked && c.root.isConnected),
            refresh: () => { for (const c of cards) if (c.shown) o.show(c).catch(() => {}); },
            destroy: () => { io.disconnect(); container.innerHTML = ''; },
        };
    }

    // Save each document's current state as bytes (after staged edits)
    async function saveDoc(doc) { return doc.save({ useObjectStreams: true }); }

    function outName(name, suffix) { return name.replace(/\.pdf$/i, '') + suffix + '.pdf'; }

    function sideLabels(plan, mode) {
        return plan.sides.map((s, i) => mode === 'nup' ? 'Sheet ' + (i + 1) : 'Sheet ' + (Math.floor(i / 2) + 1) + (s.back ? ' · back' : ' · front'));
    }

    // Wires the Run / Download buttons, progress and preview of a tool page.
    // task(prog) → {bytes, labels?, lines?}
    function runner(o) {
        let result = null;
        const prog = progress(o.progressEl);
        const setReady = ready => { o.runBtn.disabled = !ready; };
        const invalidate = () => { result = null; o.dlBtn.disabled = true; };
        o.runBtn.addEventListener('click', async () => {
            o.runBtn.disabled = true;
            invalidate();
            o.summaryEl.innerHTML = '';
            o.previewEl.innerHTML = '';
            const t0 = performance.now();
            try {
                const r = await o.task((f, msg) => prog.set(f, msg));
                result = r.bytes;
                prog.set(1, 'Done in ' + ((performance.now() - t0) / 1000).toFixed(1) + 's — ' + C.fmtBytes(result.length));
                for (const line of r.lines || []) o.summaryEl.append(el('div', { 'data-i18n-skip': true, text: line }));
                o.dlBtn.disabled = false;
                await C.renderThumbs(result, o.previewEl, { maxPages: o.maxPreview || 6, width: o.previewWidth || 220, labels: r.labels });
            } catch (e) {
                console.warn(e);
                prog.set(0, e.message);
                toast(e.message, true);
            } finally {
                o.runBtn.disabled = false;
            }
        });
        o.dlBtn.addEventListener('click', () => { if (result) C.download(result, o.getName()); });
        return { invalidate, setReady };
    }

    window.PdfUi = { el, progress, fileList, imposeStep, itemsFor, saveDoc, outName, sideLabels, runner, tick,
        imageGrid, originals, cloneImg, drawFit, pagesLabel, switchEl, toast };
})();
