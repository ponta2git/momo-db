import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lstat } from 'node:fs/promises';
import { connect, databaseLocation, inspectConnection, inspectServer, fingerprint } from './database.mjs';
import { inspectSchema } from './inventory.mjs';
import { expectedCutoverBaseline, cutoverBaselineMatches } from '../check-cutover-baseline.mjs';
import { digest, loadKey, readJson, writeJson, requireCondition as check, RehearsalError } from './files.mjs';
import { sourceApproval, verifySourceEndpoint } from './source-preflight.mjs';
import { guardedApply, configurationDigest } from './cutover-guard.mjs';
import { command } from './process.mjs';
import { inspectCanonicalIdentityTransition } from './canonical-identities.mjs';

export async function inspectFinalSource(sql, url, repository, { allowAnyLedger = false, profile } = {}) {
  return sql.begin('isolation level repeatable read read only', async tx => {
    const noOtherClients = async () => {
      // Statistics snapshots are cached within a transaction unless cleared.
      await tx`SELECT pg_stat_clear_snapshot()`;
      const [clients] = await tx`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND (backend_type='client backend' OR backend_type IS NULL)
          AND pid<>pg_backend_pid()`;
      // Other login roles can have backend_type hidden without pg_read_all_stats.
      // An unknown backend is not evidence that its connection has drained.
      check(clients.count === 0, 'DATABASE_CLIENTS_NOT_DRAINED');
    };
    await noOtherClients();
    const [identity] = await tx`SELECT current_user AS role, session_user AS login_role,
      current_setting('transaction_read_only') AS read_only`;
    check(identity.role === identity.login_role && identity.read_only === 'on', 'DIRECT_READ_ONLY_LOGIN_REQUIRED');
    const ledger = await tx`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
    check(allowAnyLedger || cutoverBaselineMatches(expectedCutoverBaseline(`${repository}/drizzle`), ledger),
    'NOT_BASELINE_CLASSIFY_WITHOUT_APPLYING');
    const normalizedLedger = ledger.map(({ hash, created_at }) => ({ hash, created_at: String(created_at) }));
    const connection = allowAnyLedger ? { server: await inspectServer(tx), ledger: normalizedLedger,
      ledgerDigest: digest(normalizedLedger) } : await inspectConnection(tx, repository);
    // This covers application role flags/defaults and all membership edges. P3
    // uses this same observation, rather than comparing a hand-written role name.
    const roles = await tx`SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
      rolcanlogin, rolreplication, rolbypassrls, rolconfig FROM pg_roles ORDER BY rolname`;
    const memberships = await tx`SELECT role.rolname AS role, member.rolname AS member,
      grantor.rolname AS grantor, m.admin_option, m.inherit_option, m.set_option
      FROM pg_auth_members m JOIN pg_roles role ON role.oid=m.roleid
      JOIN pg_roles member ON member.oid=m.member JOIN pg_roles grantor ON grantor.oid=m.grantor
      ORDER BY role.rolname, member.rolname, grantor.rolname`;
    const defaultPrivileges = await tx`SELECT pg_get_userbyid(a.defaclrole) AS owner,
      n.nspname AS schema, a.defaclobjtype AS type, x.privilege_type AS privilege,
      x.is_grantable, CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS grantee
      FROM pg_default_acl a LEFT JOIN pg_namespace n ON n.oid=a.defaclnamespace
      CROSS JOIN LATERAL aclexplode(a.defaclacl) x ORDER BY owner,schema,type,grantee,privilege`;
    const result = { connection, role: identity.role, rolesDigest: configurationDigest({ roles, memberships, defaultPrivileges }),
      locationIdentity: databaseLocation(url).identity, schema: await inspectSchema(tx),
      rows: await fingerprint(tx, { sequences: true }) };
    if (profile && digest(connection.ledger) === digest(profile.history.entries)) {
      result.transition = await inspectCanonicalIdentityTransition(tx, profile);
    }
    await noOtherClients();
    return result;
  });
}

export async function machineInventory(expected) {
  check(process.env.FLY_API_TOKEN, 'FLY_READ_ACCESS_REQUIRED');
  const result = [];
  for (const item of expected) {
    const response = await fetch(`https://api.machines.dev/v1/apps/${item.app}/machines`, {
      headers: { Authorization: `Bearer ${process.env.FLY_API_TOKEN}` },
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    check(response.ok, 'MACHINE_INVENTORY_UNAVAILABLE');
    const machines = await response.json();
    check(Array.isArray(machines) && machines.length === 1 && machines[0].id === item.id,
      'SINGLE_MACHINE_WRITER_INVENTORY_CHANGED');
    const detail = await fetch(`https://api.machines.dev/v1/apps/${item.app}/machines/${item.id}`, {
      headers: { Authorization: `Bearer ${process.env.FLY_API_TOKEN}` },
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    check(detail.ok, 'MACHINE_EVENTS_UNAVAILABLE');
    const machine = await detail.json();
    check(machine.id === item.id && machine.instance_id === machines[0].instance_id &&
      Array.isArray(machine.events) && machine.events.length > 0, 'MACHINE_EVENTS_REQUIRED');
    result.push({ ...machine, eventsDigest: configurationDigest(machine.events) });
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const names = ['evidence', 'key-file', 'output'];
  check(args.length === names.length * 2 && names.every((name, index) =>
    args[index * 2] === `--${name}` && args[index * 2 + 1].startsWith('/')), 'CUTOVER_APPLY_ARGUMENTS_REQUIRED');
  const options = Object.fromEntries(names.map((name, index) => [name, args[index * 2 + 1]]));
  // An earlier attempt, even one which lost its process, must be classified first.
  check(!await lstat(options.output).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  }), 'PRIOR_ATTEMPT_REQUIRES_READ_ONLY_CLASSIFICATION');
  const key = await loadKey(options['key-file']);
  const evidence = await readJson(options.evidence, key);
  const candidate = await command('git', ['rev-parse', 'HEAD']);
  check(process.env.GITHUB_ACTIONS === 'true' &&
    process.env.GITHUB_REF === 'refs/heads/master' &&
    process.env.GITHUB_SHA === candidate &&
    process.env.MOMO_CUTOVER_APPROVED_SHA === candidate, 'PROTECTED_FIXED_COMMIT_REQUIRED');
  check(evidence.producer?.runId === process.env.MOMO_CUTOVER_EVIDENCE_RUN &&
    evidence.producer?.attempt === process.env.MOMO_CUTOVER_EVIDENCE_ATTEMPT,
  'EVIDENCE_PRODUCER_ATTEMPT_DIFFERS');
  const url = process.env.DIRECT_URL;
  const approval = sourceApproval();
  await verifySourceEndpoint(url, approval);
  const sql = connect(url);
  try {
    await guardedApply({ evidence, candidate,
      observeMachines: () => machineInventory(evidence.machines),
      inspectSource: async () => {
        await verifySourceEndpoint(url, approval);
        return inspectFinalSource(sql, url, process.cwd());
      },
      migrate: async () => {
        // The normal migrator is deliberately unchanged. Only this guarded path
        // may reach it while the breaking tail is pending.
        await command('pnpm', ['exec', 'drizzle-kit', 'migrate'], {
          failureCode: 'CANONICAL_MIGRATOR_DID_NOT_RETURN_SUCCESS',
        });
      },
      record: value => writeJson(options.output, { ...value,
        observedAt: new Date().toISOString(), evidenceDigest: digest(evidence) }, key),
    });
  } finally { await sql.end({ timeout: 5 }); }
  console.log('Canonical migrator returned success. Keep all writers stopped until the full postcomparison passes.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    console.error(error instanceof RehearsalError ? error.code : 'CUTOVER_APPLY_FAILED_DETAILS_WITHHELD');
    process.exitCode = 1;
  }
}
