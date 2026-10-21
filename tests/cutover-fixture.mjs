import { digest } from '../scripts/migration/files.mjs';
import { configurationDigest } from '../scripts/migration/cutover-guard.mjs';

export const candidate = 'a'.repeat(40);
export function fixture() {
  const time = Date.now();
  const source = {
    connection: {
      ledger: Array.from({ length: 73 }, (_, index) => ({ hash: String(index), created_at: String(index) })),
      server: { encoding: 'UTF8', collation: 'C.UTF-8', ctype: 'C.UTF-8', localeProvider: 'b',
        locale: 'C.UTF-8', icuRules: null, collationVersion: '1', actualCollationVersion: '1' },
    },
    role: 'owner', rolesDigest: 'b'.repeat(64), locationIdentity: 'c'.repeat(64), schema: { tables: [] },
    rows: { algorithm: 'sha256-row-multiset-v2', tables: [{ name: 'fixture', rows: '1', digest: 'd'.repeat(64) }],
      sequences: [{ name: 'fixture_id_seq', last_value: '1', is_called: true }] },
  };
  const actual = ['api', 'worker', 'summit'].map(id => ({ id, instance_id: `instance-${id}`,
    eventsDigest: 'e'.repeat(64), state: 'stopped', config: { restart: { policy: 'no' }, services: [], env: { FIXTURE: '1' } } }));
  const evidence = { formatVersion: 2, kind: 'final-cutover-evidence', candidate,
    profile: 'canonical-identities-retired-slots-v1', refs: { db: candidate, summit: candidate, result: candidate },
    frozenAt: new Date(time - 3000).toISOString(), validatedAt: new Date(time - 1000).toISOString(),
    expiresAt: new Date(time + 60000).toISOString(),
    backup: { capturedAt: new Date(time - 2000).toISOString(), restoredAndRead: true,
      archiveDigest: 'd'.repeat(64), restoredReportDigest: 'e'.repeat(64) },
    report: {}, verification: {}, verificationDigest: digest({}),
    finalData: { passed: true, path: 'full-rehearsal', reportDigest: digest({}) },
    source, machines: actual.map(item => ({ consumer: item.id, app: `fixture-${item.id}`, id: item.id,
      instanceId: item.instance_id, eventsDigest: item.eventsDigest, configDigest: configurationDigest(item.config) })) };
  return { evidence, actual };
}

