import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { command } from './process.mjs';
import { connect } from './database.mjs';
import { configurationDigest, compareFinalSource, verifyStoppedMachines, validateCutoverEvidence } from './cutover-guard.mjs';
import { inspectFinalSource, machineInventory } from './cutover-apply.mjs';
import { compareCanonicalIdentityTransition } from './canonical-identities.mjs';
import { sourceApproval, verifySourceEndpoint } from './source-preflight.mjs';
import { digest, loadKey, readJson, writeJson, requireCondition as check, RehearsalError } from './files.mjs';

export function classifyCutoverState(evidence, actual) {
  check(evidence.verificationDigest === digest(evidence.verification) &&
    evidence.finalData.reportDigest === digest(evidence.report), 'CUTOVER_COMPARISON_INPUT_CHANGED');
  const { baseline, profile, sourceTransition } = evidence.verification;
  const ledger = digest(actual.connection.ledger);
  try {
    if (ledger === digest(evidence.source.connection.ledger)) {
      compareFinalSource(evidence.source, actual);
      return { state: 'baseline-unchanged', passed: true, next: 'fresh-guarded-apply-only' };
    }
    if (ledger === digest(profile.history.entries)) {
      check(evidence.source.locationIdentity === actual.locationIdentity && evidence.source.role === actual.role &&
        evidence.source.rolesDigest === actual.rolesDigest, 'CUTOVER_TARGET_IDENTITY_OR_ROLE_CHANGED');
      compareCanonicalIdentityTransition({ before: baseline, after: actual, sourceTransition,
        transition: actual.transition, profile });
      return { state: 'target-preserved', passed: true, next: 'read-only-consumer-gates-no-sql-retry' };
    }
    return { state: 'partial-or-unknown', passed: false, next: 'keep-stopped-recovery-decision-required' };
  } catch (error) {
    if (!(error instanceof RehearsalError)) throw error;
    return { state: 'comparison-failed', passed: false, reason: error.code,
      next: 'keep-stopped-recovery-decision-required' };
  }
}

export async function main(args) {
  const names = ['evidence', 'key-file', 'output'];
  check(args.length === 6 && names.every((name, index) => args[index * 2] === `--${name}` &&
    args[index * 2 + 1]?.startsWith('/')), 'CUTOVER_CLASSIFY_ARGUMENTS_REQUIRED');
  const [evidencePath, keyPath, outputPath] = names.map((_, index) => args[index * 2 + 1]);
  const key = await loadKey(keyPath);
  const evidence = await readJson(evidencePath, key);
  const candidate = await command('git', ['rev-parse', 'HEAD']);
  check(process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REF === 'refs/heads/master' &&
    process.env.GITHUB_SHA === candidate, 'FIXED_MASTER_CLASSIFICATION_REQUIRED');
  // Old evidence remains usable to classify an uncertain result, never to apply
  // SQL. Candidate, producer, authenticated reports and current source still bind.
  validateCutoverEvidence(evidence, { candidate, now: Date.parse(evidence.validatedAt) });
  check(evidence.producer?.runId === process.env.MOMO_CUTOVER_EVIDENCE_RUN &&
    evidence.producer?.attempt === process.env.MOMO_CUTOVER_EVIDENCE_ATTEMPT,
  'EVIDENCE_PRODUCER_ATTEMPT_DIFFERS');
  const url = process.env.DIRECT_URL;
  await verifySourceEndpoint(url, sourceApproval());
  verifyStoppedMachines(evidence.machines, await machineInventory(evidence.machines));
  const sql = connect(url);
  let actual;
  try { actual = await inspectFinalSource(sql, url, process.cwd(), {
    allowAnyLedger: true, profile: evidence.verification.profile }); }
  finally { await sql.end(); }
  verifyStoppedMachines(evidence.machines, await machineInventory(evidence.machines));
  const result = classifyCutoverState(evidence, actual);
  await writeJson(outputPath, { ...result, candidate, observedAt: new Date().toISOString(),
    evidenceDigest: digest(evidence), actualDigest: configurationDigest(actual), actual }, key);
  console.log(JSON.stringify({ state: result.state, passed: result.passed, next: result.next }));
  check(result.passed, 'CUTOVER_STATE_REQUIRES_RECOVERY_DECISION');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof RehearsalError ? error.code : 'CUTOVER_CLASSIFICATION_FAILED_DETAILS_WITHHELD');
    process.exitCode = 1;
  }
}
