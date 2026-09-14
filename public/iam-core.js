// Reading an AWS IAM policy and writing it back in one canonical shape:
// parsing whatever the console or the CLI handed you, normalizing the values a
// policy is free to write several ways, and merging statements into blocks.
//
// Extracted from iam-diff.html so the normalizer and the comparison run exactly
// the same code — there must be one implementation of this. Exposed as
// window.LocalUtilIAM.
(function () {
    'use strict';

        const asList = v => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
        const hasWild = s => s.indexOf('*') !== -1 || s.indexOf('?') !== -1;

        function normalizeText(s, opt) {
            let x = String(s);
            if (opt.account) x = x.replace(/\b\d{12}\b/g, '<ACCOUNT>');
            if (opt.region) x = x.replace(/\b(?:af|ap|ca|cn|eu|il|me|mx|sa|us)-(?:gov-)?[a-z]+-\d\b/g, '<REGION>');
            return x;
        }

        const byJson = (a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
        const uniqSort = list => [...new Set(list)].sort();

        // Key order and value order carry no meaning in a policy, and neither
        // does writing one value bare instead of as a one-element array — IAM
        // reads "a" and ["a"] identically wherever a list is allowed. All of
        // that is normalized away before two policies are ever compared.
        function canonValues(v, opt) {
            const seen = new Set(), out = [];
            for (const x of asList(v)) {
                const val = typeof x === 'string' ? normalizeText(x, opt) : x;
                const k = JSON.stringify(val);
                if (seen.has(k)) continue;
                seen.add(k);
                out.push(val);
            }
            return out.sort(byJson);
        }

        function canonCondition(c, opt) {
            if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
            const out = {};
            for (const op of Object.keys(c).sort()) {
                const block = c[op];
                if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
                const o = {};
                for (const k of Object.keys(block).sort()) o[k] = canonValues(block[k], opt);
                out[op] = o;
            }
            return Object.keys(out).length ? out : null;
        }

        // Principal is either the bare string "*" or a map of type to values.
        function canonPrincipal(p, opt) {
            if (p === null || p === undefined) return null;
            if (typeof p === 'string') return normalizeText(p, opt);
            if (typeof p !== 'object' || Array.isArray(p)) return null;
            const out = {};
            for (const type of Object.keys(p).sort()) out[type] = canonValues(p[type], opt);
            return Object.keys(out).length ? out : null;
        }

        // ------------------------------------------------------------
        // Reading the input
        // ------------------------------------------------------------
        // Whatever the console or the CLI handed you should paste straight
        // in, so this accepts far more than one JSON document: objects laid
        // end to end, an array of them, and the wrappers every `aws iam`
        // read command puts around the document you actually want.
        const DOC_KEYS = { PolicyDocument: 1, Document: 1, AssumeRolePolicyDocument: 1 };

        // Balance braces to find where one document ends, skipping anything
        // inside a string so an ARN containing a brace cannot end it early.
        function documentEnd(s, start) {
            let depth = 0, inStr = false, escaped = false;
            for (let i = start; i < s.length; i++) {
                const c = s[i];
                if (inStr) {
                    if (escaped) escaped = false;
                    else if (c === '\\') escaped = true;
                    else if (c === '"') inStr = false;
                    continue;
                }
                if (c === '"') inStr = true;
                else if (c === '{' || c === '[') depth++;
                else if (c === '}' || c === ']') { depth--; if (depth === 0) return i + 1; }
            }
            throw new Error('a JSON document is never closed — a } or ] is missing');
        }

        // Pull out every object that has a Statement, wherever it is nested.
        function harvest(value, out, depth) {
            depth = depth || 0;
            if (depth > 16 || !value || typeof value !== 'object') return;
            if (Array.isArray(value)) { value.forEach(v => harvest(v, out, depth + 1)); return; }
            if (value.Statement) { out.push(value); return; }
            for (const [k, v] of Object.entries(value)) {
                if (typeof v === 'string') {
                    // IAM hands the trust policy back percent-encoded.
                    if (!DOC_KEYS[k]) continue;
                    try { harvest(JSON.parse(decodeURIComponent(v)), out, depth + 1); } catch { /* not a document */ }
                } else {
                    harvest(v, out, depth + 1);
                }
            }
        }

        // Statements pulled out of a document, or this page's own normalized
        // listing before it was wrapped, arrive as a bare array. An array of
        // policy documents is not that — those elements carry a Statement.
        const looksLikeStatement = v =>
            !!v && typeof v === 'object' && !Array.isArray(v) && !v.Statement &&
            (v.Effect !== undefined || v.Action !== undefined || v.NotAction !== undefined);

        function parseInput(text, side) {
            let src = text.trim();
            if (!src) return [];
            if (src[0] !== '{' && src[0] !== '[') {
                // A document lifted out of Terraform state or a URL is encoded.
                try {
                    const decoded = decodeURIComponent(src).trim();
                    if (decoded[0] === '{' || decoded[0] === '[') src = decoded;
                } catch { /* not percent-encoded either — the error below says so */ }
            }
            const docs = [];
            let i = 0;
            while (i < src.length) {
                while (i < src.length && /\s/.test(src[i])) i++;
                if (i >= src.length) break;
                if (src[i] !== '{' && src[i] !== '[') {
                    throw new Error(side + ': a policy document has to start with { or [ — found "' +
                        src[i] + '" at character ' + (i + 1));
                }
                const end = documentEnd(src, i);
                let parsed;
                try {
                    parsed = JSON.parse(src.slice(i, end));
                } catch (e) {
                    throw new Error(side + ': ' + e.message);
                }
                if (Array.isArray(parsed) && parsed.length && parsed.every(looksLikeStatement)) {
                    harvest({ Statement: parsed }, docs);
                } else {
                    harvest(parsed, docs);
                }
                i = end;
            }
            if (!docs.length) throw new Error(side + ': no policy document found — nothing here has a Statement');
            return docs;
        }

        // ------------------------------------------------------------
        // The other question: is it written the same?
        // ------------------------------------------------------------
        // The unit is a block: a set of actions on a set of resources under
        // one Effect, principal and condition. Blocks start as the statements
        // were written and are then collapsed by two rules, applied until
        // nothing more merges:
        //
        //   · same scope, different actions   → one block, actions unioned
        //   · same actions, different scope   → one block, resources unioned
        //
        // That is what makes how a policy was split up stop counting as a
        // difference, in both directions. Re-deriving blocks from the policy
        // as a pure relation instead — grouping every action by the exact set
        // of resources it reaches anywhere — is more canonical and reads far
        // worse: an action named in two unrelated statements acquires the
        // union of both resource sets and is pulled out of the group it was
        // written with, so a block that matched the other side exactly is
        // reported as missing an action it plainly has.
        //
        // Nothing beyond that is interpreted: no wildcard is expanded, no
        // Deny cancels anything.
        const actionToken = (value, neg) => (neg ? '!A:' : 'A:') + value;

        function statementUnits(docs, opt, notes, side) {
            const units = [];
            let skipped = 0;
            for (const doc of docs) {
                for (const st of asList(doc.Statement)) {
                    if (!st || typeof st !== 'object') continue;
                    const effect = /^deny$/i.test(String(st.Effect || '')) ? 'Deny' : 'Allow';
                    const values = (pos, neg) => ({
                        pos: uniqSort(asList(st[pos]).map(v => normalizeText(v, opt))),
                        neg: uniqSort(asList(st[neg]).map(v => normalizeText(v, opt))),
                    });
                    const act = values('Action', 'NotAction');
                    if (!act.pos.length && !act.neg.length) { skipped++; continue; }
                    const res = values('Resource', 'NotResource');
                    const principal = canonPrincipal(st.Principal, opt);
                    const notPrincipal = canonPrincipal(st.NotPrincipal, opt);
                    const cond = opt.ignoreCond ? null : canonCondition(st.Condition, opt);

                    // A context is everything qualifying the grant except the
                    // resources, in a fixed field order so JSON.stringify is
                    // a usable identity.
                    const ctx = { Effect: effect };
                    if (principal) ctx.Principal = principal;
                    if (notPrincipal) ctx.NotPrincipal = notPrincipal;
                    if (cond) ctx.Condition = cond;

                    units.push({
                        ctx, ctxKey: JSON.stringify(ctx), effect, principal, notPrincipal, cond,
                        act,
                        // A NotResource is a different axis from a Resource, so
                        // the two are kept apart by their prefix, never merged.
                        resTokens: res.pos.map(r => 'R:' + r).concat(res.neg.map(r => '!R:' + r)),
                        sid: typeof st.Sid === 'string' ? st.Sid : '',
                    });
                }
            }
            if (skipped) {
                notes.push(side + ': ' + skipped + ' statement(s) declare neither Action nor NotAction and were skipped.');
            }
            return units;
        }

        // Which contexts an action appears in — not which resources it reaches
        // there. A resource added or dropped stays visible inside the block it
        // happened in, so only a change of Effect, principal or condition puts
        // an action somewhere its old block can never reach.
        function actionContexts(units) {
            const map = new Map();
            for (const u of units) {
                const add = token => {
                    let set = map.get(token);
                    if (!set) map.set(token, set = new Set());
                    set.add(u.ctxKey);
                };
                u.act.pos.forEach(v => add(actionToken(v, false)));
                u.act.neg.forEach(v => add(actionToken(v, true)));
            }
            return map;
        }

        // An action both sides list, but never under the same condition, was
        // not removed and re-added — it moved, and that is the thing to show.
        // Left among the actions it shares a block with, it reads as a deletion
        // in one block while an apparently unrelated block appears elsewhere,
        // so it is lifted out on both sides and the two are paired.
        //
        // The test is an empty intersection, and it is on contexts alone.
        // Testing the full address instead — context plus resources — tore
        // apart actions sitting in exactly the same place as their neighbours
        // merely because one of them was also named somewhere else.
        function movedActions(unitsA, unitsB) {
            const mapA = actionContexts(unitsA), mapB = actionContexts(unitsB);
            const out = new Set();
            for (const [token, ctxA] of mapA) {
                const ctxB = mapB.get(token);
                if (!ctxB) continue;
                let shared = false;
                for (const key of ctxA) if (ctxB.has(key)) { shared = true; break; }
                if (!shared) out.add(token);
            }
            return out;
        }

        const setKey = set => JSON.stringify([...set].sort());
        const addAll = (into, from) => { for (const x of from) into.add(x); };

        // Fold every block sharing `keyOf` into the first of them.
        function mergeOn(blocks, keyOf, fold) {
            const byKey = new Map();
            for (const b of blocks) {
                const key = keyOf(b);
                const first = byKey.get(key);
                if (!first) { byKey.set(key, b); continue; }
                fold(first, b);
                b.sids.forEach(sid => { if (first.sids.indexOf(sid) === -1) first.sids.push(sid); });
            }
            return [...byKey.values()];
        }

        const actionsKey = b => setKey(b.actions) + ' ' + setKey(b.notActions);

        function blocksFrom(units, apart) {
            let blocks = units.flatMap(u => {
                // Which axes this statement is written on. A statement carries
                // either Action or NotAction and either Resource or NotResource,
                // never both of a pair, so the axis is part of a block's identity:
                // merging across one would produce a policy IAM rejects outright.
                const resAxis =
                    (u.resTokens.some(t => t.slice(0, 2) === 'R:') ? 'R' : '') +
                    (u.resTokens.some(t => t.slice(0, 3) === '!R:') ? '!R' : '');

                // A statement's actions are split when only some of them moved:
                // a lifted action must not be merged back in by the rules below.
                const parts = new Map();
                const negResource = resAxis.indexOf('!R') !== -1;
                const place = (value, neg) => {
                    const solo = apart.has(actionToken(value, neg)) ? 'moved' : '';
                    const axis = (neg ? '!A' : 'A') + resAxis;
                    const partKey = solo + ' ' + axis;
                    let b = parts.get(partKey);
                    if (!b) {
                        parts.set(partKey, b = {
                            ctx: u.ctx, ctxKey: u.ctxKey, effect: u.effect,
                            principal: u.principal, notPrincipal: u.notPrincipal, cond: u.cond,
                            solo, axis, negAction: neg, negResource,
                            actions: new Set(), notActions: new Set(),
                            res: new Set(u.resTokens), sids: u.sid ? [u.sid] : [],
                        });
                    }
                    (neg ? b.notActions : b.actions).add(value);
                };
                u.act.pos.forEach(v => place(v, false));
                u.act.neg.forEach(v => place(v, true));
                return [...parts.values()];
            });

            // Merging on one axis creates blocks that can merge on the other,
            // so both rules run until the count stops falling. Each pass only
            // ever removes blocks, so this terminates.
            //
            // A negated axis is never unioned, only deduplicated: NOT a OR NOT b
            // is not NOT (a OR b). Two statements allowing everything but
            // iam:DeleteUser and everything but s3:DeleteBucket allow everything
            // between them, while one block excluding both allows strictly less.
            // Putting the negated side's own values in the key leaves identical
            // statements folding together and different ones apart.
            for (let pass = 0; pass < 8; pass++) {
                const before = blocks.length;
                blocks = mergeOn(blocks,
                    b => b.ctxKey + ' ' + b.solo + ' ' + b.axis + ' ' + setKey(b.res) +
                        (b.negAction ? ' ' + actionsKey(b) : ''),
                    (a, b) => { addAll(a.actions, b.actions); addAll(a.notActions, b.notActions); });
                blocks = mergeOn(blocks,
                    b => b.ctxKey + ' ' + b.solo + ' ' + b.axis + ' ' + actionsKey(b) +
                        (b.negResource ? ' ' + setKey(b.res) : ''),
                    (a, b) => { addAll(a.res, b.res); });
                if (blocks.length === before) break;
            }

            return finishBlocks(blocks);
        }

        function finishBlocks(blocks) {
            for (const g of blocks) {
                const tokens = [...g.res];
                g.res = {
                    pos: tokens.filter(t => t.slice(0, 2) === 'R:').map(t => t.slice(2)).sort(),
                    neg: tokens.filter(t => t.slice(0, 3) === '!R:').map(t => t.slice(3)).sort(),
                };
                const acts = [...g.actions].sort();
                const notActs = [...g.notActions].sort();
                // Action sits under Effect: it is the part being read.
                const shape = { Effect: g.effect };
                if (acts.length) shape.Action = acts;
                if (notActs.length) shape.NotAction = notActs;
                if (g.res.pos.length) shape.Resource = g.res.pos;
                if (g.res.neg.length) shape.NotResource = g.res.neg;
                if (g.principal) shape.Principal = g.principal;
                if (g.notPrincipal) shape.NotPrincipal = g.notPrincipal;
                if (g.cond) shape.Condition = g.cond;
                g.shape = shape;
                g.scopeKey = g.ctxKey + ' ' + JSON.stringify(g.res);
                g.pairKey = g.scopeKey + ' ' + g.solo + ' ' + g.axis;
                g.key = JSON.stringify(shape);
                g.tokens = tokensOf(g);
            }
            return blocks.sort((x, y) => x.pairKey.localeCompare(y.pairKey));
        }

        // Two blocks whose scopes differ — a resource added, a condition
        // introduced — still belong side by side when their content mostly
        // agrees. Actions and scope are scored apart and the actions dominate:
        // a block is its action list, and two blocks sharing no action are not
        // the same block however much scope they have in common.
        function tokensOf(g) {
            const actions = new Set();
            for (const a of g.actions) actions.add(actionToken(a, false));
            for (const a of g.notActions) actions.add(actionToken(a, true));
            const scope = new Set();
            for (const r of g.res.pos) scope.add('R:' + r);
            for (const r of g.res.neg) scope.add('!R:' + r);
            if (g.principal) scope.add('P:' + JSON.stringify(g.principal));
            if (g.notPrincipal) scope.add('!P:' + JSON.stringify(g.notPrincipal));
            if (g.cond) scope.add('C:' + JSON.stringify(g.cond));
            return { actions, scope };
        }


    // Blocks written back as a policy document, so the result reads into this
    // page and into anything else that takes a policy.
    function policyDocument(blocks) {
        return { Version: '2012-10-17', Statement: blocks.map(b => b.shape) };
    }

        // ------------------------------------------------------------
        // Flattening statements into single permissions
        // ------------------------------------------------------------
        const MAX_ATOMS = 20000;

        function principalsOf(st, opt) {
            const out = [];
            const add = (p, neg) => {
                const mark = neg ? 'NOT ' : '';
                if (typeof p === 'string') { out.push(mark + normalizeText(p, opt)); return; }
                if (!p || typeof p !== 'object') return;
                for (const type of Object.keys(p).sort()) {
                    for (const v of asList(p[type])) out.push(mark + type + ':' + normalizeText(v, opt));
                }
            };
            if (st.Principal) add(st.Principal, false);
            if (st.NotPrincipal) add(st.NotPrincipal, true);
            return out;
        }

        // Actions are keyed case-insensitively because IAM matches them that
        // way; resources are not, because an S3 key is case-sensitive.
        function atomKeys(a) {
            a.ar = a.effect + ' ' + (a.actionNeg ? '!' : '') + a.action.toLowerCase() +
                ' ' + (a.resourceNeg ? '!' : '') + (a.resource === null ? '' : a.resource) +
                ' ' + a.principal;
            a.key = a.ar + ' ' + a.condKey;
        }

        function compareAtoms(x, y) {
            return x.effect.localeCompare(y.effect) ||
                x.action.localeCompare(y.action) ||
                String(x.resource).localeCompare(String(y.resource)) ||
                x.principal.localeCompare(y.principal) ||
                x.condKey.localeCompare(y.condKey);
        }

        function flatten(docs, opt, notes, side) {
            const byKey = new Map();
            let capped = false, skipped = 0;
            for (const doc of docs) {
                for (const st of asList(doc.Statement)) {
                    if (!st || typeof st !== 'object') continue;
                    const effect = /^deny$/i.test(String(st.Effect || '')) ? 'Deny' : 'Allow';
                    const cond = opt.ignoreCond ? null : canonCondition(st.Condition, opt);
                    const condKey = cond ? JSON.stringify(cond) : '';
                    const actions = asList(st.Action).map(a => ({ v: normalizeText(a, opt), neg: false }))
                        .concat(asList(st.NotAction).map(a => ({ v: normalizeText(a, opt), neg: true })));
                    if (!actions.length) { skipped++; continue; }
                    const resources = asList(st.Resource).map(r => ({ v: normalizeText(r, opt), neg: false }))
                        .concat(asList(st.NotResource).map(r => ({ v: normalizeText(r, opt), neg: true })));
                    const resList = resources.length ? resources : [null];
                    const princes = principalsOf(st, opt);
                    const prList = princes.length ? princes : [''];
                    const sid = typeof st.Sid === 'string' ? st.Sid : '';
                    for (const a of actions) {
                        for (const r of resList) {
                            for (const p of prList) {
                                if (byKey.size >= MAX_ATOMS) { capped = true; continue; }
                                const atom = {
                                    effect,
                                    action: a.v, actionNeg: a.neg,
                                    resource: r ? r.v : null, resourceNeg: r ? r.neg : false,
                                    principal: p, cond, condKey, sid, side,
                                };
                                atomKeys(atom);
                                if (!byKey.has(atom.key)) byKey.set(atom.key, atom);
                            }
                        }
                    }
                }
            }
            if (skipped) {
                notes.push(side + ': ' + skipped + ' statement(s) had neither Action nor NotAction and were skipped.');
            }
            if (capped) {
                notes.push(side + ': stopped at ' + MAX_ATOMS.toLocaleString() +
                    ' permissions — the rest were not compared. Narrow the input.');
            }
            return [...byKey.values()].sort(compareAtoms);
        }

    // ------------------------------------------------------------
    // The canonical form
    // ------------------------------------------------------------
    // Merging is a minimization and depends on how the input was written: the
    // same access split by action or split by resource stops at different text.
    // This does not. Forget the statements, take the relation — which actions
    // reach which resources — and group every action by the exact set of
    // resources it reaches. Two policies granting the same thing come out
    // identical, whatever they looked like going in.
    //
    // The price is that it pulls apart the groups a policy was written in, which
    // is why it is not what the merge emits.
    //
    // Negated statements are the exception and are carried through as written,
    // deduplicated but never regrouped. NotAction expands to one permission per
    // excluded value, so the relation cannot tell `NotAction: [a, b]` from two
    // statements excluding a and b separately — and those two are not the same
    // policy. Rebuilding them from the relation would have to guess.
    function canonicalBlocks(units) {
        const contexts = new Map();
        const negated = new Map();

        for (const u of units) {
            const negAction = u.act.neg.length > 0;
            const negResource = u.resTokens.some(t => t.slice(0, 3) === '!R:');
            const base = {
                ctx: u.ctx, ctxKey: u.ctxKey, effect: u.effect,
                principal: u.principal, notPrincipal: u.notPrincipal, cond: u.cond,
                solo: '', axis: '', negAction, negResource,
            };

            if (negAction || negResource) {
                const block = Object.assign({}, base, {
                    actions: new Set(u.act.pos), notActions: new Set(u.act.neg),
                    res: new Set(u.resTokens), sids: u.sid ? [u.sid] : [],
                });
                const key = u.ctxKey + ' ' + setKey(block.actions) + ' ' +
                    setKey(block.notActions) + ' ' + setKey(block.res);
                const seen = negated.get(key);
                if (seen) { u.sid && seen.sids.indexOf(u.sid) === -1 && seen.sids.push(u.sid); continue; }
                negated.set(key, block);
                continue;
            }

            let c = contexts.get(u.ctxKey);
            if (!c) contexts.set(u.ctxKey, c = { base, reach: new Map(), sids: [] });
            if (u.sid && c.sids.indexOf(u.sid) === -1) c.sids.push(u.sid);
            for (const action of u.act.pos) {
                let res = c.reach.get(action);
                if (!res) c.reach.set(action, res = new Set());
                u.resTokens.forEach(t => res.add(t));
            }
        }

        const blocks = [...negated.values()];
        for (const c of contexts.values()) {
            const byReach = new Map();
            for (const [action, res] of c.reach) {
                const key = setKey(res);
                let group = byReach.get(key);
                if (!group) byReach.set(key, group = { res, actions: new Set() });
                group.actions.add(action);
            }
            for (const { res, actions } of byReach.values()) {
                blocks.push(Object.assign({}, c.base, {
                    actions, notActions: new Set(), res, sids: c.sids.slice(),
                }));
            }
        }
        return finishBlocks(blocks);
    }

    // ------------------------------------------------------------
    // Checking that a rewrite kept every permission
    // ------------------------------------------------------------
    // Merging statements and expanding them into permissions are two different
    // pieces of code. Running the second over a policy and over its rewrite has
    // to produce the same set: grouped by scope, the actions allowed under each
    // must be identical on both sides. That makes every run checked, not just
    // the ones someone thought to write a test for.
    //
    // It is not a proof of everything. Both sides normalize their values with
    // the same helpers above, so a defect in those is invisible here; what this
    // catches is a permission dropped, gained, or re-attached to the wrong
    // scope, which is what a merge gets wrong.
    function describeAtom(a) {
        const action = (a.actionNeg ? 'NOT ' : '') + a.action;
        const resource = a.resource === null ? '-' : (a.resourceNeg ? 'NOT ' : '') + a.resource;
        return a.effect.toUpperCase() + ' ' + action + ' on ' + resource +
            (a.principal ? ' by ' + a.principal : '') +
            (a.condKey ? ' if ' + a.condKey : '');
    }

    function verifyLossless(beforeDocs, afterDocs, opt) {
        const notes = [];
        const before = flatten(beforeDocs, opt, notes, 'before');
        const after = flatten(afterDocs, opt, notes, 'after');
        const afterKeys = new Set(after.map(a => a.key));
        const beforeKeys = new Set(before.map(a => a.key));
        return {
            ok: notes.length === 0 &&
                before.every(a => afterKeys.has(a.key)) && after.every(a => beforeKeys.has(a.key)),
            total: before.length,
            lost: before.filter(a => !afterKeys.has(a.key)),
            gained: after.filter(a => !beforeKeys.has(a.key)),
            // Past the expansion cap neither side is complete, so silence is not
            // evidence and the check has to say it could not finish.
            capped: notes.length > 0,
        };
    }

    window.LocalUtilIAM = {
        asList, hasWild, uniqSort, normalizeText,
        canonValues, canonCondition, canonPrincipal,
        parseInput, statementUnits, actionContexts, movedActions, blocksFrom,
        actionToken, policyDocument,
        flatten, compareAtoms, describeAtom, verifyLossless, canonicalBlocks,
    };
})();
