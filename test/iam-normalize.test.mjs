import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

const doc = (...statements) => JSON.stringify({ Version: '2012-10-17', Statement: statements });

async function normalize(policy, opts = {}) {
    await env.goto('iam-normalize.html');
    for (const [key, sel] of Object.entries({ account: '#iamn-opt-account', region: '#iamn-opt-region' })) {
        if (opts[key] === undefined) continue;
        if (await env.page.isChecked(sel) !== opts[key]) await env.page.click(sel);
    }
    await env.page.fill('#iamn-in', typeof policy === 'string' ? policy : JSON.stringify(policy));
    await env.page.click('#btn-iamn-run');
}

const output = () => env.page.textContent('#iamn-out');

async function statements() {
    return JSON.parse(await output()).Statement;
}

async function chips() {
    const pairs = await env.page.$$eval('.iamn-chip', els => els.map(e => {
        const n = e.querySelector('b').textContent;
        return [e.textContent.slice(n.length).trim(), n];
    }));
    return Object.fromEntries(pairs);
}

const notes = () => env.page.$$eval('.iamn-notes li', els => els.map(e => e.textContent));

test('the same access arrived at from three directions becomes one block', async () => {
    await normalize(doc(
        { Sid: 'Read', Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::one/*' },
        { Sid: 'Write', Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject'], Resource: ['arn:aws:s3:::one/*'] },
        { Sid: 'Backup', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: 'arn:aws:s3:::two/*' },
    ));
    assert.deepEqual(await statements(), [{
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject'],
        Resource: ['arn:aws:s3:::one/*', 'arn:aws:s3:::two/*'],
    }], 'the scope rule merged one/*, which let the action rule merge two/*');

    const c = await chips();
    assert.equal(c['statements in'], '3');
    assert.equal(c['blocks out'], '1');
    assert.equal(c['distinct actions'], '2');
    assert.equal(c['action/resource pairs'], '4');
});

test('a duplicate statement collapses', async () => {
    await normalize(doc(
        { Sid: 'A', Effect: 'Allow', Action: 's3:ListBucket', Resource: 'arn:aws:s3:::one' },
        { Sid: 'B', Effect: 'Allow', Action: ['s3:ListBucket'], Resource: ['arn:aws:s3:::one'] },
    ));
    assert.deepEqual(await statements(), [
        { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: ['arn:aws:s3:::one'] },
    ]);
    assert.equal((await chips())['blocks out'], '1');
});

test('the output is a policy document, sorted and stable', async () => {
    const messy = doc(
        { Sid: 'x', Resource: ['arn:b', 'arn:a'], Action: ['ec2:Zulu', 'ec2:Alpha'], Effect: 'Allow' });
    await normalize(messy);
    const first = await output();
    assert.match(first, /^\{\n  "Version": "2012-10-17",\n  "Statement": \[/);
    assert.deepEqual(await statements(), [
        { Effect: 'Allow', Action: ['ec2:Alpha', 'ec2:Zulu'], Resource: ['arn:a', 'arn:b'] },
    ]);

    // Feeding the result back changes nothing.
    await normalize(first);
    assert.equal(await output(), first);
});

// Every string the input holds, except the ones normalization is documented to
// drop. A value that vanishes has to fail something.
function leafStrings(value, out = new Set(), key = '') {
    if (typeof value === 'string') {
        if (key !== 'Sid' && key !== 'Version') out.add(value);
        return out;
    }
    if (Array.isArray(value)) { value.forEach(v => leafStrings(v, out, key)); return out; }
    if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            out.add(k === 'Sid' || k === 'Version' ? null : k);
            leafStrings(v, out, k);
        }
        out.delete(null);
    }
    return out;
}

test('every value in the input is still in the output', async () => {
    const policy = {
        Version: '2012-10-17',
        Statement: [
            { Sid: 'One', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: 'arn:aws:s3:::b/*' },
            { Sid: 'Two', Effect: 'Deny', Action: 's3:DeleteBucket', Resource: '*' },
            { Sid: 'Three', Effect: 'Allow', Action: 'sts:AssumeRole', Resource: 'arn:aws:iam::111122223333:role/r',
              Condition: { StringEquals: { 'sts:ExternalId': 'abc' }, Bool: { 'aws:SecureTransport': 'true' } } },
            { Sid: 'Four', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
            { Sid: 'Five', Effect: 'Allow', NotAction: 'iam:*', NotResource: 'arn:aws:iam::111122223333:role/admin' },
        ],
    };
    await normalize(policy);
    const text = await output();
    const missing = [...leafStrings(policy)].filter(v => !text.includes(v));
    assert.deepEqual(missing, [], 'these values did not survive normalization');

    // And the two things it is documented to drop really are gone.
    assert.ok(!text.includes('"Sid"'), 'Sid is dropped');
    assert.match(text, /"Version": "2012-10-17"/, 'the document version is rewritten, not carried over');
});

test('a Deny is a block like any other and cancels nothing', async () => {
    await normalize(doc(
        { Effect: 'Allow', Action: 's3:DeleteBucket', Resource: '*' },
        { Effect: 'Deny', Action: 's3:DeleteBucket', Resource: '*' },
    ));
    const st = await statements();
    assert.equal(st.length, 2);
    assert.deepEqual(st.map(s => s.Effect).sort(), ['Allow', 'Deny']);
});

test('a wildcard is never expanded, and never swallows what it covers', async () => {
    await normalize(doc({ Effect: 'Allow', Action: ['s3:*', 's3:GetObject'], Resource: '*' }));
    assert.deepEqual((await statements())[0].Action, ['s3:*', 's3:GetObject']);
});

test('conditions keep blocks apart, and their values are sorted', async () => {
    await normalize(doc(
        { Effect: 'Allow', Action: 'sts:AssumeRole', Resource: '*' },
        { Effect: 'Allow', Action: 'sts:AssumeRole', Resource: '*',
          Condition: { StringEquals: { 'aws:PrincipalTag/team': ['ops', 'dev'] } } },
    ));
    const st = await statements();
    assert.equal(st.length, 2, 'a condition is not something to merge away');
    const guarded = st.find(s => s.Condition);
    assert.deepEqual(guarded.Condition.StringEquals['aws:PrincipalTag/team'], ['dev', 'ops']);
});

test('NotAction stays on its own axis', async () => {
    await normalize(doc(
        { Effect: 'Allow', NotAction: 'iam:*', Resource: '*' },
        { Effect: 'Allow', Action: 's3:GetObject', Resource: '*' },
    ));
    const st = await statements();
    assert.equal(st.length, 2, 'a complement is not merged into the positive form');
    assert.ok(st.some(s => s.NotAction));
});

test('a bare Statement array and aws iam wrappers are read', async () => {
    const expected = [{ Effect: 'Allow', Action: ['s3:GetObject'], Resource: ['*'] }];
    await normalize(JSON.stringify([{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }]));
    assert.deepEqual(await statements(), expected);

    await normalize(JSON.stringify({
        RoleName: 'r', PolicyName: 'p',
        PolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }] },
    }));
    assert.deepEqual(await statements(), expected);
});

test('several documents in a row are merged into one policy', async () => {
    await normalize(
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:x' }) + '\n' +
        doc({ Effect: 'Allow', Action: 's3:PutObject', Resource: 'arn:x' }));
    assert.deepEqual(await statements(), [
        { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: ['arn:x'] },
    ]);
    assert.equal((await chips())['statements in'], '2');
});

test('bad input says what is wrong and clears the output', async () => {
    await normalize('not json at all');
    assert.match(await env.page.textContent('#iamn-error'), /Policy: a policy document has to start with/);
    assert.equal(await env.page.isHidden('#iamn-stats'), true);
    assert.equal(await output(), '');
});

test('the size is measured the way IAM measures it', async () => {
    await normalize(doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:x' }));
    const small = Number((await chips())['characters'].replace(/,/g, ''));
    assert.ok(small > 0 && small < 200);
    assert.doesNotMatch((await notes()).join('\n'), /Over the/);

    // Enough distinct actions to run past the managed policy limit.
    const many = Array.from({ length: 300 }, (_, i) => 'service:LongEnoughActionName' + i);
    await normalize(doc({ Effect: 'Allow', Action: many, Resource: 'arn:x' }));
    const big = Number((await chips())['characters'].replace(/,/g, ''));
    assert.ok(big > 6144);
    assert.match((await notes()).join('\n'), /Over the 6,144-character limit for a managed policy/);
});

test('merging is reported as characters saved', async () => {
    await normalize(doc(
        { Sid: 'AVeryLongSidThatGoesAway', Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::one/*' },
        { Sid: 'AnotherVeryLongSid', Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::two/*' },
    ));
    assert.match((await notes()).join('\n'), /characters shorter than the input/);
});

test('the normalize options are off by default and say what they cost', async () => {
    const policy = doc({ Effect: 'Allow', Action: 'ssm:GetParameter',
        Resource: 'arn:aws:ssm:ap-northeast-2:111122223333:parameter/x' });
    await normalize(policy);
    assert.match(await output(), /ap-northeast-2:111122223333/, 'left deployable by default');
    assert.doesNotMatch((await notes()).join('\n'), /not for deploying/);

    await normalize(policy, { account: true, region: true });
    assert.match(await output(), /<REGION>:<ACCOUNT>/);
    assert.match((await notes()).join('\n'), /not for deploying/);
});

test('the example loads and demonstrates the merge', async () => {
    await env.goto('iam-normalize.html');
    await env.page.click('#btn-iamn-example');
    const c = await chips();
    assert.ok(Number(c['blocks out']) < Number(c['statements in']),
        'the example is written so that normalizing it does something');
    assert.match((await notes()).join('\n'), /characters shorter than the input/);
});

test('Clear empties both sides', async () => {
    await normalize(doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }));
    assert.equal(await env.page.isVisible('#iamn-stats'), true);
    await env.page.click('#btn-iamn-clear');
    assert.equal(await env.page.inputValue('#iamn-in'), '');
    assert.equal(await env.page.isHidden('#iamn-stats'), true);
    assert.match(await output(), /Paste a policy above/);
});

// ------------------------------------------------------------
// Losslessness, checked against a different algorithm
// ------------------------------------------------------------
// Normalizing merges statements into blocks; the comparison expands them into
// one permission per Effect/Action/Resource/Principal/Condition. The two share
// no code, so running one against the other is a real check rather than the
// tool agreeing with itself. A weaker check — that the output reads back to the
// same blocks — only proves the merge is a fixed point of itself.
//
// Both passes are batched into one page load each: navigation dominates.

async function normalizeAll(policies) {
    await env.goto('iam-normalize.html');
    const out = [];
    for (const policy of policies) {
        await env.page.fill('#iamn-in', JSON.stringify(policy));
        await env.page.click('#btn-iamn-run');
        out.push(await env.page.textContent('#iamn-out'));
    }
    return out;
}

async function comparePermissions(policies, normalized) {
    await env.goto('iam-diff.html');
    await env.page.click('#iam-opt-matched');   // count what matched, not just what differs
    await env.page.click('#iam-opt-deny');      // off, so a Deny cannot hide a lost Allow
    const out = [];
    for (let i = 0; i < policies.length; i++) {
        // Comparing puts the inputs away; they have to come back to be refilled.
        if (await env.page.isHidden('#iam-split')) await env.page.click('#btn-iam-edit');
        await env.page.fill('#iam-a', JSON.stringify(policies[i]));
        await env.page.fill('#iam-b', normalized[i]);
        await env.page.click('#btn-iam-run');
        out.push(Object.fromEntries(await env.page.$$eval('.iam-chip', els => els.map(e => {
            const n = e.querySelector('b').textContent;
            return [e.textContent.slice(n.length).trim(), Number(n)];
        }))));
    }
    return out;
}

function lossReport(name, c) {
    // Every permission on each side has to be matched *exactly*. Accepting
    // "covered by a wider rule" would let a dropped s3:GetObject hide behind an
    // s3:* that happened to survive.
    const problems = [];
    if (c['only in A']) problems.push(c['only in A'] + ' permission(s) lost');
    if (c['only in B']) problems.push(c['only in B'] + ' permission(s) invented');
    if (c['condition differs']) problems.push(c['condition differs'] + ' condition(s) changed');
    if (c['covered by a wider rule']) problems.push(c['covered by a wider rule'] + ' matched only by a wildcard');
    if (c['identical'] !== c['permissions in A'] || c['identical'] !== c['permissions in B']) {
        problems.push('identical ' + c['identical'] + ' != A ' + c['permissions in A'] + ' / B ' + c['permissions in B']);
    }
    return problems.length ? name + ': ' + problems.join(', ') : null;
}

const SHAPES = {
    'duplicates and splits': { Version: '2012-10-17', Statement: [
        { Sid: 'a', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: 'arn:x' },
        { Sid: 'b', Effect: 'Allow', Action: 's3:GetObject', Resource: ['arn:x', 'arn:y'] },
        { Sid: 'c', Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject'], Resource: 'arn:x' }] },
    'an action shared between two groups': { Statement: [
        { Sid: 'web', Effect: 'Allow', Action: ['s3:DeleteObject', 's3:PutObject'], Resource: 'arn:site/*' },
        { Sid: 'backup', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: 'arn:backup/*' }] },
    'deny beside allow on the same scope': { Statement: [
        { Effect: 'Allow', Action: ['s3:*'], Resource: '*' },
        { Effect: 'Deny', Action: 's3:DeleteBucket', Resource: '*' },
        { Effect: 'Deny', Action: 's3:DeleteBucketPolicy', Resource: '*' }] },
    'conditions of several shapes': { Statement: [
        { Effect: 'Allow', Action: 'sts:AssumeRole', Resource: 'arn:r',
          Condition: { StringEquals: { 'sts:ExternalId': ['b', 'a'], 'aws:PrincipalAccount': '1' },
                       Bool: { 'aws:SecureTransport': 'true' } } },
        { Effect: 'Allow', Action: 'sts:AssumeRole', Resource: 'arn:r' },
        { Effect: 'Allow', Action: 'sts:TagSession', Resource: 'arn:r',
          Condition: { StringNotEquals: { 'aws:PrincipalTag/team': 'ops' } } }] },
    'NotAction and NotResource': { Statement: [
        { Effect: 'Allow', NotAction: ['iam:*', 'organizations:*'], Resource: '*' },
        { Effect: 'Deny', Action: 'ec2:*', NotResource: ['arn:allowed/*', 'arn:also/*'] },
        { Effect: 'Allow', Action: 'ec2:DescribeInstances', Resource: '*' }] },
    'a trust policy': { Statement: [
        { Effect: 'Allow', Principal: { Service: ['lambda.amazonaws.com', 'ec2.amazonaws.com'] }, Action: 'sts:AssumeRole' },
        { Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::111122223333:root' }, Action: ['sts:AssumeRole', 'sts:TagSession'] },
        { Effect: 'Deny', NotPrincipal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
    'the same action in two contexts': { Statement: [
        { Effect: 'Allow', Action: ['cloudtrail:LookupEvents', 'ec2:DescribeInstances'], Resource: '*' },
        { Effect: 'Allow', Action: 'cloudtrail:LookupEvents', Resource: '*',
          Condition: { StringEquals: { 'aws:RequestedRegion': 'ap-northeast-2' } } }] },
    'wildcards beside what they cover': { Statement: [
        { Effect: 'Allow', Action: ['s3:*', 's3:GetObject', 's3:Get*'], Resource: ['arn:a', 'arn:a/*', '*'] }] },
    'many statements on one scope': { Statement: Array.from({ length: 12 }, (_, i) => (
        { Sid: 's' + i, Effect: 'Allow', Action: 'svc:Action' + i, Resource: ['arn:one', 'arn:two'] })) },
};

test('normalizing loses and invents nothing, shape by shape', async () => {
    const names = Object.keys(SHAPES);
    const policies = names.map(n => SHAPES[n]);
    const counts = await comparePermissions(policies, await normalizeAll(policies));
    assert.deepEqual(names.map((n, i) => lossReport(n, counts[i])).filter(Boolean), []);
});

// A seeded generator, so a failure is reproducible rather than a flake.
function makePolicies(seed, count) {
    let state = seed;
    const next = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = list => list[Math.floor(next() * list.length) % list.length];
    const some = (list, max) => {
        const n = 1 + Math.floor(next() * max);
        const out = new Set();
        while (out.size < n) out.add(pick(list));
        return [...out];
    };
    const ACTIONS = ['s3:GetObject', 's3:PutObject', 's3:*', 'ec2:Describe*', 'ec2:RunInstances',
        'iam:PassRole', 'sts:AssumeRole', 'ssm:GetParameter'];
    const RESOURCES = ['*', 'arn:aws:s3:::one', 'arn:aws:s3:::one/*', 'arn:aws:s3:::two/*',
        'arn:aws:iam::111122223333:role/r', 'arn:aws:ssm:ap-northeast-2:111122223333:parameter/a/*'];
    const CONDITIONS = [null, null, null,
        { StringEquals: { 'aws:RequestedRegion': 'ap-northeast-2' } },
        { StringEquals: { 'aws:PrincipalTag/team': ['ops', 'dev'] } },
        { Bool: { 'aws:SecureTransport': 'true' } },
        { StringNotEquals: { 'aws:PrincipalAccount': '111122223333' } }];

    return Array.from({ length: count }, () => ({
        Version: '2012-10-17',
        Statement: Array.from({ length: 1 + Math.floor(next() * 6) }, (_, i) => {
            const st = { Sid: 'S' + i, Effect: next() < 0.8 ? 'Allow' : 'Deny' };
            if (next() < 0.9) st.Action = some(ACTIONS, 4);
            else st.NotAction = some(ACTIONS, 2);
            if (next() < 0.9) st.Resource = some(RESOURCES, 3);
            else st.NotResource = some(RESOURCES, 2);
            const cond = pick(CONDITIONS);
            if (cond) st.Condition = cond;
            return st;
        }),
    }));
}

test('normalizing loses and invents nothing, over generated policies', async () => {
    const policies = makePolicies(20260914, 14);
    const counts = await comparePermissions(policies, await normalizeAll(policies));
    const failures = counts
        .map((c, i) => lossReport('policy #' + i + ' ' + JSON.stringify(policies[i]).slice(0, 120), c))
        .filter(Boolean);
    assert.deepEqual(failures, []);
});

test('nothing on the page threw', () => {
    assert.deepEqual(env.errors, []);
});
