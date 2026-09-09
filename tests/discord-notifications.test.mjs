import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { buildDiscordNotificationId } from '../dist/notifications.js';
import { at, barrier, begin, claim, complete, createTestClient, envelope, get, members, now, plan, receive, resetFixtures, waitForAdvisoryWait, waitForRowWait } from './notification-fixtures.mjs';

const db = createTestClient();
beforeEach(() => resetFixtures(db));
after(() => db.end());
const rejected = (code) => (error) => error.code === code;

test('stable IDs, canonical JSON and concurrent receipt retain one immutable notification', async () => {
  const payload = await envelope(db);
  assert.equal(buildDiscordNotificationId(payload.kind, payload.sourceJobId), payload.notificationId);
  const results = await Promise.all([receive(db, payload), receive(db, payload)]);
  assert.deepEqual(results.map(row => row.disposition).sort(), ['accepted', 'duplicate']);
  const [hash] = await db`SELECT discord_notification_hash('{"n":2}'::jsonb) = discord_notification_hash('{"n":2.00}'::jsonb) AS same`;
  assert.equal(hash.same, true);
  await assert.rejects(receive(db, { ...payload, schemaVersion: 2 }), rejected('DN409'));
  await assert.rejects(receive(db, { ...payload, data: { ...payload.data, summary: 'changed' } }), rejected('DN409'));
  assert.equal((await get(db, payload.notificationId)).payload.data.summary, payload.data.summary);
  const next = await envelope(db, 'ocr_completed', 'job-2');
  assert.equal((await receive(db, next)).disposition, 'accepted');
});

test('receipt rollback leaves nothing; commit without a response remains claimable', async () => {
  const payload = await envelope(db);
  await assert.rejects(db.begin(async tx => {
    await receive(tx, payload);
    throw new Error('simulated receiver failure before commit');
  }), /before commit/);
  assert.equal(await get(db, payload.notificationId), undefined);
  await db.begin(tx => receive(tx, payload));
  assert.equal((await claim(db))[0].id, payload.notificationId);
});

test('result notifications cannot enter attendance ordering or startup recovery', async () => {
  const payload = await envelope(db);
  await receive(db, payload);
  await assert.rejects(db`INSERT INTO discord_notification_attendance(notification_id, session_id, aggregate_revision, ordinal)
    VALUES (${payload.notificationId}, NULL, 0, 0)`, rejected('23514'));
  assert.equal((await get(db, payload.notificationId)).family, 'result');
  assert.equal((await db`SELECT count(*)::int AS count FROM discord_notification_attendance`)[0].count, 0);
});

test('unreceived producer success is not reconstructed from business records', async () => {
  const rows = await claim(db);
  assert.equal(rows.length, 0);
  assert.equal((await db`SELECT count(*)::int AS count FROM discord_notifications`)[0].count, 0);
});

test('OFF after receipt commit cancels the receipt that was racing it', async () => {
  const payload = await envelope(db);
  const receiptReady = barrier(); const commitReceipt = barrier(); const setterReady = barrier();
  const receipt = db.begin(async tx => {
    const result = await receive(tx, payload); receiptReady.release(); await commitReceipt.promise; return result;
  });
  await receiptReady.promise;
  const off = db.begin(async tx => {
    const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`; setterReady.release(pid);
    await tx`SELECT set_discord_notification_setting('ocr_completed',false)`;
  });
  try { await waitForAdvisoryWait(db, await setterReady.promise); }
  finally { commitReceipt.release(); }
  await Promise.all([receipt, off]);
  assert.equal((await get(db, payload.notificationId)).status, 'CANCELLED');
  assert.equal((await claim(db)).length, 0);
});

test('OFF then ON before a delayed receipt commits invalidates the old generation', async () => {
  const payload = await envelope(db);
  const changed = barrier(); const commit = barrier(); const receiverReady = barrier();
  const settings = db.begin(async tx => {
    await tx`SELECT set_discord_notification_setting('ocr_completed',false)`;
    await tx`SELECT set_discord_notification_setting('ocr_completed',true)`;
    changed.release(); await commit.promise;
  });
  await changed.promise;
  const receipt = db.begin(async tx => {
    const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`; receiverReady.release(pid);
    return receive(tx, payload);
  });
  try { await waitForAdvisoryWait(db, await receiverReady.promise); }
  finally { commit.release(); }
  await settings;
  assert.equal((await receipt).disposition, 'cancelled');
  assert.equal((await get(db, payload.notificationId)).cancel_reason, 'stale_generation');
  assert.equal((await receive(db, payload)).disposition, 'duplicate');
});

