import { createHash } from 'node:crypto';
import { resetFixtures } from './notification-fixtures.mjs';

export const legacy = Object.freeze({
  title: 'notification-title', member: 'notification-member-1', account: 'notification-account',
  session: 'session:legacy:01', event: 'notification-held', match: 'notification-match-1', draft: 'notification-draft',
  job: 'analysis:legacy-job', attempt: 'analysis:legacy-attempt', request: 'analysis:legacy-request',
  operation: 'analysis:legacy-operation', campaign: 'analysis:legacy-campaign',
  artifact: 'artifact:legacy-current', previousArtifact: 'artifact:legacy-previous',
  basis: 'radar:legacy-basis', previousBasis: 'radar:legacy-before', candidate: 'radar:legacy-candidate',
  preview: 'radar:legacy-preview', radarOperation: 'radar:legacy-operation',
  image: 'image:legacy-metadata', ocrJob: 'ocr:legacy-job', ocrDraft: 'ocr:legacy-draft',
  submission: '11111111-2222-4333-8444-555555555555',
});
export const validationContract = 'series-analysis-artifact-v5-full-validation-v1';
export const payload = Buffer.from('{"memberId":"notification-member-1","precise":9007199254740993.123456789,"scope":"season:notification-season"}');
export const checksum = 'sha256:' + createHash('sha256').update(payload).digest('hex');

