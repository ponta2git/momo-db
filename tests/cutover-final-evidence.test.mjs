import test from 'node:test';
import assert from 'node:assert/strict';
import { produceFinalEvidence } from '../scripts/migration/final-evidence.mjs';
import { classifyCutoverState } from '../scripts/migration/cutover-classify.mjs';
import { validateCutoverEvidence } from '../scripts/migration/cutover-guard.mjs';
import { digest } from '../scripts/migration/files.mjs';
import { candidate, fixture } from './cutover-fixture.mjs';

function scenario() {
  const { evidence, actual } = fixture();
  const events = [];
  let clock = Date.now();
  const input = { candidate, refs: evidence.refs, inventory: evidence.machines,
    scope: 'production', producer: { runId: '1', attempt: '1' }, recoveryReserveMs: 30 * 60 * 1000,
    now: () => clock,
    observeMachines: async () => { events.push('machines'); return actual; },
    inspectSource: async () => { events.push('source'); return evidence.source; },
    record: async value => { events.push(value.state); },
    runFullRehearsal: async ({ checkpoint }) => {
      events.push('backup'); clock += 1;
      const capturedAt = new Date(clock).toISOString();
      await checkpoint();
      events.push('full-rehearsal'); clock += 1;
      return { manifest: { snapshot: { capturedAt, archiveDigest: 'd'.repeat(64) },
        baselineDigest: 'e'.repeat(64) }, report: { passed: true }, verification: { fixture: true } };
    } };
  return { input, events, evidence, actual, advance: duration => { clock += duration; } };
}

test('producer observes stop and complete source around backup and the full path', async () => {
  const { input, events } = scenario();
  const result = await produceFinalEvidence(input);
  validateCutoverEvidence(result, { candidate, now: Date.parse(result.validatedAt) });
  assert.equal(result.finalData.path, 'full-rehearsal');
  assert.deepEqual(events, ['machines', 'source', 'machines', 'frozen-source-read', 'backup',
    'machines', 'source', 'machines', 'full-rehearsal', 'machines', 'source', 'machines', 'final-evidence-complete']);
});

test('the same completed simulation cannot authorize production SQL', async () => {
  const { input } = scenario(); input.scope = 'rehearsal';
  const result = await produceFinalEvidence(input);
  assert.equal(result.kind, 'cutover-rehearsal-evidence');
  assert.throws(() => validateCutoverEvidence(result, { candidate }), /FINAL_CUTOVER_EVIDENCE_REQUIRED/);
});

test('failed restore/rehearsal, interruption, restarted writers and recovery deadline never complete evidence', async () => {
  for (const failure of ['failed', 'aborted', 'restarted', 'row-change', 'sequence-change', 'deadline']) {
    const { input, events, evidence, actual, advance } = scenario();
    const controller = new AbortController(); input.signal = controller.signal;
    const original = input.runFullRehearsal;
    input.runFullRehearsal = async args => {
      if (failure === 'failed') throw new Error('restore failed');
      const result = await original(args);
      if (failure === 'aborted') controller.abort();
      if (failure === 'restarted') actual[0].eventsDigest = 'f'.repeat(64);
      if (failure === 'deadline') advance(91 * 60 * 1000);
      if (failure === 'row-change' || failure === 'sequence-change') {
        const changed = structuredClone(evidence.source);
        if (failure === 'row-change') changed.rows.tables[0].digest = 'f'.repeat(64);
        else changed.rows.sequences[0].last_value = '99';
        observed = changed;
      }
      return result;
    };
    let observed = evidence.source;
    input.inspectSource = async () => observed;
    await assert.rejects(produceFinalEvidence(input));
    assert.equal(events.includes('final-evidence-complete'), false, failure);
  }
});

test('read-only classifier distinguishes unchanged baseline, changed data and partial/unknown ledger', () => {
  const { evidence } = fixture();
  evidence.verification = { baseline: {}, profile: { history: { entries: [{ hash: 'target' }] } }, sourceTransition: {} };
  evidence.verificationDigest = digest(evidence.verification);
  assert.equal(classifyCutoverState(evidence, evidence.source).state, 'baseline-unchanged');
  const changed = structuredClone(evidence.source); changed.rows.sequences[0].last_value = '99';
  assert.equal(classifyCutoverState(evidence, changed).state, 'comparison-failed');
  const partial = structuredClone(evidence.source); partial.connection.ledger.pop();
  assert.equal(classifyCutoverState(evidence, partial).state, 'partial-or-unknown');
  evidence.verification.profile.history.entries = [];
  assert.throws(() => classifyCutoverState(evidence, evidence.source), /CUTOVER_COMPARISON_INPUT_CHANGED/);
});
