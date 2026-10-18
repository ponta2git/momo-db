import { migrateLegacy, legacyIdentityMigrationCount } from './migration-prefix.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createTestClient, envelope, resetFixtures } from './notification-fixtures.mjs';
import { docker, expectedFencingCounterRows, expectedPublicIdentifierRows, retiredQueueTables, snapshotDatabase, username } from './migration-fixtures.mjs';

const submission = '11111111-1111-4111-8111-111111111111';
const pendingSubmission = '22222222-2222-4222-8222-222222222222';
const settledSubmission = '33333333-3333-4333-8333-333333333333';
const attempt = '44444444-4444-4444-8444-444444444444';
const checksum = 'sha256:' + 'a'.repeat(64);
const validation = 'series-analysis-artifact-v6-full-validation-v1';

async function isolated(run) {
  const name = 'momo_db_test_scheduler_' + randomUUID().replaceAll('-', '').slice(0, 12);
  docker(['createdb', '-U', username, name]);
  const db = createTestClient(name);
  try { await run(db, name); }
  finally { await db.end(); docker(['dropdb', '-U', username, name]); }
}
async function previous(db) {
  const folder = mkdtempSync(join(tmpdir(), 'momo-db-scheduler-prefix-'));
  try {
    cpSync('./drizzle', folder, { recursive: true });
    const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter(entry => entry.idx <= 67);
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    await migrate(drizzle(db), { migrationsFolder: folder });
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

async function seed(db, holder) {
  await resetFixtures(db);
  await db`INSERT INTO source_images(id, owner_account_id, object_key, idempotency_key_hash)
    VALUES ('source-image', 'notification-account', 'test/image', ${'a'.repeat(64)})`;
  for (const status of ['queued', 'running', 'succeeded', 'failed', 'cancelled']) {
    await db`INSERT INTO ocr_jobs(id, draft_id, image_id, image_path, source_image_id, queue_schema_version,
      requested_screen_type, status, attempt_count, worker_id, attempt_id, lease_owner,
      lease_token, lease_expires_at, lease_fencing_token, started_at, finished_at)
      VALUES (${status}, ${status + '-draft'}, ${status + '-image'}, ${status === 'succeeded' ? '/history.png' : null},
        ${status === 'succeeded' ? null : 'source-image'}, ${status === 'succeeded' ? 1 : 2},
        'total_assets', ${status}, ${status === 'running' ? 1 : 0}, ${status === 'running' ? 'old-worker' : null},
        ${status === 'running' ? attempt : null}::uuid, ${status === 'running' ? 'old-worker' : null},
        ${status === 'running' ? attempt : null}::uuid,
        ${status === 'running' ? '2099-01-01' : null}::timestamptz, ${status === 'running' ? 17 : 0},
        ${status === 'running' ? '2026-01-01' : null}::timestamptz,
        ${['queued', 'running'].includes(status) ? null : '2026-01-02'}::timestamptz)`;
    await db`INSERT INTO ocr_drafts(id, job_id, requested_screen_type)
      VALUES (${status + '-draft'}, ${status}, 'total_assets')`;
    await db`INSERT INTO ocr_queue_outbox(id, job_id, dedupe_key, stream_payload, schema_version)
      VALUES (${status + '-outbox'}, ${status}, ${status + '-delivery'}, '{"schemaVersion":"2"}', 2)`;
  }
  await db`UPDATE match_drafts SET status = 'ocr_running', total_assets_draft_id = 'queued-draft',
    revenue_draft_id = 'running-draft', incident_log_draft_id = 'succeeded-draft'
    WHERE id = 'notification-draft'`;
  await db`INSERT INTO match_drafts(id, created_by_account_id, status, total_assets_draft_id)
    VALUES ('confirmed-draft', 'notification-account', 'confirmed', 'succeeded-draft')`;
  for (const id of [submission, pendingSubmission, settledSubmission]) {
    await db`INSERT INTO ocr_submissions(id, owner_account_id, match_draft_id, admission_deadline,
      status, created_at, finished_at) VALUES (${id}, 'notification-account', 'notification-draft',
        clock_timestamp() + interval '1 hour', ${id === settledSubmission ? 'settled' : 'open'}, '2026-01-01',
        ${id === settledSubmission ? '2026-01-02' : null}::timestamptz)`;
  }
  await db`INSERT INTO ocr_submission_members(submission_id, screen_type, upload_idempotency_key_hash,
    image_sha256_hex, image_byte_length, status, job_id)
    VALUES (${submission}, 'total_assets', ${'a'.repeat(64)}, ${'b'.repeat(64)}, 100, 'registered', 'queued'),
      (${pendingSubmission}, 'total_assets', ${'c'.repeat(64)}, ${'b'.repeat(64)}, 100, 'pending', NULL),
      (${settledSubmission}, 'total_assets', ${'d'.repeat(64)}, ${'b'.repeat(64)}, 100, 'registered', 'succeeded')`;
  const payload = await envelope(db, 'ocr_completed', 'succeeded');
  await db`INSERT INTO discord_notifications(id, family, kind, dedupe_key, schema_version, payload, payload_hash, status, terminal_at)
    VALUES (${payload.notificationId}, 'result', 'ocr_completed', ${payload.notificationId}, 1,
      ${JSON.stringify(payload)}::jsonb, ${'a'.repeat(64)}, 'DELIVERED', now())`;
  await db`INSERT INTO discord_notification_results(notification_id, kind, source_job_id, occurred_at, settings_generation)
    VALUES (${payload.notificationId}, 'ocr_completed', 'succeeded', now(), 0)`;

  await db`INSERT INTO game_titles(id, name, layout_family) VALUES ('analysis-queued-title', 'Queued', 'momotetsu_2')`;
  for (const [id, title, status] of [['analysis-running', 'notification-title', 'running'], ['analysis-queued', 'analysis-queued-title', 'queued']]) {
    await db`INSERT INTO series_analysis_jobs(id, game_title_id, input_revision, algorithm_version,
      artifact_schema_version, validation_contract_id, status, trigger, lease_owner, lease_attempt_id,
      lease_fencing_token, lease_expires_at, lease_validation_contract_id)
      VALUES (${id}, ${title}, 2, 'series-analysis-v7', 6, ${validation}, ${status}, 'manual',
        ${status === 'running' ? 'analysis-worker' : null}, ${status === 'running' ? 'analysis-attempt' : null},
        ${status === 'running' ? 19 : null}, ${status === 'running' ? '2099-01-01' : null}::timestamptz,
        ${status === 'running' ? validation : null})`;
    await db`INSERT INTO series_analysis_queue_outbox(id, job_id, dedupe_key)
      VALUES (${id + '-delivery'}, ${id}, ${id + '-delivery'})`;
  }
  await db`INSERT INTO series_analysis_job_attempts(id, job_id, attempt_no, owner, fencing_token,
    input_revision, algorithm_version, artifact_schema_version, validation_contract_id,
    effective_config_version, calculation_timeout_milliseconds)
    VALUES ('analysis-attempt', 'analysis-running', 1, 'analysis-worker', 19, 2, 'series-analysis-v7', 6,
      ${validation}, 'test-config', 1000)`;
  await db`INSERT INTO series_analysis_operation_requests(id, scope, requested_by_account_id,
    idempotency_key_hash, endpoint, target_count) VALUES ('operation', 'all_titles', 'notification-account',
      'request-key', '/recalculate', 1)`;
  await db`INSERT INTO series_analysis_campaigns(id, operation_request_id, trigger, algorithm_version,
    artifact_schema_version, validation_contract_id, target_count)
    VALUES ('campaign', 'operation', 'manual', 'series-analysis-v7', 6, ${validation}, 1)`;
  await db`INSERT INTO series_analysis_campaign_targets(campaign_id, game_title_id, input_revision,
    algorithm_version, artifact_schema_version, validation_contract_id)
    VALUES ('campaign', 'notification-title', 2, 'series-analysis-v7', 6, ${validation})`;
  await db`INSERT INTO series_analysis_job_requests(id, game_title_id, operation_request_id, campaign_id,
    input_revision, algorithm_version, artifact_schema_version, validation_contract_id, trigger, force_run)
    VALUES ('request', 'notification-title', 'operation', 'campaign', 3, 'series-analysis-v7', 6, ${validation}, 'manual', true)`;
  await db`INSERT INTO series_radar_bases(id, game_title_id, checksum, payload, source_snapshot, source_checksum, source_input_revision)
    VALUES ('basis', 'notification-title', ${checksum}, '{}', '{"matches":[]}', ${checksum}, 2)`;
  await db`INSERT INTO series_radar_candidates(id, game_title_id, basis_id) VALUES ('candidate', 'notification-title', 'basis')`;
  await db`INSERT INTO series_radar_operations(id, game_title_id, kind, candidate_id, requested_by,
    idempotency_key_hash, request_fingerprint)
    VALUES ('radar-operation', 'notification-title', 'candidate', 'candidate', 'notification-account', 'radar-key', 'radar-hash')`;
  await db`INSERT INTO series_analysis_artifacts(id, game_title_id, input_revision, algorithm_version,
    artifact_schema_version, source_input_checksum, root_checksum, aggregate_chunk_count,
    review_chunk_count, drilldown_chunk_count, match_context_chunk_count, outlook_summary_chunk_count,
    outlook_reference_chunk_count, encoded_bytes, decoded_bytes)
    VALUES ('published-artifact', 'notification-title', 2, 'series-analysis-v7', 6, ${checksum}, ${checksum},
      1, 0, 0, 0, 1, 0, 2, 2)`;
  await db`INSERT INTO series_analysis_outlook_summary_artifacts(artifact_id, scope_key, scope_kind,
    payload, encoded_bytes, decoded_bytes, item_count, nesting_depth, checksum)
    VALUES ('published-artifact', 'overall', 'overall', ${Buffer.from('{}')}, 2, 2, 0, 1, ${checksum})`;
  await db`UPDATE series_analysis_artifacts SET validation_contract_id = ${validation} WHERE id = 'published-artifact'`;
  await db`UPDATE series_analysis_artifacts SET status = 'published', published_at = clock_timestamp() WHERE id = 'published-artifact'`;
  await db`UPDATE series_analysis_title_states SET input_revision = 2, algorithm_version = 'series-analysis-v7',
    artifact_schema_version = 6, validation_contract_id = ${validation}, current_artifact_id = 'published-artifact',
    notification_baseline_state = 'artifact', notification_baseline_artifact_id = 'published-artifact',
    pending_work = true WHERE game_title_id = 'notification-title'`;
  await db`UPDATE worker_execution_slots SET task_kind = ${holder},
    owner = ${holder === 'ocr' ? 'old-worker' : 'analysis-worker'},
    job_id = ${holder === 'ocr' ? 'running' : 'analysis-running'},
    attempt_id = ${holder === 'ocr' ? attempt : 'analysis-attempt'}, holder_preemptible = true,
    fencing_token = ${holder === 'ocr' ? 17 : 19}, lease_expires_at = '2099-01-01',
    preempt_requested_by = 'ocr-waiter', preempt_requested_at = clock_timestamp()`;
}

for (const holder of ['ocr', 'analysis']) {
  test(`scheduler cutover preserves restored business state and ${holder} slot semantics`, async () => {
    await isolated(async (source, name) => {
      await previous(source); await seed(source, holder);
      const before = await snapshotDatabase(source);
      const backup = docker(['pg_dump', '-U', username, '--format=custom', '--no-owner', '--no-acl', name]);
      await isolated(async (copy, restored) => {
        docker(['pg_restore', '-U', username, '--exit-on-error', '--no-owner', '--no-acl', '-d', restored], backup);
        assert.deepEqual(await snapshotDatabase(copy), before);
        await migrateLegacy(copy);
        const after = await snapshotDatabase(copy);
        assert.deepEqual(after.history.slice(0, before.history.length), before.history);
        assert.equal(after.history.length, legacyIdentityMigrationCount);
        for (const table of retiredQueueTables) assert.equal(after.rows[table], undefined);
        const changed = new Set([...retiredQueueTables, 'ocr_jobs', 'ocr_submissions', 'match_drafts',
          ...(holder === 'ocr' ? ['worker_execution_slots'] : [])]);
        for (const [table, rows] of Object.entries(expectedFencingCounterRows(expectedPublicIdentifierRows(before.rows)))) {
          if (!changed.has(table)) assert.deepEqual(after.rows[table], rows, `${table} must be unchanged`);
        }
        for (const old of before.rows.ocr_jobs) {
          const job = after.rows.ocr_jobs.find(row => row.id === old.id);
          const { queue_schema_version, ...retained } = old;
          const expected = { ...retained, input_snapshot: null, failure_retry_count: 0, lease_recovery_count: 0 };
          if (['queued', 'running'].includes(old.status)) {
            assert.equal(job.failure_code, 'QUEUE_FAILURE');
            assert.equal(job.failure_retryable, false);
            assert.ok(job.finished_at); assert.ok(job.updated_at);
            Object.assign(expected, { status: 'failed', worker_id: null, attempt_id: null, lease_owner: null,
              lease_token: null, lease_expires_at: null, failure_code: job.failure_code,
              failure_message: job.failure_message, failure_retryable: false, failure_user_action: job.failure_user_action,
              finished_at: job.finished_at, updated_at: job.updated_at });
          }
          assert.deepEqual(job, expected);
        }
        for (const old of before.rows.ocr_submissions) {
          const row = after.rows.ocr_submissions.find(row => row.id === old.id);
          assert.deepEqual(row, old.id === settledSubmission ? old : { ...old, status: 'aborted', finished_at: row.finished_at });
          assert.ok(row.finished_at);
        }
        for (const old of before.rows.match_drafts) {
          const row = after.rows.match_drafts.find(row => row.id === old.id);
          assert.deepEqual(row, old.id === 'notification-draft' ? { ...old, status: 'ocr_failed', updated_at: row.updated_at } : old);
        }
        if (holder === 'ocr') {
          const old = before.rows.worker_execution_slots[0]; const slot = after.rows.worker_execution_slots[0];
          assert.deepEqual(slot, { ...old, task_kind: null, owner: null, job_id: null, attempt_id: null,
            holder_preemptible: null, lease_expires_at: null, preempt_requested_by: null,
            preempt_requested_at: null, updated_at: slot.updated_at });
        }
        await migrateLegacy(copy);
        assert.deepEqual(await snapshotDatabase(copy), after, 'Rerun must not repeat OCR retirement or mutate analysis work');
      });
    });
  });
}

test('fresh scheduler schema requires versioned input for live jobs and retains terminal history', async () => {
  await isolated(async db => {
    await migrateLegacy(db);
    await resetFixtures(db);
    await db`INSERT INTO source_images(id, owner_account_id, object_key, idempotency_key_hash)
      VALUES ('image', 'notification-account', 'test/new-image', ${'b'.repeat(64)})`;
    const insert = snapshot => db`INSERT INTO ocr_jobs(id, draft_id, image_id, source_image_id,
      requested_screen_type, status, input_snapshot) VALUES ('new-job', 'new-draft', 'image', 'image',
        'total_assets', 'queued', ${snapshot == null ? null : JSON.stringify(snapshot)}::jsonb)`;
    for (const snapshot of [null, {}, [], { schemaVersion: 2 }, { schemaVersion: '1' }]) {
      await assert.rejects(insert(snapshot), { code: '23514', constraint_name: 'ocr_jobs_input_snapshot_check' });
    }
    const snapshot = { schemaVersion: '2', jobId: 'new-job', draftId: 'new-draft', sourceImageId: 'image',
      imageObjectKey: 'test/new-image', sha256: 'b'.repeat(64), byteLength: '100', mediaType: 'image/png',
      requestedScreenType: 'total_assets', attempt: '1', enqueuedAt: '2026-01-01T00:00:00Z' };
    await insert(snapshot);
    const [job] = await db`SELECT input_snapshot, attempt_count, failure_retry_count, lease_recovery_count FROM ocr_jobs WHERE id = 'new-job'`;
    assert.deepEqual({ ...job }, { input_snapshot: snapshot, attempt_count: 0, failure_retry_count: 0, lease_recovery_count: 0 });
    await assert.rejects(db`UPDATE ocr_jobs SET input_snapshot = NULL WHERE id = 'new-job'`, { code: '23514' });
    await assert.rejects(db`UPDATE ocr_jobs SET source_image_id = NULL WHERE id = 'new-job'`, { code: '23514' });
    for (const column of ['failure_retry_count', 'lease_recovery_count']) {
      await assert.rejects(db`UPDATE ocr_jobs SET ${db(column)} = -1 WHERE id = 'new-job'`,
        { code: '23514', constraint_name: 'ocr_jobs_retry_counts_check' });
    }
    await db`UPDATE ocr_jobs SET status = 'failed', finished_at = clock_timestamp() WHERE id = 'new-job'`;
    assert.deepEqual((await db`SELECT input_snapshot FROM ocr_jobs WHERE id = 'new-job'`)[0].input_snapshot, snapshot);
    await db`INSERT INTO ocr_jobs(id, draft_id, image_id, requested_screen_type, status)
      VALUES ('history', 'history-draft', 'history-image', 'total_assets', 'succeeded')`;
    for (const table of retiredQueueTables) assert.equal((await db`SELECT to_regclass(${table}) AS name`)[0].name, null);
    await assert.rejects(db`SELECT queue_schema_version FROM ocr_jobs`, { code: '42703' });
    const [index] = await db`SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'ocr_jobs_claimable_idx'`;
    assert.equal(index.indisvalid, true);
    assert.match(index.definition, /available_at, created_at, id/);
    assert.match(index.definition, /WHERE.*queued/);
  });
});

test('an unexpected legacy OCR state rejects the whole cutover without partial retirement', async () => {
  await isolated(async db => {
    await previous(db); await seed(db, 'ocr');
    // Old storage did not constrain status. Do not silently guess a meaning for
    // an unrecognised row merely to make the new input contract pass.
    await db`INSERT INTO ocr_jobs(id, draft_id, image_id, image_path, requested_screen_type, status)
      VALUES ('unexpected', 'unexpected-draft', 'unexpected-image', '/history.png', 'total_assets', 'unexpected')`;
    const before = await snapshotDatabase(db);
    await assert.rejects(migrateLegacy(db),
      error => error.cause?.constraint_name === 'ocr_jobs_input_snapshot_check');
    assert.deepEqual(await snapshotDatabase(db), before, 'Schema, migration journal and every business row roll back together');
    assert.equal((await db`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ocr_jobs' AND column_name = 'input_snapshot'`)[0].n, 0);
  });
});