// Every converted column has a non-null representative. Opaque values include
// identifiers and precise JSON numbers deliberately excluded from conversion.
export async function seedCanonicalSource(db) {
  await resetFixtures(db);
  for (const [index, id] of ['7', 'é', 'e\u0301', '{00112233-4455-6677-8899-AABBCCDDEEFF}',
    '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff'].entries()) {
    await db`INSERT INTO members(id, user_id, display_name) VALUES (${id}, ${'preserved-spelling-' + index}, 'Exact legacy spelling')`;
  }
  await db`INSERT INTO member_aliases(id, member_id, alias) VALUES ('alias:legacy', ${legacy.member}, '旧名')`;
  await db`UPDATE momo_login_accounts SET player_member_id = ${legacy.member} WHERE id = ${legacy.account}`;
  await db`INSERT INTO sessions(id, week_key, candidate_date_iso, status, channel_id, deadline_at, revision)
    VALUES (${legacy.session}, '2030-W01', '2030-01-04', 'DECIDED', 'discord-channel:unchanged', '2030-01-04', 9007199254740993)`;
  await db`INSERT INTO responses(id, session_id, member_id, choice, source_interaction_id)
    VALUES ('response:legacy', ${legacy.session}, ${legacy.member}, 'T2200', 99999999999999999999)`;
  await db`UPDATE held_events SET session_id = ${legacy.session} WHERE id = ${legacy.event}`;
  await db`INSERT INTO held_event_participants(held_event_id, member_id) VALUES (${legacy.event}, ${legacy.member})`;
  await db`INSERT INTO app_sessions(id_hash, member_id, account_id, csrf_secret_hash, expires_at)
    VALUES ('session-hash:unchanged', 'deleted-member:retained', ${legacy.account}, 'csrf-hash:unchanged', '2030-01-01')`;
  await db`INSERT INTO oauth_state_consumptions(state_hash, expires_at) VALUES ('oauth-state:unchanged', '2030-01-01')`;
  for (const key of ['Legacy-Key:1', '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']) {
    await db`INSERT INTO idempotency_keys(key, member_id, account_id, endpoint, request_hash,
      response_status, response_headers, response_body, created_at, expires_at)
      VALUES (${key}, ${legacy.member}, ${legacy.account}, '/legacy/matches', ${Buffer.from([0, 255, 13, 10])},
        201, '{"x-legacy":"exact"}', ${Buffer.from('{"matchId":"notification-match-1"}\r\n')},
        '2025-12-31T23:59:59.123456Z', '2026-01-01T00:05:00.654321Z')`;
  }
  await db`UPDATE match_drafts SET created_by_member_id = ${legacy.member}, held_event_id = ${legacy.event},
    match_no_in_event = 3, game_title_id = ${legacy.title}, season_master_id = 'notification-season',
    owner_member_id = ${legacy.member}, map_master_id = 'notification-map', confirmed_match_id = 'notification-match-2',
    total_assets_draft_id = ${legacy.ocrDraft}, revenue_draft_id = 'deleted-ocr-draft:revenue',
    incident_log_draft_id = 'reserved-ocr-draft:incident', total_assets_image_id = 'opaque:image:unchanged'
    WHERE id = ${legacy.draft}`;
  await db`UPDATE matches SET created_by_member_id = ${legacy.member}, note_body = 'saved note\nexact', note_version = 1,
    note_updated_by_account_id = ${legacy.account}, note_updated_at = '2026-01-01T00:00:00.123456Z',
    analysis_revision = 9007199254740993, total_assets_draft_id = ${legacy.ocrDraft}
    WHERE id = ${legacy.match}`;
  await db`INSERT INTO match_players(match_id, member_id, play_order, rank, total_assets_man_yen, revenue_man_yen)
    VALUES (${legacy.match}, ${legacy.member}, 1, 1, -200, 999)`;
  await db`INSERT INTO match_incidents(match_id, member_id, incident_master_id, count)
    SELECT ${legacy.match}, ${legacy.member}, id, 3 FROM incident_masters ORDER BY id COLLATE "C" LIMIT 1`;
  await db`INSERT INTO source_images(id, owner_account_id, object_key, idempotency_key_hash)
    VALUES (${legacy.image}, ${legacy.account}, 'legacy/object/key.png', ${'a'.repeat(64)})`;
  await db`INSERT INTO ocr_jobs(id, draft_id, image_id, image_path, source_image_id, requested_screen_type,
    status, input_snapshot, lease_fencing_token)
    VALUES (${legacy.ocrJob}, ${legacy.ocrDraft}, 'opaque:image:unchanged', '/legacy/image.png', ${legacy.image},
      'total_assets', 'failed', '{"schemaVersion":"2","layoutFamilyHint":" MOMOTETSU2 ","precise":9007199254740993.123456789}', 9007199254740993)`;
  await db`INSERT INTO ocr_drafts(id, job_id, requested_screen_type, profile_id, payload_json)
    VALUES (${legacy.ocrDraft}, ${legacy.ocrJob}, 'total_assets', 'legacy-profile:unchanged',
      '{"memberId":"notification-member-1","precise":9007199254740993.123456789}')`;
  await db`INSERT INTO ocr_submissions(id, owner_account_id, match_draft_id, admission_deadline, created_at)
    VALUES (${legacy.submission}, ${legacy.account}, ${legacy.draft}, '2030-01-01', '2026-01-01')`;
  await db`INSERT INTO ocr_submission_members(submission_id, screen_type, upload_idempotency_key_hash,
    image_sha256_hex, image_byte_length, status, job_id)
    VALUES (${legacy.submission}, 'total_assets', ${'b'.repeat(64)}, ${'c'.repeat(64)}, 128, 'registered', ${legacy.ocrJob})`;

  await db`INSERT INTO series_analysis_operation_requests(id, scope, game_title_id, requested_by_account_id,
    idempotency_key_hash, endpoint, status, target_count)
    VALUES (${legacy.operation}, 'title', ${legacy.title}, ${legacy.account}, 'operation-key:unchanged', '/analysis', 'running', 1)`;
  await db`INSERT INTO series_analysis_campaigns(id, operation_request_id, trigger, algorithm_version,
    artifact_schema_version, validation_contract_id, target_count)
    VALUES (${legacy.campaign}, ${legacy.operation}, 'manual', 'series-analysis-v6', 5, ${validationContract}, 1)`;
  for (const [id, title] of [[legacy.basis, legacy.title], [legacy.previousBasis, legacy.title], ['radar:unreferenced', legacy.title]]) {
    await db`INSERT INTO series_radar_bases(id, game_title_id, checksum, payload, source_snapshot, source_checksum, source_input_revision)
      VALUES (${id}, ${title}, ${checksum}, '{"memberId":"notification-member-1","precise":9007199254740993.123456789}',
        '{"matches":[{"id":"notification-match-1"}],"precise":9007199254740993.123456789}', ${checksum}, 9007199254740993)`;
  }
  await db`INSERT INTO series_radar_candidates(id, game_title_id, basis_id, origin_kind, manual_input,
    source_basis_id, source_candidate_id, saved_by, saved_by_display_name, status)
    VALUES (${legacy.candidate}, ${legacy.title}, ${legacy.basis}, 'manual', '{"axes":[1,2,3]}',
      ${legacy.previousBasis}, 'deleted-candidate:provenance', ${legacy.account}, 'Saved name', 'applied')`;
  await db`INSERT INTO series_radar_previews(id, game_title_id, candidate_id, before_basis_id, input_revision, status, evaluation_snapshot)
    VALUES (${legacy.preview}, ${legacy.title}, ${legacy.candidate}, ${legacy.previousBasis}, 9007199254740993,
      'ready', '{"matchId":"notification-match-1","precise":9007199254740993.123456789}')`;
  await db`INSERT INTO series_radar_preview_scopes(preview_id, scope_key, payload)
    VALUES (${legacy.preview}, 'season:notification-season', '{"memberId":"notification-member-1"}')`;
  await db`INSERT INTO series_radar_operations(id, game_title_id, kind, status, candidate_id, preview_id,
    basis_id, origin_operation_id, requested_by, idempotency_key_hash, request_fingerprint, job_id)
    VALUES (${legacy.radarOperation}, ${legacy.title}, 'apply', 'running', ${legacy.candidate}, ${legacy.preview},
      ${legacy.basis}, 'deleted-radar-operation:retained', ${legacy.account}, 'radar-key:unchanged', 'fingerprint:unchanged', ${legacy.job})`;
  await db`INSERT INTO series_radar_title_states(game_title_id, desired_basis_id, current_basis_id, previous_basis_id,
    current_applied_at, previous_applied_at, generation, active_operation_id)
    VALUES (${legacy.title}, ${legacy.basis}, ${legacy.basis}, ${legacy.previousBasis},
      '2026-01-02T00:00:00.123456Z', '2026-01-01T00:00:00.123456Z', 2, ${legacy.radarOperation})`;
  await db`INSERT INTO series_radar_acknowledgements(game_title_id, evidence_key, requested_by)
    VALUES (${legacy.title}, 'encoded:legacy-evidence', ${legacy.account})`;
  await db`INSERT INTO series_radar_revisions(operation_id, game_title_id, candidate_id, before_basis_id, after_basis_id,
    change_kind, requested_by, saved_by, published_at)
    VALUES (${legacy.radarOperation}, ${legacy.title}, ${legacy.candidate}, ${legacy.previousBasis}, ${legacy.basis},
      'manual', ${legacy.account}, ${legacy.account}, '2026-01-02T00:00:00.123456Z')`;
  await db`INSERT INTO series_analysis_jobs(id, work_kind, radar_operation_id, radar_basis_id, radar_generation,
    game_title_id, input_revision, algorithm_version, artifact_schema_version, validation_contract_id, trigger,
    status, lease_owner, lease_attempt_id, lease_fencing_token, fencing_counter, lease_expires_at, lease_validation_contract_id)
    VALUES (${legacy.job}, 'radar_prepare', ${legacy.radarOperation}, ${legacy.basis}, 2, ${legacy.title},
      9007199254740993, 'series-analysis-v6', 5, ${validationContract}, 'manual', 'running', 'owner:unchanged',
      ${legacy.attempt}, 9007199254740993, 9007199254740993, '2030-01-01', ${validationContract})`;
  await db`INSERT INTO series_analysis_job_attempts(id, job_id, attempt_no, owner, fencing_token, input_revision,
    algorithm_version, artifact_schema_version, validation_contract_id, effective_config_version, calculation_timeout_milliseconds)
    VALUES (${legacy.attempt}, ${legacy.job}, 1, 'owner:unchanged', 9007199254740993, 9007199254740993,
      'series-analysis-v6', 5, ${validationContract}, 'config:unchanged', 10000)`;
  await db`INSERT INTO series_analysis_job_requests(id, game_title_id, operation_request_id, campaign_id,
    input_revision, algorithm_version, artifact_schema_version, validation_contract_id, trigger, status,
    assigned_job_id, assigned_attempt_id)
    VALUES (${legacy.request}, ${legacy.title}, ${legacy.operation}, ${legacy.campaign}, 9007199254740993,
      'series-analysis-v6', 5, ${validationContract}, 'manual', 'assigned', ${legacy.job}, ${legacy.attempt})`;
  await db`INSERT INTO series_analysis_campaign_targets(campaign_id, game_title_id, input_revision,
    algorithm_version, artifact_schema_version, validation_contract_id, job_request_id)
    VALUES (${legacy.campaign}, ${legacy.title}, 9007199254740993, 'series-analysis-v6', 5, ${validationContract}, ${legacy.request})`;
  await db`UPDATE worker_execution_slots SET task_kind = 'analysis', owner = 'owner:unchanged', job_id = ${legacy.job},
    attempt_id = ${legacy.attempt}, holder_preemptible = true, lease_expires_at = '2030-01-01', fencing_token = 9007199254740993`;
  await db`INSERT INTO series_analysis_worker_capabilities(worker_id, algorithm_versions, artifact_schema_versions, validation_contract_ids)
    VALUES ('worker:unchanged', '["series-analysis-v6"]', '[5]', ${JSON.stringify([validationContract])}::text::jsonb)`;
  await db`INSERT INTO series_analysis_reader_capabilities(reader_id, artifact_schema_versions, validation_contract_ids)
    VALUES ('reader:unchanged', '[5]', ${JSON.stringify([validationContract])}::text::jsonb)`;

  for (const id of [legacy.artifact, legacy.previousArtifact, 'artifact:sealed-staging']) {
    await db`INSERT INTO series_analysis_artifacts(id, game_title_id, attempt_id, input_revision, algorithm_version,
      artifact_schema_version, source_input_checksum, root_checksum, aggregate_chunk_count, review_chunk_count,
      drilldown_chunk_count, match_context_chunk_count, outlook_summary_chunk_count, outlook_reference_chunk_count,
      encoded_bytes, decoded_bytes, radar_basis_id, radar_generation, scope_keys)
      VALUES (${id}, ${legacy.title}, ${legacy.attempt}, 9007199254740993, 'series-analysis-v6', 5, ${checksum}, ${checksum},
        1, 1, 1, 1, 1, 1, ${payload.length}, ${payload.length}, ${legacy.basis}, 2, ARRAY['overall','season:notification-season'])`;
    for (const table of ['series_analysis_scope_aggregate_artifacts', 'series_analysis_scope_review_artifacts', 'series_analysis_outlook_summary_artifacts']) {
      await db`INSERT INTO ${db(table)}(artifact_id, scope_key, scope_kind, payload, encoded_bytes, decoded_bytes, item_count, nesting_depth, checksum)
        VALUES (${id}, 'overall', 'overall', ${payload}, ${payload.length}, ${payload.length}, 0, 2, ${checksum})`;
    }
    await db`INSERT INTO series_analysis_drilldown_artifacts(artifact_id, scope_key, scope_kind, season_master_id,
      map_master_id, member_id, metric_id, payload, encoded_bytes, decoded_bytes, item_count, nesting_depth, checksum)
      VALUES (${id}, 'season_map:notification-season:notification-map', 'season_map', 'notification-season', 'notification-map',
        ${legacy.member}, 'legacy-metric', ${payload}, ${payload.length}, ${payload.length}, 1, 2, ${checksum})`;
    await db`INSERT INTO series_analysis_match_context_artifacts(artifact_id, scope_key, scope_kind, match_id,
      source_match_revision, payload, encoded_bytes, decoded_bytes, item_count, nesting_depth, checksum)
      VALUES (${id}, 'overall', 'overall', ${legacy.match}, 9007199254740993, ${payload}, ${payload.length}, ${payload.length}, 1, 2, ${checksum})`;
    await db`INSERT INTO series_analysis_outlook_reference_artifacts(artifact_id, scope_key, scope_kind, member_id,
      payload, encoded_bytes, decoded_bytes, item_count, nesting_depth, checksum)
      VALUES (${id}, 'overall', 'overall', ${legacy.member}, ${payload}, ${payload.length}, ${payload.length}, 1, 2, ${checksum})`;
    await db`UPDATE series_analysis_artifacts SET validation_contract_id = ${validationContract} WHERE id = ${id}`;
    if (id !== 'artifact:sealed-staging') await db`UPDATE series_analysis_artifacts SET status = 'published',
      published_at = '2026-01-02T00:00:00.123456Z', radar_applied_at = '2026-01-02T00:00:00.123456Z' WHERE id = ${id}`;
  }
  await db`UPDATE series_analysis_title_states SET input_revision = 9007199254740993,
    algorithm_version = 'series-analysis-v6', artifact_schema_version = 5, validation_contract_id = ${validationContract},
    current_artifact_id = ${legacy.artifact}, previous_artifact_id = ${legacy.previousArtifact},
    notification_baseline_state = 'artifact', notification_baseline_artifact_id = ${legacy.artifact}
    WHERE game_title_id = ${legacy.title}`;
  for (const [id, family, kind] of [['attendance:legacy', 'attendance', 'send_message'], ['result:analysis_completed:analysis:legacy-job', 'result', 'analysis_completed']]) {
    await db`INSERT INTO discord_notifications(id, family, kind, dedupe_key, payload, payload_hash, part_count, renderer_version, delivery_context)
      VALUES (${id}, ${family}, ${kind}, ${id}, '{"accountId":"notification-account","precise":9007199254740993.123456789}',
        ${'d'.repeat(64)}, 1, 2, '{"legacyUrl":"/matches/notification-match-1","channelId":"discord:unchanged"}')`;
    await db`INSERT INTO discord_notification_parts(notification_id, part_no, status, delivered_at, delivered_message_id)
      VALUES (${id}, 0, 'DELIVERED', '2026-01-02T00:00:00.123456Z', 'discord-message:unchanged')`;
  }
  await db`INSERT INTO discord_notification_attendance(notification_id, session_id, aggregate_revision, ordinal)
    VALUES ('attendance:legacy', ${legacy.session}, 9007199254740993, 0)`;
  await db`INSERT INTO discord_notification_results(notification_id, kind, source_job_id, occurred_at, settings_generation)
    VALUES ('result:analysis_completed:analysis:legacy-job', 'analysis_completed', ${legacy.job}, '2026-01-02T00:00:00.123456Z', 0)`;
  await db`INSERT INTO discord_notification_targets(notification_id, target_kind, target_id)
    VALUES ('result:analysis_completed:analysis:legacy-job', 'match', ${legacy.match})`;
}
