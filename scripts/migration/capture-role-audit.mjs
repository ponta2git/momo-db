import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureApplicationRoleAudit, applicationOwnerPlan } from './application-role.mjs';
import { connect } from './database.mjs';
import { sourceApproval, verifySourceEndpoint } from './source-preflight.mjs';
import { digest, loadKey, readJson, writeJson, requireCondition as check, RehearsalError } from './files.mjs';

export function validateConsumerObservations(observations, source, now = Date.now()) {
  check(Array.isArray(observations) && observations.length === 3, 'THREE_CONSUMER_OBSERVATIONS_REQUIRED');
  const scopes = new Set();
  for (const observation of observations) {
    const report = observation?.report;
    const provider = observation?.machine;
    check(report?.formatVersion === 1 && ['api', 'worker', 'summit'].includes(report.consumer) &&
      !scopes.has(report.consumer), 'CONSUMER_OBSERVATION_INVALID');
    scopes.add(report.consumer);
    const correlated = report.mode === 'existing-runtime-correlated';
    check(report.readOnly === true && (report.mode === 'maintenance' || correlated) &&
      report.database === source.connection.server.database &&
      Array.isArray(report.ledger) &&
      digest(report.ledger.map(row => ({ hash: row.hash, created_at: row.created_at }))) === source.connection.ledgerDigest &&
      typeof report.role === 'string' && report.role.length > 0, 'CONSUMER_CONNECTION_DIFFERS');
    const observedAt = Date.parse(report.observedAt);
    check(Number.isFinite(observedAt) && observedAt <= now &&
      now - observedAt <= (correlated ? 1800000 : 300000) &&
      provider?.state === 'started' && provider.id === report.machine?.id &&
      typeof report.machine.bootId === 'string' && report.machine.bootId.length > 0 &&
      /^sha256:[a-f0-9]{64}$/.test(report.machine.imageDigest) &&
      provider.imageDigest === report.machine.imageDigest &&
      Number.isFinite(provider.startedAt) && provider.startedAt <= observedAt &&
      (correlated || observedAt - provider.startedAt <= 300000), 'FRESH_MACHINE_OBSERVATION_REQUIRED');
    if (correlated) {
      const runtime = observation.runtime;
      check(report.helperIsApplicationProcess === false &&
        provider.instanceId === report.machine.bootId &&
        runtime?.sameInstanceBeforeAndAfter === true && runtime.sameConfigBeforeAndAfter === true &&
        runtime.processSocketToConfiguredDatabase === true &&
        ['direct-session', 'shared-pgbouncer-with-process-socket'].includes(runtime.poolCorrelation) &&
        ['configurationDigest', 'processEvidenceDigest', 'logsDigest'].every(name =>
          /^[a-f0-9]{64}$/.test(runtime[name])), 'EXISTING_RUNTIME_CORRELATION_REQUIRED');
    }
  }
  return observations.map(({ report }) => report);
}

async function main() {
  const args = process.argv.slice(2);
  const names = ['key-file', 'source-config', 'source-report', 'consumer-reports', 'output'];
  check(args.length === names.length * 2 && names.every((name, index) =>
    args[index * 2] === `--${name}` && args[index * 2 + 1].startsWith('/')), 'ROLE_AUDIT_ARGUMENTS_REQUIRED');
  const options = Object.fromEntries(names.map((name, index) => [name, args[index * 2 + 1]]));
  const key = await loadKey(options['key-file']);
  const config = await readJson(options['source-config'], key);
  const source = await readJson(options['source-report'], key);
  const observations = await readJson(options['consumer-reports'], key);
  const consumers = validateConsumerObservations(observations, source);
  const approval = sourceApproval();
  check(digest(config.preflight?.approved) === digest(approval), 'APPROVED_SOURCE_PREFLIGHT_REQUIRED');
  await verifySourceEndpoint(config.sourceUrl, approval);
  const sql = connect(config.sourceUrl);
  let audit;
  try {
    audit = await sql.begin('isolation level repeatable read read only',
      tx => captureApplicationRoleAudit(tx, source, consumers));
  } finally { await sql.end({ timeout: 5 }); }
  await verifySourceEndpoint(config.sourceUrl, approval);
  applicationOwnerPlan(source, audit);
  await writeJson(options.output, audit, key);
  console.log('Application role audit captured and mapping contract verified.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    console.error(error instanceof RehearsalError ? error.code : 'ROLE_AUDIT_FAILED_PRIVATE_DETAILS_WITHHELD');
    process.exitCode = 1;
  }
}
