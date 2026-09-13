import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env.close(); });

const OPTIONS = {
    account: '#iam-opt-account',
    region: '#iam-opt-region',
    deny: '#iam-opt-deny',
    cond: '#iam-opt-cond',
    matched: '#iam-opt-matched',
    norm: '#iam-opt-norm',
};

const doc = (...statements) => JSON.stringify({ Version: '2012-10-17', Statement: statements });

async function compare(a, b, opts = {}) {
    await env.goto('iam-diff.html');
    if (opts.mode) await env.page.click(`#iam-mode button[data-mode="${opts.mode}"]`);
    for (const [key, sel] of Object.entries(OPTIONS)) {
        if (opts[key] === undefined) continue;
        if (await env.page.isChecked(sel) !== opts[key]) await env.page.click(sel);
    }
    await env.page.fill('#iam-a', typeof a === 'string' ? a : JSON.stringify(a));
    await env.page.fill('#iam-b', typeof b === 'string' ? b : JSON.stringify(b));
    await env.page.click('#btn-iam-run');
}

const verdict = () => env.page.textContent('#iam-verdict-title');

async function chips() {
    const pairs = await env.page.$$eval('.iam-chip', els => els.map(e => {
        const n = e.querySelector('b').textContent;
        return [e.textContent.slice(n.length).trim(), Number(n)];
    }));
    return Object.fromEntries(pairs);
}

async function rows() {
    return env.page.$$eval('#iam-rows tr', trs => trs.map(tr => {
        const td = tr.querySelectorAll('td');
        if (td.length < 5) return null;
        const tag = td[0].querySelector('.iam-tag');
        return {
            status: tag ? tag.textContent : '',
            effect: td[1].firstChild.textContent.trim(),
            action: td[2].childNodes[0].textContent.trim(),
            resource: td[3].childNodes[0].textContent.trim(),
            cond: td[4].textContent.trim(),
        };
    }).filter(Boolean));
}

const notes = () => env.page.$$eval('#iam-notes li', els => els.map(e => e.textContent));

// "As written" renders a side-by-side diff of the two normalized documents.
async function jsonDiff() {
    return env.page.$$eval('#iam-json-rows tr', trs => trs.map(tr => {
        const td = tr.querySelectorAll('td');
        if (td.length < 4) return null;
        const cell = c => (c.classList.contains('cell-empty') ? null : c.textContent);
        if (tr.classList.contains('block-head')) {
            return { kind: 'head', left: td[1].textContent, right: td[3].textContent };
        }
        return {
            kind: (tr.className.match(/row-(\w+)/) || [0, 'same'])[1],
            left: cell(td[1]),
            right: cell(td[3]),
        };
    }).filter(Boolean));
}

// The two sides as text, the way they read on screen.
async function jsonSides() {
    const rows = (await jsonDiff()).filter(r => r.kind !== 'head');
    return {
        left: rows.map(r => r.left).filter(l => l !== null).join('\n'),
        right: rows.map(r => r.right).filter(l => l !== null).join('\n'),
    };
}

const literal = { mode: 'literal' };

