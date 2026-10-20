import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withMaintenanceConsumer } from './consumer-runner.mjs';
import { withLocalConnection, localUrl } from './local.mjs';
import { connect, fingerprint, compareFingerprints } from './database.mjs';
import { digest, loadKey, readJson, writeJson, withRunLock, requireCondition as check, RehearsalError } from './files.mjs';

async function main() {
  const args = process.argv.slice(2);
  const names = ['manifest', 'key-file', 'copy', 'config', 'output'];
  check(args.length === names.length * 2 && names.every((name, index) => args[index * 2] === `--${name}`),
    'CONSUMER_PROBE_ARGUMENTS_REQUIRED');
  const options = Object.fromEntries(names.map((name, index) => [name, args[index * 2 + 1]]));
  check(['smoke', 'recovery'].includes(options.copy) &&
    ['manifest', 'key-file', 'config', 'output'].every(name => options[name]?.startsWith('/')),
  'CONSUMER_PROBE_ARGUMENTS_REQUIRED');
  const key = await loadKey(options['key-file']);
  const directory = dirname(options.manifest);
  await withRunLock(directory, async () => {
    const manifest = await readJson(options.manifest, key);
    const proof = await readJson(`${directory}/application-role-${options.copy}.json.enc`, key);
    check(manifest.applicationRoles?.[options.copy]?.proofDigest === digest(proof),
      'APPLICATION_ROLE_PROOF_CHANGED');
    const expected = await readJson(`${directory}/${options.copy === 'smoke' ? 'migrated' : 'recovered'}.json.enc`, key);
    check(digest(expected) === (options.copy === 'smoke' ? manifest.migratedDigest : manifest.recoveredDigest),
      'APPLICATION_COPY_PROOF_CHANGED');
    const config = await readJson(options.config, key);
    check(digest(config.ledger) === expected.connection.ledgerDigest, 'CONSUMER_LEDGER_EXPECTATION_DIFFERS');
    await withLocalConnection(manifest, async () => {
      const sql = connect(localUrl(manifest, proof.database));
      try {
        const before = await sql.begin('isolation level repeatable read read only', fingerprint);
        const report = await withMaintenanceConsumer(manifest, proof, config, async ({ report }) => report);
        const after = await sql.begin('isolation level repeatable read read only', fingerprint);
        compareFingerprints(before, after, { sequences: true });
        await writeJson(options.output, { formatVersion: 1, report, sourceProofDigest: digest(proof),
          dataUnchanged: true, beforeDigest: digest(before), afterDigest: digest(after) }, key);
      } finally { await sql.end(); }
    });
  });
  console.log('Consumer maintenance probe passed; encrypted evidence written.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    console.error(error instanceof RehearsalError ? error.code : 'CONSUMER_PROBE_FAILED_PRIVATE_DETAILS_WITHHELD');
    process.exitCode = 1;
  }
}
