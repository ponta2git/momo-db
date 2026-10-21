import assert from 'node:assert/strict';
import test from 'node:test';
import { matchSourceEndpoint, sourceApproval, verifySourceEndpoint } from '../scripts/migration/source-preflight.mjs';

const approval = sourceApproval({
  MOMO_REHEARSAL_PROJECT_ID: 'fixture-project', MOMO_REHEARSAL_BRANCH_ID: 'br-fixture',
  MOMO_REHEARSAL_ENDPOINT_ID: 'ep-fixture', MOMO_DB_EXPECTED_DIRECT_HOST: 'ep-fixture.example.neon.tech',
});
const url = 'postgresql://fixture:never-print@ep-fixture.example.neon.tech/neondb?sslmode=require';
const endpoint = { id: approval.endpoint, project_id: approval.project, branch_id: approval.branch,
  host: approval.host, type: 'read_write', disabled: false };

test('source identity pins project, branch, endpoint, direct host and database independently of ledger', () => {
  assert.ok(matchSourceEndpoint(url, approval, { endpoints: [endpoint] }).identity);
  for (const change of [{ project_id: 'other' }, { branch_id: 'br-other' }, { id: 'ep-other' },
    { host: 'ep-other.example.neon.tech' }, { type: 'read_only' }, { disabled: true }]) {
    assert.throws(() => matchSourceEndpoint(url, approval, { endpoints: [{ ...endpoint, ...change }] }));
  }
  for (const changed of [url.replace('neondb?', 'other?'), url.replace('ep-fixture.', 'ep-fixture-pooler.'),
    url.replace('ep-fixture.', 'ep-other.'), url.replace('sslmode=require', 'sslmode=disable')]) {
    assert.throws(() => matchSourceEndpoint(changed, approval, { endpoints: [endpoint] }));
  }
  assert.throws(() => matchSourceEndpoint(url, approval, { endpoints: [endpoint, endpoint] }));
  assert.throws(() => sourceApproval({}));
});

test('provider lookup is GET-only, rejects redirects/failure and never embeds credentials in the URL', async () => {
  let called = 0;
  await verifySourceEndpoint(url, approval, { token: 'private-token', request: async (target, options) => {
    called++;
    assert.equal(target, 'https://console.neon.tech/api/v2/projects/fixture-project/endpoints');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer private-token');
    return { ok: true, json: async () => ({ endpoints: [endpoint] }) };
  } });
  assert.equal(called, 1);
  assert.ok(await verifySourceEndpoint(url, approval, { token: '', request: () => assert.fail(),
    cliRead: async value => { assert.deepEqual(value, approval); return { endpoints: [endpoint] }; } }));
  await assert.rejects(verifySourceEndpoint(url, approval, { token: 'private', request: async () => ({ ok: false }) }),
    { code: 'NEON_ENDPOINT_LOOKUP_FAILED' });
});