test('success-time setting capture holds the generation boundary until business commit', async () => {
  const successReady = barrier(); const commit = barrier(); const setterReady = barrier();
  const success = db.begin(async tx => {
    const [setting] = await tx`SELECT * FROM get_discord_notification_setting('ocr_completed')`;
    successReady.release(); await commit.promise; return setting;
  });
  await successReady.promise;
  const off = db.begin(async tx => {
    const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`; setterReady.release(pid);
    return tx`SELECT * FROM set_discord_notification_setting('ocr_completed',false)`;
  });
  try { await waitForAdvisoryWait(db, await setterReady.promise); }
  finally { commit.release(); }
  const captured = await success; const [current] = await off;
  assert.equal(captured.enabled, true);
  assert.equal(BigInt(current.generation), BigInt(captured.generation) + 1n);
});

test('source-row lock before deletion does not deadlock receipt; deletion cancels in its transaction', async () => {
  const payload = await envelope(db);
  const sourceLocked = barrier(); const deleteNow = barrier(); const receiptReady = barrier(); const commitReceipt = barrier();
  const deletion = db.begin(async tx => {
    await tx`SELECT 1 FROM match_drafts WHERE id = 'notification-draft' FOR UPDATE`;
    const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`; sourceLocked.release(pid);
    await deleteNow.promise;
    await tx`DELETE FROM match_drafts WHERE id = 'notification-draft'`;
  });
  const deletingPid = await sourceLocked.promise;
  const receipt = db.begin(async tx => { await receive(tx, payload); receiptReady.release(); await commitReceipt.promise; });
  await receiptReady.promise; deleteNow.release();
  try { await waitForAdvisoryWait(db, deletingPid); }
  finally { commitReceipt.release(); }
  await Promise.all([receipt, deletion]);
  assert.equal((await get(db, payload.notificationId)).status, 'CANCELLED');
  assert.equal((await db`SELECT count(*)::int AS count FROM discord_notification_targets`)[0].count, 1);
});

test('confirmation cancels A and deleting any listed match cancels the entire B', async () => {
  const a = await envelope(db); const b = await envelope(db, 'analysis_completed');
  await receive(db, a); await receive(db, b);
  await db`UPDATE match_drafts SET status = 'confirmed', confirmed_match_id = 'notification-match-1' WHERE id = 'notification-draft'`;
  assert.equal((await get(db, a.notificationId)).status, 'CANCELLED');
  assert.equal((await get(db, b.notificationId)).status, 'PENDING');
  await db`DELETE FROM matches WHERE id = 'notification-match-1'`;
  assert.equal((await get(db, b.notificationId)).status, 'CANCELLED');
  assert.deepEqual((await get(db, b.notificationId)).payload.data.matches, b.data.matches);
});

