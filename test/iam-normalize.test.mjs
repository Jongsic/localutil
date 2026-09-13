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

test('nothing in the input is missing from the output', async () => {
    const policy = doc(
        { Sid: 'One', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: 'arn:aws:s3:::b/*' },
        { Sid: 'Two', Effect: 'Deny', Action: 's3:DeleteBucket', Resource: '*' },
        { Sid: 'Three', Effect: 'Allow', Action: 'sts:AssumeRole', Resource: 'arn:aws:iam::111122223333:role/r',
          Condition: { StringEquals: { 'sts:ExternalId': 'abc' } } },
        { Sid: 'Four', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
        { Sid: 'Five', Effect: 'Allow', NotAction: 'iam:*', Resource: '*' },
    );
    await normalize(policy);
    const text = await output();
    for (const needle of ['s3:GetObject', 's3:PutObject', 's3:DeleteBucket', 'sts:AssumeRole',
        'arn:aws:s3:::b/*', 'arn:aws:iam::111122223333:role/r', 'sts:ExternalId', 'abc',
        'lambda.amazonaws.com', 'iam:*', '"Deny"', '"NotAction"']) {
        assert.ok(text.includes(needle), needle + ' survived normalization');
    }
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

test('nothing on the page threw', () => {
    assert.deepEqual(env.errors, []);
});
