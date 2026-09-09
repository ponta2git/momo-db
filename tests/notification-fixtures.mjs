import postgres from 'postgres';

export function createTestClient(database = process.env.MOMO_DB_TEST_DATABASE) {
  const host = process.env.MOMO_DB_TEST_HOST ?? '127.0.0.1';
  if (!database?.startsWith('momo_db_test_') || !['127.0.0.1', 'localhost'].includes(host)) {
    throw new Error('Notification integration tests require a local MOMO_DB_TEST_DATABASE named momo_db_test_*');
  }
  return postgres({
    host, database, port: Number(process.env.MOMO_DB_TEST_PORT ?? 5432),
    username: process.env.MOMO_DB_TEST_USER ?? 'postgres',
    password: process.env.MOMO_DB_TEST_PASSWORD,
    max: 8, prepare: false, onnotice() {},
    connection: { statement_timeout: 5000, lock_timeout: 4000 }
  });
}

export const now = new Date('2026-01-01T00:00:00.000Z');
export const at = (milliseconds) => new Date(now.getTime() + milliseconds);
export const members = [1, 2, 3, 4].map(i => ({ memberId: `notification-member-${i}`, displayName: `Player ${i}` }));

export async function resetFixtures(db) {
  // The dedicated database name/host guard above is mandatory before this reset.
  await db`TRUNCATE public.discord_notifications, public.match_drafts, public.matches,
    public.held_events, public.sessions, public.ocr_jobs, public.series_analysis_jobs CASCADE`;
  await db`UPDATE public.discord_notification_settings SET enabled = true`;
  for (const [i, member] of members.entries()) {
    await db`INSERT INTO members(id, user_id, display_name) VALUES (${member.memberId}, ${`notification-user-${i}`}, ${member.displayName}) ON CONFLICT DO NOTHING`;
  }
  await db`INSERT INTO momo_login_accounts(id, discord_user_id, display_name) VALUES ('notification-account','notification-account-user','Test account') ON CONFLICT DO NOTHING`;
  await db`INSERT INTO game_titles(id, name, layout_family) VALUES ('notification-title','Notification test title','momotetsu_2') ON CONFLICT DO NOTHING`;
  await db`INSERT INTO season_masters(id, game_title_id, name) VALUES ('notification-season','notification-title','Test season') ON CONFLICT DO NOTHING`;
  await db`INSERT INTO map_masters(id, game_title_id, name) VALUES ('notification-map','notification-title','Test map') ON CONFLICT DO NOTHING`;
  await db`INSERT INTO held_events(id, held_date_iso, start_at) VALUES ('notification-held','2026-01-01',${now})`;
  await db`INSERT INTO match_drafts(id, created_by_account_id, status) VALUES ('notification-draft','notification-account','draft_ready')`;
  for (const i of [1, 2]) {
    await db`INSERT INTO matches(id, held_event_id, match_no_in_event, game_title_id, layout_family,
      season_master_id, owner_member_id, map_master_id, played_at, created_by_account_id)
      VALUES (${`notification-match-${i}`},'notification-held',${i},'notification-title','momotetsu_2',
      'notification-season',${members[0].memberId},'notification-map',${now},'notification-account')`;
  }
}

export async function envelope(db, kind = 'ocr_completed', sourceJobId = 'job-1') {
  const [setting] = await db`SELECT * FROM get_discord_notification_setting(${kind})`;
  const analysis = { jobId: sourceJobId, inputRevision: '9007199254740993', algorithmVersion: 'v4', artifactSchemaVersion: 4, validationContractId: 'test-v4' };
  const ranks = members.map(member => ({ ...member, before: { matchCount: 10000, averageRank: 2.5001 }, after: { matchCount: 10001, averageRank: 2.5 }, delta: -0.0001, comparison: 'comparable' }));
  const data = kind === 'ocr_completed' ? {
    matchDraftId: 'notification-draft', ocrDraftId: 'notification-ocr-draft', imageId: 'notification-image',
    screenType: 'total_assets', outcome: 'needs_review', summary: '確認が必要な項目があります。',
    context: { gameTitleName: 'Snapshot title', heldDateIso: '2026-01-01', matchNoInEvent: 1 }
  } : {
    gameTitleId: 'notification-title', gameTitleName: 'Snapshot title', disposition: 'published',
    previousAnalysis: { ...analysis, jobId: 'previous-job', inputRevision: '9007199254740992' }, currentAnalysis: analysis,
    overall: ranks, seasons: [{ seasonId: 'notification-season', seasonName: 'Snapshot season', ranks }],
    matches: [1, 2].map(i => ({
      matchId: `notification-match-${i}`, sourceRevision: '2', heldEventId: 'notification-held', heldDateIso: '2026-01-01',
      matchNoInEvent: i, playedAt: now.toISOString(), mapName: 'Snapshot map', seasonId: 'notification-season',
      seasonName: 'Snapshot season', ownerName: 'Snapshot owner',
      players: members.map((member, index) => ({ ...member, rank: index + 1, ginjiCount: index })),
      ginjiTotal: 6, note: '全文を保持するメモ。\n'.repeat(400)
    }))
  };
  return { notificationId: `result:${kind}:${sourceJobId}`, kind, schemaVersion: 1, sourceJobId,
    occurredAt: now.toISOString(), settingsGeneration: String(setting.generation), data };
}

export const receive = async (db, payload) => (await db`SELECT * FROM receive_discord_result_notification(${db.json(payload)}, ${now})`)[0];
export const claim = async (db, time = now, family = 'result') => db`SELECT * FROM claim_discord_notifications(${family}, 20, ${time}, 1000)`;
export const plan = async (db, row, count = 1, time = now) => (await db`SELECT plan_discord_notification_parts(${row.id},${row.claim_token},${count},1,${time}) AS ok`)[0].ok;
export const begin = async (db, row, part = 0, time = now) => (await db`SELECT begin_discord_notification_part(${row.id},${part},${row.claim_token},${time}) AS ok`)[0].ok;
export const complete = async (db, row, part = 0, time = now) => (await db`SELECT complete_discord_notification_part(${row.id},${part},${row.claim_token},${`message-${part}`},${time}) AS ok`)[0].ok;
export const get = async (db, id) => (await db`SELECT * FROM discord_notifications WHERE id = ${id}`)[0];

export function barrier() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function waitForLock(db, pid, lockType) {
  for (let i = 0; i < 100; i++) {
    const [row] = await db`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ${pid} AND locktype = ${lockType} AND NOT granted) AS waiting`;
    if (row.waiting) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Expected transaction did not reach its database lock wait');
}

export const waitForAdvisoryWait = (db, pid) => waitForLock(db, pid, 'advisory');
export const waitForRowWait = (db, pid) => waitForLock(db, pid, 'transactionid');