test('the same access split across statements compares equal', async () => {
    await compare(
        doc({ Sid: 'One', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: 'arn:aws:s3:::b/*' }),
        doc(
            { Sid: 'a-different-name', Effect: 'Allow', Action: 's3:PutObject', Resource: 'arn:aws:s3:::b/*' },
            { Sid: 'and-another', Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' },
        ));
    assert.equal(await verdict(), 'Same effective permissions');
    assert.deepEqual(await rows(), []);
    const c = await chips();
    assert.equal(c['permissions in A'], 2);
    assert.equal(c['permissions in B'], 2);
    assert.equal(c['identical'], 2);
    assert.equal(c['only in A'], 0);
    assert.equal(c['only in B'], 0);
});

test('duplicate statements collapse instead of counting twice', async () => {
    await compare(
        doc(
            { Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' },
            { Effect: 'Allow', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::b/*'] },
        ),
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' }));
    assert.equal(await verdict(), 'Same effective permissions');
    assert.equal((await chips())['permissions in A'], 1);
});

test('action case is ignored, the way IAM ignores it', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: 's3:getobject', Resource: 'arn:aws:s3:::b/*' }),
        doc({ Effect: 'Allow', Action: 'S3:GetObject', Resource: 'arn:aws:s3:::b/*' }));
    assert.equal(await verdict(), 'Same effective permissions');
});

test('resource case is not ignored, because an S3 key is case-sensitive', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/Key' }),
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/key' }));
    assert.equal(await verdict(), 'Each side grants something the other does not');
});

test('a wildcard covers what it matches, and not the other way round', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' }),
        doc({ Effect: 'Allow', Action: 's3:*', Resource: 'arn:aws:s3:::b/*' }));
    assert.equal(await verdict(), 'B grants everything A does — and more');
    const r = await rows();
    assert.deepEqual(r, [{
        status: 'Only in B', effect: 'Allow', action: 's3:*', resource: 'arn:aws:s3:::b/*', cond: '—',
    }]);

    await compare(
        doc({ Effect: 'Allow', Action: 's3:*', Resource: 'arn:aws:s3:::b/*' }),
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' }));
    assert.equal(await verdict(), 'A grants everything B does — and more');
});

test('a wildcard does not cover a wider wildcard', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: 's3:*', Resource: '*' }),
        doc({ Effect: 'Allow', Action: 's3:Get*', Resource: '*' }));
    assert.equal(await verdict(), 'A grants everything B does — and more');
    assert.equal((await chips())['only in A'], 1);
});

test('a resource prefix covers the objects under it', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/logs/2024/x.json' }),
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' }));
    assert.equal(await verdict(), 'B grants everything A does — and more');
});

test('? matches exactly one character', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: 'ec2:Describe?', Resource: '*' }),
        doc({ Effect: 'Allow', Action: 'ec2:Describe*', Resource: '*' }));
    assert.equal(await verdict(), 'B grants everything A does — and more');
});

test('containment holds when both sides carry wildcards', async () => {
    // Every string "x:a*b*c" produces also matches "x:a*c", but not the reverse:
    // "x:ac" matches the second and not the first.
    await compare(
        doc({ Effect: 'Allow', Action: 'x:a*b*c', Resource: '*' }),
        doc({ Effect: 'Allow', Action: 'x:a*c', Resource: '*' }));
    assert.equal(await verdict(), 'B grants everything A does — and more');

    await compare(
        doc({ Effect: 'Allow', Action: 'x:a*c', Resource: '*' }),
        doc({ Effect: 'Allow', Action: 'x:a*b*c', Resource: '*' }));
    assert.equal(await verdict(), 'A grants everything B does — and more');

    // A trailing * absorbs the rest; a ? cannot absorb a *.
    await compare(
        doc({ Effect: 'Allow', Action: 'ec2:*', Resource: 'arn:aws:ec2:*:*:instance/i-*' }),
        doc({ Effect: 'Allow', Action: 'ec2:*', Resource: 'arn:aws:ec2:*:*:instance/*' }));
    assert.equal(await verdict(), 'B grants everything A does — and more');

    await compare(
        doc({ Effect: 'Allow', Action: 'x:Get*', Resource: '*' }),
        doc({ Effect: 'Allow', Action: 'x:Get?', Resource: '*' }));
    assert.equal(await verdict(), 'A grants everything B does — and more');
});

test('covered rows are listed once Show matched is on', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' }),
        doc({ Effect: 'Allow', Action: 's3:*', Resource: 'arn:aws:s3:::b/*' }),
        { matched: true });
    const r = await rows();
    assert.ok(r.some(x => x.status === 'Only in B' && x.action === 's3:*'));
    assert.ok(r.some(x => x.status === 'Covered' && x.action === 's3:GetObject'),
        'the narrower grant shows as covered by the wider one');
});

test('an explicit Deny cancels the Allow it covers', async () => {
    const withDeny = doc(
        { Effect: 'Allow', Action: 's3:*', Resource: 'arn:aws:s3:::b/*' },
        { Effect: 'Deny', Action: 's3:*', Resource: 'arn:aws:s3:::b/*' });
    await compare(withDeny, doc({ Effect: 'Allow', Action: 's3:*', Resource: 'arn:aws:s3:::b/*' }));
    assert.equal(await verdict(), 'B grants everything A does — and more');
    const c = await chips();
    assert.equal(c['cancelled by a Deny'], 1);
    assert.equal(c['permissions in A'], 1, 'only the Deny row is left on A');

    // With the option off the Deny stops cancelling and becomes a row of its
    // own — and a Deny only A has still makes B the wider side.
    await compare(withDeny, doc({ Effect: 'Allow', Action: 's3:*', Resource: 'arn:aws:s3:::b/*' }), { deny: false });
    assert.equal(await verdict(), 'B grants everything A does — and more');
    const r = await rows();
    assert.deepEqual(r.map(x => [x.status, x.effect]), [['Only in A', 'Deny']]);
});

test('a Deny that covers only part of an Allow is flagged, not subtracted', async () => {
    await compare(
        doc(
            { Effect: 'Allow', Action: 's3:*', Resource: '*' },
            { Effect: 'Deny', Action: 's3:DeleteBucket', Resource: '*' }),
        doc({ Effect: 'Allow', Action: 's3:*', Resource: '*' }));
    const c = await chips();
    assert.equal(c['cancelled by a Deny'], undefined, 'nothing was cancelled');
    // A denies something B does not, so B is the wider side even though both
    // sides grant the same Allow.
    assert.equal(await verdict(), 'B grants everything A does — and more');
    assert.match((await notes()).join('\n'), /narrowed by a Deny that could not be subtracted/);
    // The Deny itself is the difference between the two sides.
    assert.deepEqual((await rows()).map(x => [x.status, x.effect, x.action]),
        [['Only in A', 'Deny', 's3:DeleteBucket']]);
});

test('a conditional Deny never cancels anything', async () => {
    await compare(
        doc(
            { Effect: 'Allow', Action: 's3:GetObject', Resource: '*' },
            {
                Effect: 'Deny', Action: 's3:GetObject', Resource: '*',
                Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            }),
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }));
    assert.equal((await chips())['cancelled by a Deny'], undefined);
    assert.match((await notes()).join('\n'), /could not be subtracted/);
});

test('account IDs and regions normalize away, and stop doing so when told', async () => {
    const a = doc({ Effect: 'Allow', Action: 'ssm:GetParameter', Resource: 'arn:aws:ssm:ap-northeast-2:111122223333:parameter/x' });
    const b = doc({ Effect: 'Allow', Action: 'ssm:GetParameter', Resource: 'arn:aws:ssm:us-east-1:999988887777:parameter/x' });
    await compare(a, b);
    assert.equal(await verdict(), 'Same effective permissions');

    await compare(a, b, { account: false });
    assert.equal(await verdict(), 'Each side grants something the other does not');

    await compare(a, b, { region: false });
    assert.equal(await verdict(), 'Each side grants something the other does not');
});

test('a condition on one side only is reported with its direction', async () => {
    await compare(
        doc({
            Effect: 'Allow', Action: 'sts:AssumeRole', Resource: 'arn:aws:iam::111122223333:role/r',
            Condition: { StringEquals: { 'sts:ExternalId': 'abc' } },
        }),
        doc({ Effect: 'Allow', Action: 'sts:AssumeRole', Resource: 'arn:aws:iam::111122223333:role/r' }));
    assert.equal(await verdict(), 'B grants everything A does — and more');
    const cell = await env.page.textContent('#iam-rows tr td:nth-child(5)');
    assert.match(cell, /A: \{"StringEquals"/);
    assert.match(cell, /B: \(none\)/);
    assert.match(cell, /A is narrower/);
});

test('more accepted values under the same key is wider', async () => {
    const mk = values => doc({
        Effect: 'Allow', Action: 'sts:AssumeRole', Resource: '*',
        Condition: { StringEquals: { 'aws:PrincipalTag/team': values } },
    });
    await compare(mk(['ops']), mk(['ops', 'dev']));
    assert.equal(await verdict(), 'Same actions and resources — the conditions differ');
    assert.match(await env.page.textContent('#iam-rows tr td:nth-child(5)'), /A is narrower/);

    // A ...Not... operator flips it: more values excluded is narrower.
    const mkNot = values => doc({
        Effect: 'Allow', Action: 'sts:AssumeRole', Resource: '*',
        Condition: { StringNotEquals: { 'aws:PrincipalTag/team': values } },
    });
    await compare(mkNot(['ops']), mkNot(['ops', 'dev']));
    assert.match(await env.page.textContent('#iam-rows tr td:nth-child(5)'), /B is narrower/);
});

test('a bare condition value and a one-element array are the same thing', async () => {
    await compare(
        doc({
            Effect: 'Allow', Action: 'sts:AssumeRole', Resource: '*',
            Condition: { StringEquals: { 'sts:ExternalId': 'abc' } },
        }),
        doc({
            Effect: 'Allow', Action: 'sts:AssumeRole', Resource: '*',
            Condition: { StringEquals: { 'sts:ExternalId': ['abc'] } },
        }));
    assert.equal(await verdict(), 'Same effective permissions');
});

test('key and value order inside a condition is not a difference', async () => {
    await compare(
        doc({
            Effect: 'Allow', Action: 'sts:AssumeRole', Resource: '*',
            Condition: { StringEquals: { 'aws:PrincipalTag/team': ['b', 'a'], 'aws:PrincipalAccount': '1' } },
        }),
        doc({
            Effect: 'Allow', Action: 'sts:AssumeRole', Resource: '*',
            Condition: { StringEquals: { 'aws:PrincipalAccount': '1', 'aws:PrincipalTag/team': ['a', 'b'] } },
        }));
    assert.equal(await verdict(), 'Same effective permissions');
});

test('Ignore conditions collapses a condition-only difference', async () => {
    await compare(
        doc({
            Effect: 'Allow', Action: 'sts:AssumeRole', Resource: '*',
            Condition: { StringEquals: { 'sts:ExternalId': 'abc' } },
        }),
        doc({ Effect: 'Allow', Action: 'sts:AssumeRole', Resource: '*' }),
        { cond: true });
    assert.equal(await verdict(), 'Same effective permissions');
    assert.match((await notes()).join('\n'), /Conditions are being ignored/);
});

test('NotAction is compared literally and says so', async () => {
    await compare(
        doc({ Effect: 'Allow', NotAction: 'iam:*', Resource: '*' }),
        doc({ Effect: 'Allow', NotAction: 'iam:*', Resource: '*' }));
    assert.equal(await verdict(), 'Same effective permissions');
    assert.match((await notes()).join('\n'), /NotAction or NotResource/);

    // It never collapses into the positive form, which would be a lie.
    await compare(
        doc({ Effect: 'Allow', NotAction: 'iam:*', Resource: '*' }),
        doc({ Effect: 'Allow', Action: '*', Resource: '*' }));
    assert.equal(await verdict(), 'Each side grants something the other does not');
});

test('a trust policy compares by principal', async () => {
    const trust = principal => doc({
        Effect: 'Allow', Principal: principal, Action: 'sts:AssumeRole',
    });
    await compare(trust({ AWS: 'arn:aws:iam::111122223333:root' }), trust({ AWS: 'arn:aws:iam::111122223333:root' }));
    assert.equal(await verdict(), 'Same effective permissions');

    await compare(trust({ Service: 'lambda.amazonaws.com' }), trust({ Service: 'ec2.amazonaws.com' }));
    assert.equal(await verdict(), 'Each side grants something the other does not');
    const r = await rows();
    assert.equal(r[0].resource, '—', 'a trust statement has no Resource');
    assert.match(await env.page.textContent('#iam-rows tr td:nth-child(4)'), /Principal: Service:/);
});

test('aws iam wrappers and a percent-encoded document are unwrapped', async () => {
    const policy = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }] };
    await compare(
        JSON.stringify({ RoleName: 'r', PolicyName: 'p', PolicyDocument: policy }),
        JSON.stringify({ PolicyVersion: { Document: policy, VersionId: 'v3', IsDefaultVersion: true } }));
    assert.equal(await verdict(), 'Same effective permissions');

    await compare(
        JSON.stringify({ Role: { RoleName: 'r', AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify(policy)) } }),
        JSON.stringify(policy));
    assert.equal(await verdict(), 'Same effective permissions');
});

test('several documents in a row are merged into one set', async () => {
    const a = doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }) +
        '\n' + doc({ Effect: 'Allow', Action: 's3:PutObject', Resource: '*' });
    await compare(a, doc(
        { Effect: 'Allow', Action: 's3:GetObject', Resource: '*' },
        { Effect: 'Allow', Action: 's3:PutObject', Resource: '*' }));
    assert.equal(await verdict(), 'Same effective permissions');
    assert.equal((await chips())['permissions in A'], 2);
});

test('bad input says what is wrong instead of comparing nothing', async () => {
    await compare('not json at all', doc({ Effect: 'Allow', Action: '*', Resource: '*' }));
    assert.equal(await env.page.isHidden('#iam-verdict'), true);
    assert.match(await env.page.textContent('#iam-error'), /A: a policy document has to start with/);

    await compare(JSON.stringify({ Version: '2012-10-17' }), doc({ Effect: 'Allow', Action: '*', Resource: '*' }));
    assert.match(await env.page.textContent('#iam-error'), /no policy document found/);
});

test('the normalized listing is one sorted line per permission', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject'], Resource: 'arn:aws:s3:::b/*' }),
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' }));
    assert.equal(await env.page.textContent('#iam-out-a'),
        'ALLOW  s3:GetObject  ->  arn:aws:s3:::b/*\nALLOW  s3:PutObject  ->  arn:aws:s3:::b/*');
    assert.equal(await env.page.textContent('#iam-out-b'),
        'ALLOW  s3:GetObject  ->  arn:aws:s3:::b/*');
});

test('the example loads, compares, and shows every kind of row', async () => {
    await env.goto('iam-diff.html');
    await env.page.click('#btn-iam-example');
    assert.equal(await verdict(), 'Each side grants something the other does not');
    const r = await rows();
    const statuses = new Set(r.map(x => x.status));
    assert.ok(statuses.has('Only in A'), 'A grants something B does not');
    assert.ok(statuses.has('Only in B'), 'B grants something A does not');
    assert.ok(statuses.has('Condition'), 'one row differs only by its condition');
    assert.ok(r.some(x => x.effect === 'Deny'), 'the Deny is a difference of its own');
    assert.match((await notes()).join('\n'), /narrowed by a Deny/);
});

test('Swap turns the verdict around', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }),
        doc({ Effect: 'Allow', Action: 's3:*', Resource: '*' }));
    assert.equal(await verdict(), 'B grants everything A does — and more');
    await env.page.click('#btn-iam-swap');
    assert.equal(await verdict(), 'A grants everything B does — and more');
});

// ------------------------------------------------------------
// "As written" — the same two documents, a different question
// ------------------------------------------------------------

test('as written: statements sharing a scope merge into one block', async () => {
    const a = doc({ Sid: 'One', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: 'arn:aws:s3:::b/*' });
    const b = doc(
        { Sid: 'x', Effect: 'Allow', Action: 's3:PutObject', Resource: 'arn:aws:s3:::b/*' },
        { Sid: 'y', Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' });
    await compare(a, b, literal);
    // How the actions were split across statements is layout, not content.
    assert.equal(await verdict(), 'Written the same');
    assert.equal((await chips())['blocks in B'], 1, 'two statements on one scope are one block');
    assert.deepEqual(await jsonDiff(), []);
});

test('as written: a block missing two actions shows two lines, not two blocks', async () => {
    // The case a whole-statement comparison got wrong: a long action list with a
    // couple of entries missing has to read as a couple of missing lines.
    const actions = [
        'autoscaling:AttachLoadBalancerTargetGroups',
        'autoscaling:CreateAutoScalingGroup',
        'autoscaling:DeleteScheduledAction',
        'autoscaling:DescribeAutoScalingGroups',
        'autoscaling:PutScheduledUpdateGroupAction',
        'autoscaling:UpdateAutoScalingGroup',
    ];
    const missing = ['autoscaling:DeleteScheduledAction', 'autoscaling:PutScheduledUpdateGroupAction'];
    await compare(
        doc({ Sid: 'Asg', Effect: 'Allow', Action: actions, Resource: '*' }),
        doc({ Sid: 'asg', Effect: 'Allow', Action: actions.filter(x => !missing.includes(x)), Resource: '*' }),
        literal);
    assert.equal(await verdict(), 'Matching blocks, with differences inside');
    assert.equal((await chips())['changed'], 1);

    const rows = (await jsonDiff()).filter(r => r.kind !== 'head');
    const changed = rows.filter(r => r.kind !== 'same');
    assert.equal(changed.length, 2, 'exactly the two actions that are missing');
    assert.deepEqual(changed.map(r => r.left.trim()), missing.map(x => `"${x}",`));
    assert.ok(changed.every(r => r.right === null));
    assert.ok(rows.length > 12, 'the rest of the block lined up as unchanged');
});

test('as written: each block is labelled with the Sid it was written under', async () => {
    await compare(
        doc({ Sid: 'Params', Effect: 'Allow', Action: ['ssm:GetParameter', 'ssm:PutParameter'], Resource: '*' }),
        doc(
            { Sid: 'p1', Effect: 'Allow', Action: 'ssm:GetParameter', Resource: '*' },
            { Sid: 'p2', Effect: 'Allow', Action: 'ssm:DeleteParameter', Resource: '*' }),
        literal);
    const head = (await jsonDiff()).find(r => r.kind === 'head');
    assert.equal(head.left, 'Sid: Params');
    assert.equal(head.right, 'Sid: p1, p2', 'a merged block names every statement it came from');
});

test('as written: formatting, ordering, duplicates and Sid are forgiven', async () => {
    await compare(
        doc(
            { Sid: 'first', Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject'], Resource: ['arn:aws:s3:::b/*'] },
            { Sid: 'second', Effect: 'Allow', Action: 'sts:AssumeRole', Resource: '*' },
            { Sid: 'a-duplicate', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: 'arn:aws:s3:::b/*' },
        ),
        doc(
            { Effect: 'Allow', Resource: '*', Action: 'sts:AssumeRole' },
            { Resource: 'arn:aws:s3:::b/*', Action: ['s3:GetObject', 's3:PutObject', 's3:GetObject'], Effect: 'Allow' },
        ),
        literal);
    assert.equal(await verdict(), 'Written the same');
    assert.deepEqual(await jsonDiff(), [], 'identical blocks are collapsed by default');
    assert.match(await env.page.textContent('#iam-empty'), /tick Show matched/);
    assert.equal((await chips())['blocks in A'], 2);
});

test('as written: Show matched prints both documents in full', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }),
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }),
        { mode: 'literal', matched: true });
    const rows = (await jsonDiff()).filter(r => r.kind !== 'head');
    assert.ok(rows.length > 0);
    assert.ok(rows.every(r => r.kind === 'same' && r.left === r.right));
});

test('as written: a wildcard is never expanded', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: 's3:*', Resource: '*' }),
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }),
        literal);
    // Same scope, so it is one block with one line that differs — where the
    // Effective mode would call this "A grants everything B does".
    assert.equal(await verdict(), 'Matching blocks, with differences inside');
    const changed = (await jsonDiff()).filter(r => r.kind !== 'head' && r.kind !== 'same');
    assert.deepEqual(changed.map(r => [r.left && r.left.trim(), r.right && r.right.trim()]),
        [['"s3:*"', '"s3:GetObject"']]);
    assert.equal((await chips())['covered by a wider rule'], undefined, 'no coverage reasoning in this mode');
    assert.match((await notes()).join('\n'), /Wildcards and Deny are not interpreted/);
});

test('as written: an Allow is never paired with a Deny, and the option goes away', async () => {
    await compare(
        doc(
            { Effect: 'Allow', Action: 's3:*', Resource: 'arn:aws:s3:::b/*' },
            { Effect: 'Deny', Action: 's3:*', Resource: 'arn:aws:s3:::b/*' }),
        doc({ Effect: 'Allow', Action: 's3:*', Resource: 'arn:aws:s3:::b/*' }),
        literal);
    assert.equal(await env.page.isHidden('#iam-deny-option'), true);
    assert.equal(await verdict(), 'A has every block B has — and more');
    const rows = (await jsonDiff()).filter(r => r.kind !== 'head');
    assert.ok(rows.every(r => r.kind === 'del'), 'only the Deny block is left');
    assert.match(rows.map(r => r.left).join('\n'), /"Effect": "Deny"/);
    const c = await chips();
    assert.equal(c['blocks in A'], 2, 'the Allow was not cancelled');
    assert.equal(c['cancelled by a Deny'], undefined);
});

test('as written: a block whose Condition changed still lands opposite its counterpart', async () => {
    await compare(
        doc({
            Effect: 'Allow', Action: 'sts:AssumeRole', Resource: '*',
            Condition: { StringEquals: { 'sts:ExternalId': 'abc' } },
        }),
        doc({ Effect: 'Allow', Action: 'sts:AssumeRole', Resource: '*' }),
        literal);
    assert.equal(await verdict(), 'Matching blocks, with differences inside');
    assert.equal((await chips())['changed'], 1);
    const rows = (await jsonDiff()).filter(r => r.kind !== 'head');
    const changed = rows.filter(r => r.kind !== 'same');
    assert.ok(changed.length > 0 && changed.length < rows.length, 'a diff, not two whole blocks');
    assert.match(changed.map(r => r.left).join('\n'), /"Condition"/);
    assert.ok(changed.every(r => r.right === null || !/"Condition"/.test(r.right)));
});

test('as written: a shared resource is not enough to pair two different actions', async () => {
    // Account normalization can make two unrelated blocks name the same role ARN.
    // That plus a shared Effect used to be enough to pair them — and the block
    // that genuinely matched was then reported as having no counterpart at all.
    const role = 'arn:aws:iam::111122223333:role/Role-Deploy';
    await compare(
        doc(
            { Sid: 'AssumeConnectRoles', Effect: 'Allow', Action: 'sts:AssumeRole',
              Resource: [role, 'arn:aws:iam::111122223333:role/Role-Deploy-Worker'] },
            { Sid: 'PreflightSimulateMachineRoles', Effect: 'Allow', Action: 'iam:SimulatePrincipalPolicy',
              Resource: [role, 'arn:aws:iam::111122223333:role/Role-Worker-Prod-*', 'arn:aws:iam::111122223333:role/service-*'] },
        ),
        doc({ Sid: 'PreflightSimulate', Effect: 'Allow', Action: 'iam:SimulatePrincipalPolicy',
              Resource: [role, 'arn:aws:iam::111122223333:role/service-*'] }),
        literal);

    const pairs = (await jsonDiff()).filter(r => r.kind === 'head').map(h => [h.left, h.right]);
    assert.deepEqual(pairs.find(pr => pr[1] === 'Sid: PreflightSimulate'),
        ['Sid: PreflightSimulateMachineRoles', 'Sid: PreflightSimulate'],
        'the block with the same action takes the counterpart');
    assert.deepEqual(pairs.find(pr => pr[0] === 'Sid: AssumeConnectRoles'),
        ['Sid: AssumeConnectRoles', ''],
        'no action in common, so no counterpart at all');

    // The one line that really differs is the resource B does not list.
    const changed = (await jsonDiff()).filter(r => r.kind === 'del' && /Role-Worker-Prod/.test(r.left || ''));
    assert.equal(changed.length, 1);
});

test('as written: the best counterpart wins, not the first one to ask for it', async () => {
    await compare(
        doc(
            // sorts first, resembles the B block only through its action
            { Sid: 'Weak', Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::x/*',
              Condition: { StringEquals: { 'aaa:key': 'v' } } },
            // sorts second, but shares the action and two of three resources
            { Sid: 'Strong', Effect: 'Allow', Action: 's3:GetObject',
              Resource: ['arn:aws:s3:::b/*', 'arn:aws:s3:::c/*', 'arn:aws:s3:::d/*'],
              Condition: { StringEquals: { 'zzz:key': 'v' } } },
        ),
        doc({ Sid: 'Target', Effect: 'Allow', Action: 's3:GetObject',
              Resource: ['arn:aws:s3:::b/*', 'arn:aws:s3:::c/*'] }),
        literal);

    const pairs = (await jsonDiff()).filter(r => r.kind === 'head').map(h => [h.left, h.right]);
    assert.deepEqual(pairs.find(pr => pr[1] === 'Sid: Target'), ['Sid: Strong', 'Sid: Target']);
    assert.deepEqual(pairs.find(pr => pr[0] === 'Sid: Weak'), ['Sid: Weak', '']);
});

test('as written: blocks too different to be the same thing stay apart', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: 'ec2:DescribeInstances', Resource: '*' }),
        doc({ Effect: 'Allow', Action: 'dynamodb:PutItem', Resource: 'arn:aws:dynamodb:<REGION>:<ACCOUNT>:table/t' }),
        literal);
    assert.equal(await verdict(), 'Written differently');
    const c = await chips();
    assert.equal(c['only in A'], 1);
    assert.equal(c['only in B'], 1);
    assert.equal(c['changed'], 0, 'nothing in common, so nothing was forced into a pair');
});

test('as written: account and region normalization still applies', async () => {
    const a = doc({ Effect: 'Allow', Action: 'ssm:GetParameter', Resource: 'arn:aws:ssm:ap-northeast-2:111122223333:parameter/x' });
    const b = doc({ Effect: 'Allow', Action: 'ssm:GetParameter', Resource: 'arn:aws:ssm:us-east-1:999988887777:parameter/x' });
    await compare(a, b, literal);
    assert.equal(await verdict(), 'Written the same');

    await compare(a, b, { mode: 'literal', account: false });
    assert.equal(await verdict(), 'Matching blocks, with differences inside');
    const changed = (await jsonDiff()).filter(r => r.kind !== 'head' && r.kind !== 'same');
    assert.equal(changed.length, 1, 'only the resource line differs');
    assert.match(changed[0].left, /111122223333/);
    assert.match(changed[0].right, /999988887777/);
});

test('as written: a trust policy keeps its Principal and has no Resource', async () => {
    await compare(
        doc({ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }),
        doc({ Effect: 'Allow', Principal: { Service: ['ec2.amazonaws.com'] }, Action: 'sts:AssumeRole' }),
        literal);
    const sides = await jsonSides();
    assert.match(sides.left, /"Principal": \{\n    "Service": \[\n      "lambda.amazonaws.com"\n    \]\n  \}/);
    assert.ok(!/"Resource"/.test(sides.left), 'a trust statement has no Resource');
    const changed = (await jsonDiff()).filter(r => r.kind !== 'head' && r.kind !== 'same');
    assert.deepEqual(changed.map(r => [r.left.trim(), r.right.trim()]),
        [['"lambda.amazonaws.com"', '"ec2.amazonaws.com"']]);
});

test('as written: the listing is the normalized blocks as JSON', async () => {
    await compare(
        doc(
            { Sid: 'dropped', Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject'], Resource: 'arn:aws:s3:::b/*' },
            { Sid: 'also-dropped', Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' }),
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' }),
        literal);
    const out = JSON.parse(await env.page.textContent('#iam-out-a'));
    assert.deepEqual(out, {
        Version: '2012-10-17',
        Statement: [{
            Effect: 'Allow',
            Action: ['s3:GetObject', 's3:PutObject'],
            Resource: ['arn:aws:s3:::b/*'],
        }],
    }, 'a policy document: merged onto one scope, sorted, deduplicated, Sid dropped');
});

test('switching modes re-answers the question without retyping', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: 's3:*', Resource: '*' }),
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }));
    assert.equal(await verdict(), 'A grants everything B does — and more');
    assert.equal(await env.page.isHidden('#iam-table-wrap'), false);

    await env.page.click('#iam-mode button[data-mode="literal"]');
    assert.equal(await verdict(), 'Matching blocks, with differences inside');
    assert.equal(await env.page.isHidden('#iam-table-wrap'), true);
    assert.equal(await env.page.isHidden('#iam-json-wrap'), false);

    await env.page.click('#iam-mode button[data-mode="effective"]');
    assert.equal(await verdict(), 'A grants everything B does — and more');
    assert.equal(await env.page.isHidden('#iam-json-wrap'), true);
});

test('as written: an action that only moved scope is paired, not dropped', async () => {
    // A lists cloudtrail:LookupEvents in the big Resource:"*" block; B lists it
    // alone under a Region condition. Merged by scope, A's line reads as removed
    // and B's block as unrelated — so it is lifted out on both sides instead.
    await compare(
        doc(
            { Sid: 'ReadOnly', Effect: 'Allow', Action: ['ec2:DescribeInstances', 'iam:GetRole'], Resource: '*' },
            { Sid: 'Audit', Effect: 'Allow', Action: 'cloudtrail:LookupEvents', Resource: '*' }),
        doc(
            { Sid: 'readonly', Effect: 'Allow', Action: ['ec2:DescribeInstances', 'iam:GetRole'], Resource: '*' },
            { Sid: 'audit', Effect: 'Allow', Action: 'cloudtrail:LookupEvents', Resource: '*',
              Condition: { StringEquals: { 'aws:RequestedRegion': 'ap-northeast-2' } } }),
        literal);

    const pairs = (await jsonDiff()).filter(r => r.kind === 'head').map(h => [h.left, h.right]);
    assert.deepEqual(pairs.find(pr => pr[0] === 'Sid: Audit'), ['Sid: Audit', 'Sid: audit'],
        'the re-scoped action is paired with its counterpart');
    assert.match((await notes()).join('\n'), /never under the same condition/);

    // And the diff on that pair is the condition that was added.
    const changed = (await jsonDiff()).filter(r => r.kind === 'ins');
    assert.ok(changed.some(r => /"Condition"/.test(r.right)));
    assert.ok(changed.every(r => r.left === null));
});

test('as written: an action sharing a context is not treated as moved', async () => {
    // Granted unconditionally on both sides and, on A, a second time under a
    // condition. The shared context means it did not move, so the block the two
    // sides have in common is left intact and the extra grant stands alone.
    await compare(
        doc(
            { Sid: 'Plain', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: '*' },
            { Sid: 'Guarded', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: '*',
              Condition: { StringEquals: { 'aws:PrincipalTag/team': 'ops' } } }),
        doc({ Sid: 'plain', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: '*' }),
        { mode: 'literal', matched: true });
    assert.equal(await verdict(), 'A has every block B has — and more');
    assert.doesNotMatch((await notes()).join('\n'), /never under the same condition/);
    const heads = (await jsonDiff()).filter(r => r.kind === 'head');
    assert.deepEqual(heads.map(h => [h.left, h.right]), [
        ['Sid: Guarded', ''],
        ['Sid: Plain', 'Sid: plain'],
    ]);
    assert.equal((await chips())['identical'], 1, 'the unconditional block matched exactly');
});

test('as written: blocks come from the relation, not from statement boundaries', async () => {
    // The same (action, resource) pairs, split two ways and joined one way.
    await compare(
        doc(
            { Sid: 'split1', Effect: 'Allow', Action: ['ec2:A', 'ec2:B'], Resource: 'arn:x' },
            { Sid: 'split2', Effect: 'Allow', Action: ['ec2:A', 'ec2:B'], Resource: 'arn:y' }),
        doc({ Sid: 'joined', Effect: 'Allow', Action: ['ec2:A', 'ec2:B'], Resource: ['arn:x', 'arn:y'] }),
        literal);
    assert.equal(await verdict(), 'Written the same');
    const c = await chips();
    assert.equal(c['blocks in A'], 1, 'two statements, one relation, one block');
    assert.equal(c['blocks in B'], 1);
});

test('as written: an action used in two places stays with the group it was written in', async () => {
    // The regression that made re-deriving blocks from the relation unusable:
    // s3:PutObject is granted on a backup prefix and, separately, on a website
    // bucket. Pooling its resources pulls it out of the backup group, and a block
    // that matches the other side exactly gets reported as missing an action.
    const BACKUP = ['s3:AbortMultipartUpload', 's3:GetObject', 's3:PutObject'];
    await compare(
        doc(
            { Sid: 'WebUpload', Effect: 'Allow', Action: ['s3:DeleteObject', 's3:PutObject', 's3:PutObjectAcl'],
              Resource: 'arn:aws:s3:::site.example.com/*' },
            { Sid: 'BackupObjects', Effect: 'Allow', Action: BACKUP, Resource: 'arn:aws:s3:::backup/*' }),
        doc({ Sid: 'backup', Effect: 'Allow', Action: BACKUP, Resource: 'arn:aws:s3:::backup/*' }),
        { mode: 'literal', matched: true });

    assert.equal(await verdict(), 'A has every block B has — and more');
    assert.equal((await chips())['identical'], 1);
    const heads = (await jsonDiff()).filter(r => r.kind === 'head').map(h => [h.left, h.right]);
    assert.deepEqual(heads, [
        ['Sid: WebUpload', ''],            // differences sort first
        ['Sid: BackupObjects', 'Sid: backup'],
    ], 'the backup block matched whole; the website grant stands on its own');
    assert.deepEqual(JSON.parse(await env.page.textContent('#iam-out-a')).Statement, [
        { Effect: 'Allow', Action: BACKUP, Resource: ['arn:aws:s3:::backup/*'] },
        { Effect: 'Allow', Action: ['s3:DeleteObject', 's3:PutObject', 's3:PutObjectAcl'],
          Resource: ['arn:aws:s3:::site.example.com/*'] },
    ]);
});

test('as written: the two merge rules run until nothing more merges', async () => {
    // Same scope, different actions -> one block; same actions, different scope
    // -> one block. Applying either can enable the other, so both repeat.
    await compare(
        doc(
            { Effect: 'Allow', Action: 'ec2:A', Resource: 'arn:x' },
            { Effect: 'Allow', Action: 'ec2:B', Resource: 'arn:x' },
            { Effect: 'Allow', Action: ['ec2:A', 'ec2:B'], Resource: 'arn:y' }),
        doc({ Effect: 'Allow', Action: ['ec2:A', 'ec2:B'], Resource: ['arn:x', 'arn:y'] }),
        literal);
    assert.equal(await verdict(), 'Written the same');
    assert.deepEqual(JSON.parse(await env.page.textContent('#iam-out-a')).Statement, [
        { Effect: 'Allow', Action: ['ec2:A', 'ec2:B'], Resource: ['arn:x', 'arn:y'] },
    ], 'the scope rule merged x, which let the action rule merge y');
});

test('as written: a resource added under the same condition is one changed line', async () => {
    // The shape that made this tool worth fixing: one side grants a set of actions
    // on one resource, the other grants the same set on that resource and a second
    // one, and a third statement grants most of them unconditioned elsewhere.
    const EIGHT = ['ec2:AuthorizeSecurityGroupIngress', 'ec2:DeleteSecurityGroup', 'ec2:ModifySecurityGroupRules'];
    const COND = { StringEquals: { 'aws:ResourceTag/ManagedBy': 'terraform' } };
    await compare(
        doc(
            { Sid: 'SGManageOwn', Effect: 'Allow', Action: EIGHT, Resource: 'arn:sg/*', Condition: COND },
            { Sid: 'SGRuleAccess', Effect: 'Allow', Action: EIGHT.slice(0, 2), Resource: 'arn:sgr/*' }),
        doc({ Sid: 'SgManageOwn', Effect: 'Allow', Action: EIGHT, Resource: ['arn:sg/*', 'arn:sgr/*'], Condition: COND }),
        literal);

    const heads = (await jsonDiff()).filter(r => r.kind === 'head');
    assert.deepEqual(heads.map(h => [h.left, h.right]), [
        ['Sid: SGManageOwn', 'Sid: SgManageOwn'],
        ['Sid: SGRuleAccess', ''],
    ], 'the conditioned block pairs whole; the unconditioned grant stands alone');

    // And that pairing differs by exactly the resource B added.
    const rows = await jsonDiff();
    const firstBlock = rows.slice(1, rows.findIndex((r, i) => i > 0 && r.kind === 'head'));
    const changed = firstBlock.filter(r => r.kind !== 'same');
    assert.equal(changed.length, 2, 'the inserted resource, and the comma it puts on the line above');
    assert.deepEqual(changed.map(r => r.kind), ['chg', 'ins']);
    assert.match(changed[1].right, /"arn:sgr\/\*"/);
    assert.equal(changed[1].left, null);
});

test('a changed line marks only the part that actually changed', async () => {
    // Adding a second resource puts a comma on the line before it. The line is
    // changed, but only that one character is.
    await compare(
        doc({ Effect: 'Allow', Action: 'ec2:A', Resource: 'arn:x' }),
        doc({ Effect: 'Allow', Action: 'ec2:A', Resource: ['arn:x', 'arn:y'] }),
        literal);
    const marks = await env.page.$$eval('#iam-json-rows tr.row-chg td.side', tds =>
        tds.map(td => [...td.querySelectorAll('.iam-tok')].map(m => m.textContent)));
    assert.deepEqual(marks, [[], [',']], 'nothing marked on the left, the comma on the right');

    // The rest of that line is outside the mark, so it does not read as changed.
    const row = await env.page.textContent('#iam-json-rows tr.row-chg td.side.old');
    assert.match(row, /"arn:x"/);
});

test('a changed value marks the value, not the punctuation around it', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: 'ec2:DescribeInstances', Resource: '*' }),
        doc({ Effect: 'Allow', Action: 'ec2:DescribeRegions', Resource: '*' }),
        literal);
    const marks = await env.page.$$eval('#iam-json-rows tr.row-chg td.side', tds =>
        tds.map(td => [...td.querySelectorAll('.iam-tok')].map(m => m.textContent).join('')));
    assert.deepEqual(marks, ['DescribeInstances', 'DescribeRegions'],
        'the shared ec2: prefix and the quotes stay unmarked');
});

test('two unrelated lines are not marked token by token', async () => {
    // Only quotes, a colon and a comma in common — marking every word on both
    // sides would be noise, and the row tint already says it was replaced.
    await compare(
        doc({ Effect: 'Allow', Action: ['ec2:DescribeInstances', 'zzz:Last'], Resource: '*' }),
        doc({ Effect: 'Allow', Action: ['s3:GetObject', 'zzz:Last'], Resource: '*' }),
        literal);
    const marks = await env.page.$$eval('#iam-json-rows tr.row-chg .iam-tok', e => e.length);
    assert.equal(marks, 0);
});

test('the normalized policy can be pasted straight back in', async () => {
    // The obvious way to check a normalization is to feed it back and see that
    // nothing moves. That only works if the listing is a document, not an array.
    const original = doc(
        { Sid: 'One', Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject'], Resource: 'arn:aws:s3:::b/*' },
        { Sid: 'Two', Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' });
    await compare(original, original, literal);
    const normalized = await env.page.textContent('#iam-out-a');
    assert.match(normalized, /^\{\n  "Version": "2012-10-17",\n  "Statement": \[/);

    await compare(original, normalized, literal);
    assert.equal(await verdict(), 'Written the same');
    assert.equal(await env.page.isHidden('#iam-error'), true);
});

test('a bare Statement array is read as a policy', async () => {
    const statements = JSON.stringify([
        { Effect: 'Allow', Action: 's3:GetObject', Resource: '*' },
    ]);
    await compare(statements, doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }), literal);
    assert.equal(await verdict(), 'Written the same');

    // An array of policy documents still reads as documents, not statements.
    await compare(
        JSON.stringify([doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' })].map(JSON.parse)),
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }),
        literal);
    assert.equal(await verdict(), 'Written the same');
});

test('the normalized listing is off until asked for', async () => {
    // A second copy of both documents doubles everything Ctrl+F turns up, so it
    // stays out of the way until it is wanted.
    await compare(
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }),
        doc({ Effect: 'Allow', Action: 's3:PutObject', Resource: '*' }));
    assert.equal(await env.page.isHidden('#iam-norm'), true);
    // Still filled in, so turning it on costs nothing.
    assert.match(await env.page.textContent('#iam-out-a'), /s3:GetObject/);

    await env.page.click('#iam-opt-norm');
    assert.equal(await env.page.isVisible('#iam-norm'), true);
    assert.match(await env.page.textContent('#iam-out-b'), /s3:PutObject/);

    await env.page.click('#iam-opt-norm');
    assert.equal(await env.page.isHidden('#iam-norm'), true);
});

test('blocks dropped for matching are counted, and can be brought back', async () => {
    // An action can sit in a block that matched exactly, in which case it is not
    // in the diff at all. Without this marker there is nothing to explain why a
    // line in the listing below cannot be found above it.
    await compare(
        doc(
            { Sid: 'Same', Effect: 'Allow', Action: 'elasticloadbalancing:AddTags', Resource: 'arn:tg/*' },
            { Sid: 'ExtraA', Effect: 'Allow', Action: 'ec2:OnlyInA', Resource: '*' }),
        doc({ Sid: 'same', Effect: 'Allow', Action: 'elasticloadbalancing:AddTags', Resource: 'arn:tg/*' }),
        literal);

    const hasTag = () => env.page.$$eval('#iam-json-rows td.side',
        tds => tds.filter(td => td.textContent.includes('elasticloadbalancing:AddTags')).length);
    assert.equal(await hasTag(), 0, 'the matching block is not in the diff');
    assert.equal(await env.page.isVisible('#iam-fold'), true);
    assert.match(await env.page.textContent('#btn-iam-show-matched'), /^1 identical blocks hidden/);

    await env.page.click('#btn-iam-show-matched');
    assert.equal(await env.page.isChecked('#iam-opt-matched'), true);
    assert.equal(await hasTag(), 2, 'both sides of it are back');
    assert.equal(await env.page.isHidden('#iam-fold'), true, 'nothing is hidden any more');
});

test('the fold marker counts matched permissions in the other mode too', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: '*' }),
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }));
    assert.match(await env.page.textContent('#btn-iam-show-matched'), /^1 matching permissions hidden/);
    await env.page.click('#btn-iam-show-matched');
    const tags = await env.page.$$eval('#iam-rows .iam-tag', e => e.map(x => x.textContent));
    assert.deepEqual(tags.sort(), ['Identical', 'Only in A']);
});

// ------------------------------------------------------------
// Effective permissions: reading one comparison along three axes
// ------------------------------------------------------------

async function groups() {
    return env.page.$$eval('#iam-rows tr', trs => {
        const out = [];
        let cur = null;
        for (const tr of trs) {
            if (tr.classList.contains('iam-group')) {
                cur = { key: tr.querySelector('.iam-group-key').textContent, counts: tr.querySelector('.iam-group-counts').textContent.trim(), rows: 0 };
                out.push(cur);
                continue;
            }
            if (cur && tr.querySelectorAll('td').length >= 5) cur.rows++;
        }
        return out;
    });
}

test('grouping gathers the same comparison under each axis', async () => {
    await compare(
        doc(
            { Effect: 'Allow', Action: 's3:GetObject', Resource: ['arn:a/*', 'arn:b/*'] },
            { Effect: 'Allow', Action: 's3:PutObject', Resource: 'arn:a/*' }),
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:a/*' }));
    // Combined is the default and has no group headers.
    assert.deepEqual(await groups(), []);
    assert.equal((await rows()).length, 2, 's3:GetObject on b/* and s3:PutObject on a/*');

    await env.page.click('#iam-group button[data-group="action"]');
    assert.deepEqual((await groups()).map(g => [g.key, g.rows]), [
        ['s3:GetObject', 1],
        ['s3:PutObject', 1],
    ]);

    await env.page.click('#iam-group button[data-group="resource"]');
    assert.deepEqual((await groups()).map(g => [g.key, g.rows]), [
        ['arn:a/*', 1],
        ['arn:b/*', 1],
    ]);

    await env.page.click('#iam-group button[data-group=""]');
    assert.deepEqual(await groups(), [], 'back to the flat table');
});

test('a group header counts what is under it', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: ['arn:a/*', 'arn:b/*'] }),
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: ['arn:a/*', 'arn:c/*'] }),
        { matched: true });
    await env.page.click('#iam-group button[data-group="action"]');
    const g = await groups();
    assert.equal(g.length, 1);
    assert.equal(g[0].key, 's3:GetObject');
    assert.match(g[0].counts, /1 only in A/);
    assert.match(g[0].counts, /1 only in B/);
    assert.match(g[0].counts, /1 matched/);
    assert.equal(g[0].rows, 3);
});

test('grouping by condition separates the guarded rows from the rest', async () => {
    await compare(
        doc(
            { Effect: 'Allow', Action: 'sts:AssumeRole', Resource: 'arn:r1',
              Condition: { StringEquals: { 'sts:ExternalId': 'abc' } } },
            { Effect: 'Allow', Action: 'sts:AssumeRole', Resource: 'arn:r2' }),
        doc({ Effect: 'Allow', Action: 'sts:AssumeRole', Resource: 'arn:r3' }),
    );
    await env.page.click('#iam-group button[data-group="condition"]');
    const keys = (await groups()).map(g => g.key);
    assert.equal(keys.length, 2);
    assert.ok(keys.includes('—'), 'the unconditioned rows gather under a dash');
    assert.ok(keys.some(k => k.includes('sts:ExternalId')), 'the guarded row under its condition');
});

test('the view tabs are only for the permission table', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }),
        doc({ Effect: 'Allow', Action: 's3:PutObject', Resource: '*' }));
    assert.equal(await env.page.isVisible('#iam-views'), true);
    await env.page.click('#iam-mode button[data-mode="literal"]');
    assert.equal(await env.page.isHidden('#iam-views'), true);
    await env.page.click('#iam-mode button[data-mode="effective"]');
    assert.equal(await env.page.isVisible('#iam-views'), true);
});

// ------------------------------------------------------------
// Selecting and copying one side of the diff
// ------------------------------------------------------------

// What the clipboard would receive for the current selection.
const copied = () => env.page.evaluate(() => {
    const dt = new DataTransfer();
    document.getElementById('iam-result')
        .dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
    return dt.getData('text/plain');
});

// A range over the whole table, anchored where asked — what a browser that
// ignores user-select:none hands over.
const selectAll = (anchor) => env.page.evaluate(side => {
    const rows = document.getElementById('iam-json-rows');
    const sel = document.getSelection();
    const range = document.createRange();
    if (side) {
        const cells = rows.querySelectorAll('td.side.' + side);
        range.setStart(cells[0], 0);
        const last = cells[cells.length - 1];
        range.setEnd(last, last.childNodes.length);
    } else {
        range.selectNodeContents(rows);
    }
    sel.removeAllRanges();
    sel.addRange(range);
    return sel.toString();
}, anchor);

async function twoSidedDiff() {
    await compare(
        doc({ Sid: 'LT', Effect: 'Allow', Action: ['ec2:Alpha', 'ec2:Bravo'], Resource: 'arn:one' }),
        doc({ Sid: 'lt', Effect: 'Allow', Action: ['ec2:Alpha', 'ec2:Delta'], Resource: 'arn:one' }),
        literal);
}

test('copying a selection in one column gives that column alone', async () => {
    await twoSidedDiff();
    const raw = await selectAll('old');
    assert.match(raw, /ec2:Bravo/);

    const text = await copied();
    assert.deepEqual(JSON.parse(text), {
        Effect: 'Allow', Action: ['ec2:Alpha', 'ec2:Bravo'], Resource: ['arn:one'],
    }, 'the A column on its own, and still valid JSON');
    assert.ok(!text.includes('ec2:Delta'), 'nothing from B');
    assert.ok(!/^\s*\d+\s/m.test(text), 'no line numbers');
    assert.ok(!text.includes('Sid:'), 'no block annotation');

    await selectAll('new');
    const fromB = await copied();
    assert.deepEqual(JSON.parse(fromB).Action, ['ec2:Alpha', 'ec2:Delta']);
    assert.ok(!fromB.includes('ec2:Bravo'));
});

test('a selection anchored outside a cell falls back to the A side', async () => {
    await twoSidedDiff();
    await selectAll(null);          // the whole table, anchored on the tbody
    assert.deepEqual(JSON.parse(await copied()).Action, ['ec2:Alpha', 'ec2:Bravo']);
});

test('pressing in one column marks the table so the other stops selecting', async () => {
    await twoSidedDiff();
    const cls = async () => env.page.$eval('.iam-json', t => t.className);

    const a = await env.page.locator('#iam-json-rows td.side.old').nth(1).boundingBox();
    await env.page.mouse.move(a.x + 5, a.y + 3);
    await env.page.mouse.down();
    await env.page.mouse.up();
    assert.match(await cls(), /pick-old/);

    const b = await env.page.locator('#iam-json-rows td.side.new').nth(1).boundingBox();
    await env.page.mouse.move(b.x + 5, b.y + 3);
    await env.page.mouse.down();
    await env.page.mouse.up();
    assert.match(await cls(), /pick-new/);
    assert.doesNotMatch(await cls(), /pick-old/);
});

test('a selection outside the diff is copied normally', async () => {
    await twoSidedDiff();
    await env.page.evaluate(() => {
        const sel = document.getSelection();
        const range = document.createRange();
        range.selectNodeContents(document.getElementById('iam-mode-hint'));
        sel.removeAllRanges();
        sel.addRange(range);
    });
    assert.equal(await copied(), '', 'the handler declined, so the browser does it');
});

test('comparing puts the inputs away, and Edit brings them back', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }),
        doc({ Effect: 'Allow', Action: 's3:PutObject', Resource: '*' }));
    assert.equal(await env.page.isHidden('#iam-split'), true);
    assert.equal(await env.page.isHidden('#btn-iam-run'), true);
    assert.equal(await env.page.isVisible('#btn-iam-edit'), true);
    assert.match(await env.page.textContent('#iam-source-a'), /pasted text · 1 lines/);

    await env.page.click('#btn-iam-edit');
    assert.equal(await env.page.isVisible('#iam-split'), true);
    assert.equal(await env.page.isVisible('#btn-iam-run'), true);
    assert.equal(await env.page.isHidden('#btn-iam-edit'), true);
    assert.equal(await env.page.isHidden('#iam-sources'), true);

    // Still holding the result, so Compare runs again and collapses again.
    await env.page.click('#btn-iam-run');
    assert.equal(await env.page.isHidden('#iam-split'), true);
});

test('unparseable input reopens the inputs instead of hiding them', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }),
        doc({ Effect: 'Allow', Action: 's3:PutObject', Resource: '*' }));
    assert.equal(await env.page.isHidden('#iam-split'), true);
    await env.page.click('#btn-iam-edit');
    await env.page.fill('#iam-b', 'not json');
    await env.page.click('#btn-iam-run');
    assert.equal(await env.page.isVisible('#iam-split'), true, 'you have to be able to fix it');
    assert.match(await env.page.textContent('#iam-error'), /B: a policy document has to start with/);
});

test('the overview ruler marks every difference, on the matching side', async () => {
    const many = n => Array.from({ length: n }, (_, i) => 'svc:Action' + String(i).padStart(3, '0'));
    await compare(
        doc({ Effect: 'Allow', Action: many(60).concat('svc:OnlyInA'), Resource: '*' }),
        doc({ Effect: 'Allow', Action: many(60).concat('svc:OnlyInB'), Resource: '*' }),
        literal);
    await env.page.waitForFunction(() => !document.getElementById('iam-ruler').hidden);
    const kinds = await env.page.$$eval('.iam-mark', els => els.map(e => e.className.replace('iam-mark ', '')));
    assert.ok(kinds.length > 0);
    assert.ok(kinds.every(k => k === 'del' || k === 'ins' || k === 'chg'));

    // Clicking the strip scrolls the result to that point.
    const before = await env.page.evaluate(() => document.querySelector('.tools-container').scrollTop);
    const box = await env.page.locator('#iam-ruler').boundingBox();
    await env.page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8);
    await env.page.waitForTimeout(150);
    const after = await env.page.evaluate(() => document.querySelector('.tools-container').scrollTop);
    assert.ok(after > before, 'clicking low on the ruler scrolls down');
});

test('the ruler stays hidden when there is nothing to scroll past', async () => {
    await compare(
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }),
        doc({ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }));
    assert.equal(await env.page.isHidden('#iam-ruler'), true);
});

test('nothing on the page threw', () => {
    assert.deepEqual(env.errors, []);
});
