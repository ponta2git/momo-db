import { createHash } from 'node:crypto';
import { ControlError } from './control.mjs';

const check = (condition, code) => { if (!condition) throw new ControlError(code); };
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

export function connectionProof(url, database, ledger) {
  let target;
  try { target = new URL(url); } catch { throw new ControlError('INVALID_DATABASE_PROOF_CONFIGURATION'); }
  check(['postgres:', 'postgresql:'].includes(target.protocol) && target.hostname &&
    typeof database === 'string' && database.length > 0, 'INVALID_DATABASE_PROOF_CONFIGURATION');
  let host = target.hostname.toLowerCase();
  if (host.endsWith('.neon.tech')) host = host.replace(/^([^.]+)-pooler\./, '$1.');
  check(Array.isArray(ledger) && ledger.length > 0 && ledger.every(row =>
    /^[a-f0-9]{64}$/.test(row.hash) && typeof row.created_at === 'string' && /^[0-9]+$/.test(row.created_at)), 'INVALID_DATABASE_PROOF_LEDGER');
  return { formatVersion: 1,
    targetFingerprint: sha256(JSON.stringify(['momo-database-target-v1', host, target.port || '5432', database])),
    ledgerFingerprint: sha256('momo-drizzle-ledger-v1\n' + ledger.map(row => `${row.hash}:${row.created_at}\n`).join('')) };
}

// Use the actual connection's database name and full ordered ledger inside the
// caller's read-only transaction. Configured path/role are not target evidence.
export async function inspectConnectionProof(sql, url) {
  const [identity] = await sql`SELECT current_database() AS database,
    current_setting('transaction_read_only') AS "readOnly",
    row_security_active('drizzle.__drizzle_migrations'::regclass) AS filtered`;
  check(identity?.readOnly === 'on' && identity.filtered === false, 'READ_ONLY_UNFILTERED_CONNECTION_PROOF_REQUIRED');
  const ledger = await sql`SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
  return connectionProof(url, identity.database, ledger);
}