test('a competing target writer never takes the notification lock before source-row locks', async () => {
  const payload = await envelope(db); await receive(db, payload);
  const locked = barrier(); const deleteNow = barrier(); const updaterReady = barrier();
  const deletion = db.begin(async tx => {
    await tx`SELECT 1 FROM match_drafts WHERE id = 'notification-draft' FOR UPDATE`;
    locked.release(); await deleteNow.promise;
    await tx`DELETE FROM match_drafts WHERE id = 'notification-draft'`;
  });
  await locked.promise;
  const update = db.begin(async tx => {
    const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`;
    updaterReady.release(pid);
    return tx`UPDATE match_drafts SET status = 'confirmed', confirmed_match_id = 'notification-match-1'
      WHERE id = 'notification-draft' RETURNING id`;
  });
  try { await waitForRowWait(db, await updaterReady.promise); }
  finally { deleteNow.release(); }
  const [, updated] = await Promise.all([deletion, update]);
  assert.equal(updated.length, 0);
  assert.equal((await get(db, payload.notificationId)).status, 'CANCELLED');
});

test('OFF after claim but before send start denies external delivery', async () => {
  const payload = await envelope(db); await receive(db, payload);
  const [row] = await claim(db); await plan(db, row);
  await db`SELECT set_discord_notification_setting('ocr_completed',false)`;
  assert.equal(await begin(db, row), false);
  assert.equal(await complete(db, row), false);
});

test('split delivery retains completed and in-flight evidence and never resumes after OFF/ON', async () => {
  const payload = await envelope(db, 'analysis_completed'); await receive(db, payload);
  const [row] = await claim(db); assert.equal(await plan(db, row, 3), true);
  assert.equal(await begin(db, row, 1), false);
  assert.equal(await begin(db, row, 0), true); assert.equal(await complete(db, row, 0), true);
  assert.equal(await begin(db, row, 1), true);
  await db`SELECT set_discord_notification_setting('analysis_completed',false)`;
  assert.equal(await complete(db, row, 1), true);
  await db`SELECT set_discord_notification_setting('analysis_completed',true)`;
  assert.equal(await begin(db, row, 2), false);
  assert.equal((await get(db, row.id)).status, 'CANCELLED');
  assert.deepEqual((await db`SELECT part_no, status, delivered_message_id FROM discord_notification_parts ORDER BY part_no`).map(r => ({ ...r })), [
    { part_no: 0, status: 'DELIVERED', delivered_message_id: 'message-0' },
    { part_no: 1, status: 'DELIVERED', delivered_message_id: 'message-1' },
    { part_no: 2, status: 'CANCELLED', delivered_message_id: null }
  ]);
  assert.equal((await claim(db, at(2000))).length, 0);
});

test('expired owners cannot start or finalize; new claim resumes only unfinished parts', async () => {
  const payload = await envelope(db, 'analysis_completed'); await receive(db, payload);
  const [old] = await claim(db); await plan(db, old, 2);
  await begin(db, old, 0); await complete(db, old, 0); await begin(db, old, 1);
  assert.equal(await complete(db, old, 1, at(1001)), false);
  const [current] = await claim(db, at(1001));
  assert.notEqual(current.claim_token, old.claim_token);
  assert.equal(await complete(db, old, 1, at(1001)), false);
  assert.equal(await begin(db, current, 0, at(1001)), false);
  assert.equal(await begin(db, current, 1, at(1001)), true);
  assert.equal(await complete(db, current, 1, at(1001)), true);
  assert.equal((await get(db, old.id)).status, 'DELIVERED');
});

test('bounded retry preserves sent parts and attendance startup never reopens result failures', async () => {
  const payload = await envelope(db); await receive(db, payload);
  await db`UPDATE discord_notifications SET max_attempts = 2 WHERE id = ${payload.notificationId}`;
  let [row] = await claim(db); await plan(db, row); await begin(db, row);
  assert.equal((await db`SELECT fail_discord_notification(${row.id},${row.claim_token},'discord_unavailable',${at(10)},${now}) AS ok`)[0].ok, true);
  assert.equal((await claim(db)).length, 0);
  [row] = await claim(db, at(10)); await begin(db, row, 0, at(10));
  await db`SELECT fail_discord_notification(${row.id},${row.claim_token},'discord_unavailable',${at(20)},${at(10)})`;
  assert.equal((await get(db, row.id)).status, 'FAILED');
  await db`SELECT * FROM requeue_discord_attendance_chains(${at(20)})`;
  assert.equal((await get(db, row.id)).status, 'FAILED');
  assert.equal((await db`SELECT retry_discord_result_notification(${row.id},${at(20)}) AS ok`)[0].ok, true);
  assert.equal((await claim(db, at(20)))[0].attempt_count, 1);
});

test('crashes at the final claim exhaust retries instead of claiming forever', async () => {
  const payload = await envelope(db); await receive(db, payload);
  await db`UPDATE discord_notifications SET max_attempts = 1 WHERE id = ${payload.notificationId}`;
  assert.equal((await claim(db)).length, 1);
  assert.equal((await claim(db, at(1001))).length, 0);
  assert.equal((await get(db, payload.notificationId)).status, 'FAILED');
});

test('fixed B survives source-job deletion and later business edits with full note and tiny delta', async () => {
  const payload = await envelope(db, 'analysis_completed'); await receive(db, payload);
  await db`INSERT INTO series_analysis_jobs(id, game_title_id, input_revision, algorithm_version, artifact_schema_version, trigger)
    VALUES (${payload.sourceJobId},'notification-title',0,'v4',4,'manual')`;
  await db`DELETE FROM series_analysis_jobs WHERE id = ${payload.sourceJobId}`;
  await db`UPDATE game_titles SET name = 'Changed later' WHERE id = 'notification-title'`;
  await db`UPDATE matches SET note_body = 'Changed later', note_version = 1, note_updated_by_account_id = 'notification-account', note_updated_at = ${now} WHERE id = 'notification-match-1'`;
  const stored = (await get(db, payload.notificationId)).payload;
  assert.deepEqual(stored, payload);
  assert.equal(stored.data.overall[0].delta, -0.0001);
  assert.equal(stored.data.matches[0].players.length, 4);
  assert.equal(stored.data.matches[0].note, payload.data.matches[0].note);
  await assert.rejects(db`UPDATE discord_notifications SET payload = '{}'::jsonb WHERE id = ${payload.notificationId}`, rejected('23514'));
  await assert.rejects(db`DELETE FROM discord_notifications WHERE id = ${payload.notificationId}`, rejected('23514'));
});

test('purge keeps a permanent identity/hash tombstone and cannot purge active work', async () => {
  const payload = await envelope(db); await receive(db, payload);
  const [row] = await claim(db); await plan(db, row); await begin(db, row); await complete(db, row);
  assert.equal((await db`SELECT * FROM purge_discord_notifications(${at(6 * 86400000)})`).length, 0);
  assert.equal((await db`SELECT * FROM purge_discord_notifications(${at(7 * 86400000)})`).length, 1);
  const tombstone = await get(db, payload.notificationId);
  assert.equal(tombstone.payload, null); assert.equal(tombstone.status, 'DELIVERED');
  assert.equal((await receive(db, payload)).disposition, 'duplicate');
  await assert.rejects(receive(db, { ...payload, data: { ...payload.data, summary: 'changed' } }), rejected('DN409'));
  const pending = await envelope(db, 'ocr_completed', 'pending'); await receive(db, pending);
  await db`SELECT * FROM purge_discord_notifications(${at(90 * 86400000)})`;
  assert.notEqual((await get(db, pending.notificationId)).payload, null);
});

test('failed and cancelled retention is thirty days and cancellation stays final after purge', async () => {
  const payload = await envelope(db); await receive(db, payload);
  await db`SELECT cancel_discord_notification(${payload.notificationId},'draft_unavailable',${now})`;
  assert.equal((await db`SELECT * FROM purge_discord_notifications(${at(29 * 86400000)})`).length, 0);
  assert.equal((await db`SELECT * FROM purge_discord_notifications(${at(30 * 86400000)})`).length, 1);
  assert.equal((await receive(db, payload)).status, 'CANCELLED');
  assert.equal((await db`SELECT retry_discord_result_notification(${payload.notificationId}) AS ok`)[0].ok, false);
});

test('v1 distinguishes initial, empty, incomparable and reused snapshots and rejects incomplete B', async () => {
  for (const comparison of ['initial', 'empty', 'incomparable', 'reused']) {
    const payload = await envelope(db, 'analysis_completed', comparison);
    const ranks = members.map(member => ({ ...member, before: comparison === 'initial' ? null : { matchCount: comparison === 'empty' ? 0 : 1, averageRank: comparison === 'empty' ? null : 2.5 },
      after: { matchCount: comparison === 'empty' ? 0 : 1, averageRank: comparison === 'empty' ? null : 2.5 }, delta: comparison === 'reused' ? 0 : null, comparison }));
    payload.data.matches = []; payload.data.overall = ranks; payload.data.seasons = [];
    if (comparison === 'reused') { payload.data.disposition = 'reused'; payload.data.previousAnalysis = payload.data.currentAnalysis; }
    assert.equal((await receive(db, payload)).disposition, 'accepted');
  }
  const invalid = await envelope(db, 'analysis_completed', 'invalid');
  invalid.data.matches[0].players.pop();
  await assert.rejects(receive(db, invalid), rejected('DN400'));
  const unsupported = await envelope(db, 'analysis_completed', 'future'); unsupported.schemaVersion = 2;
  await assert.rejects(receive(db, unsupported), rejected('DN422'));
});

test('v1 rejects malformed context, duplicate ranks and unknown comparisons before persistence', async () => {
  const cases = [
    ['ocr_completed', data => { data.context.matchNoInEvent = 'one'; }],
    ['ocr_completed', data => { data.context.heldDateIso = '2026-02-31'; }],
    ['analysis_completed', data => { data.matches[0].players[0].rank = 2; }],
    ['analysis_completed', data => { data.matches[0].ownerName = {}; }],
    ['analysis_completed', data => { data.currentAnalysis.artifactSchemaVersion = 1.5; }],
    ['analysis_completed', data => { data.overall[0].delta = null; }]
  ];
  for (const [index, [kind, mutate]] of cases.entries()) {
    const payload = await envelope(db, kind, 'invalid-' + index);
    mutate(payload.data);
    await assert.rejects(receive(db, payload), rejected('DN400'));
    assert.equal(await get(db, payload.notificationId), undefined);
  }
  const legacy = await envelope(db, 'analysis_completed', 'legacy-previous');
  legacy.data.previousAnalysis.validationContractId = null;
  legacy.data.previousAnalysis.artifactSchemaVersion = 1;
  legacy.data.overall = legacy.data.overall.map(rank => ({ ...rank, comparison: 'incomparable', delta: null }));
  legacy.data.seasons = [];
  assert.equal((await receive(db, legacy)).disposition, 'accepted');
});

test('documented v1 envelopes satisfy the receiver contract', async () => {
  for (const name of ['ocr-completed-v1', 'analysis-completed-v1']) {
    const payload = JSON.parse(readFileSync(new URL('../docs/examples/' + name + '.json', import.meta.url), 'utf8'));
    const receipt = await receive(db, payload);
    assert.equal(receipt.disposition, 'cancelled');
    assert.equal((await get(db, payload.notificationId)).payload.schemaVersion, 1);
  }
});

test('purged attendance failures retain dedupe when their ended Session is removed', async () => {
  await db`INSERT INTO sessions(id,week_key,candidate_date_iso,status,channel_id,deadline_at)
    VALUES ('ended-attendance','notification-week','2026-01-01','COMPLETED','test-channel',${now})`;
  const enqueue = () => db`SELECT * FROM enqueue_discord_attendance_notification(
    'attendance-purge','ended-attendance','{"kind":"send_message","renderer":"ask_body","channelId":"test-channel"}'::jsonb,
    'attendance-purge',0,0::smallint,${now})`;
  await enqueue();
  const [row] = await claim(db, now, 'attendance');
  await db`SELECT fail_discord_notification(${row.id},${row.claim_token},'delivery_failed',NULL,${now})`;
  await db`SELECT * FROM purge_discord_notifications(${at(30 * 86400000)})`;
  await db`DELETE FROM sessions WHERE id = 'ended-attendance'`;
  assert.equal((await get(db, row.id)).status, 'FAILED');
  assert.equal((await get(db, row.id)).payload, null);
  assert.equal((await enqueue())[0].skipped, true);
  assert.equal((await claim(db, at(31 * 86400000), 'attendance')).length, 0);
});
