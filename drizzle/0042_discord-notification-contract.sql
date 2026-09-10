-- Requires every consumer/writer to be stopped for the coordinated cutover.
-- Preserve the old outbox's identity, content, order and delivery evidence before
-- the following schema migration removes its former shape.
INSERT INTO public.discord_notification_settings (kind) VALUES
  ('ocr_completed'), ('analysis_completed');
--> statement-breakpoint
CREATE FUNCTION public.discord_notification_canonical_json(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, public AS $$
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'number' THEN RETURN to_jsonb(trim_scale(value::text::numeric));
    WHEN 'object' THEN
      RETURN (SELECT coalesce(jsonb_object_agg(e.key, public.discord_notification_canonical_json(e.value)), '{}'::jsonb) FROM jsonb_each(value) e);
    WHEN 'array' THEN
      RETURN (SELECT coalesce(jsonb_agg(public.discord_notification_canonical_json(e.value) ORDER BY e.ordinality), '[]'::jsonb) FROM jsonb_array_elements(value) WITH ORDINALITY e);
    ELSE RETURN value;
  END CASE;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.discord_notification_hash(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT encode(sha256(convert_to(public.discord_notification_canonical_json(value)::text, 'UTF8')), 'hex');
$$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.discord_outbox WHERE status = 'IN_FLIGHT' AND (claim_token IS NULL OR claim_expires_at IS NULL)) THEN
    RAISE EXCEPTION 'notification_migration_invalid_claim' USING ERRCODE = '23514';
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO public.discord_notifications
  (id, family, kind, dedupe_key, payload, payload_hash, status, attempt_count,
   last_error, claim_token, claim_expires_at, next_attempt_at, part_count,
   renderer_version, delivered_at, terminal_at, created_at, updated_at)
SELECT id, 'attendance', kind, dedupe_key, payload, public.discord_notification_hash(payload),
  status, attempt_count, last_error, claim_token, claim_expires_at, next_attempt_at, 1, 1,
  delivered_at, CASE WHEN status = 'DELIVERED' THEN coalesce(delivered_at, updated_at)
    WHEN status IN ('FAILED','CANCELLED') THEN updated_at END, created_at, updated_at
FROM public.discord_outbox;
--> statement-breakpoint
INSERT INTO public.discord_notification_attendance (notification_id, session_id, aggregate_revision, ordinal)
SELECT id, session_id, aggregate_revision, ordinal FROM public.discord_outbox;
--> statement-breakpoint
INSERT INTO public.discord_notification_parts
  (notification_id, part_no, status, attempt_count, claim_token, send_started_at, delivered_at, delivered_message_id)
SELECT id, 0, CASE WHEN status = 'FAILED' THEN 'PENDING' ELSE status END, attempt_count,
  claim_token, CASE WHEN status = 'IN_FLIGHT' THEN updated_at END, delivered_at, delivered_message_id
FROM public.discord_outbox;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM public.discord_outbox o
    LEFT JOIN public.discord_notifications n ON n.id = o.id
    LEFT JOIN public.discord_notification_attendance a ON a.notification_id = o.id
    LEFT JOIN public.discord_notification_parts p ON p.notification_id = o.id AND p.part_no = 0
    WHERE n.id IS NULL OR a.notification_id IS NULL OR p.notification_id IS NULL
      OR (n.dedupe_key, n.payload, n.status, n.attempt_count, n.last_error,
          n.claim_token, n.claim_expires_at, n.next_attempt_at, n.delivered_at, n.created_at, n.updated_at,
          a.session_id, a.aggregate_revision, a.ordinal, p.delivered_message_id)
        IS DISTINCT FROM
         (o.dedupe_key, o.payload, o.status, o.attempt_count, o.last_error,
          o.claim_token, o.claim_expires_at, o.next_attempt_at, o.delivered_at, o.created_at, o.updated_at,
          o.session_id, o.aggregate_revision, o.ordinal, o.delivered_message_id)
  ) THEN RAISE EXCEPTION 'notification_migration_copy_mismatch' USING ERRCODE = '23514'; END IF;
END $$;
--> statement-breakpoint
-- A single short transaction lock orders result receipt/settings/target changes.
-- No path holding it locks source rows: existing business writers may already
-- hold those rows. VOLATILE queries get a fresh snapshot after a lock wait.
CREATE FUNCTION public.lock_discord_result_notifications() RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'notification_requires_read_committed' USING ERRCODE = '25001';
  END IF;
  PERFORM pg_advisory_xact_lock(19790514, 1);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.discord_result_write_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.lock_discord_result_notifications();
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.cancel_discord_notification(p_id text, p_reason text, p_now timestamptz DEFAULT clock_timestamp()) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE n public.discord_notifications;
BEGIN
  IF (SELECT family FROM public.discord_notifications WHERE id = p_id) = 'result' THEN
    PERFORM public.lock_discord_result_notifications();
  END IF;
  SELECT * INTO n FROM public.discord_notifications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR n.status IN ('DELIVERED','CANCELLED') OR n.purged_at IS NOT NULL THEN RETURN false; END IF;
  UPDATE public.discord_notification_parts SET status = 'CANCELLED', claim_token = NULL
    WHERE notification_id = p_id AND status = 'PENDING';
  UPDATE public.discord_notifications SET status = 'CANCELLED', cancel_reason = p_reason,
    terminal_at = p_now, updated_at = p_now,
    claim_token = CASE WHEN EXISTS (SELECT 1 FROM public.discord_notification_parts WHERE notification_id = p_id AND status = 'IN_FLIGHT') THEN claim_token END,
    claim_expires_at = CASE WHEN EXISTS (SELECT 1 FROM public.discord_notification_parts WHERE notification_id = p_id AND status = 'IN_FLIGHT') THEN claim_expires_at END
    WHERE id = p_id;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.discord_result_cancel_reason(p_id text) RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE r record;
BEGIN
  SELECT s.enabled, s.generation, e.settings_generation INTO r
    FROM public.discord_notification_results e JOIN public.discord_notification_settings s ON s.kind = e.kind
    WHERE e.notification_id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'notification_missing_result_context' USING ERRCODE = '23514'; END IF;
  IF NOT r.enabled THEN RETURN 'setting_off'; END IF;
  IF r.generation <> r.settings_generation THEN RETURN 'stale_generation'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.discord_notification_targets t
    LEFT JOIN public.match_drafts d ON d.id = t.target_id
    WHERE t.notification_id = p_id AND t.target_kind = 'match_draft'
      AND (d.id IS NULL OR d.status IN ('confirmed','cancelled') OR d.confirmed_match_id IS NOT NULL)
  ) THEN RETURN 'draft_unavailable'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.discord_notification_targets t
    LEFT JOIN public.matches m ON m.id = t.target_id
    WHERE t.notification_id = p_id AND t.target_kind = 'match' AND m.id IS NULL
  ) THEN RETURN 'match_deleted'; END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.discord_notification_settings_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'notification_settings_required' USING ERRCODE = '23514'; END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN RAISE EXCEPTION 'notification_settings_identity_immutable' USING ERRCODE = '23514'; END IF;
  NEW.generation := OLD.generation + CASE WHEN NEW.enabled IS DISTINCT FROM OLD.enabled THEN 1 ELSE 0 END;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.discord_notification_settings_cancel() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE n record;
BEGIN
  IF NOT NEW.enabled THEN
    FOR n IN SELECT d.id FROM public.discord_notifications d JOIN public.discord_notification_results r ON r.notification_id = d.id
      WHERE r.kind = NEW.kind AND d.status IN ('PENDING','IN_FLIGHT','FAILED') AND d.purged_at IS NULL ORDER BY d.id
    LOOP PERFORM public.cancel_discord_notification(n.id, 'setting_off'); END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER discord_settings_lock BEFORE UPDATE OR DELETE ON public.discord_notification_settings FOR EACH STATEMENT EXECUTE FUNCTION public.discord_result_write_lock();
--> statement-breakpoint
CREATE TRIGGER discord_settings_guard BEFORE UPDATE OR DELETE ON public.discord_notification_settings FOR EACH ROW EXECUTE FUNCTION public.discord_notification_settings_guard();
--> statement-breakpoint
CREATE TRIGGER discord_settings_cancel AFTER UPDATE ON public.discord_notification_settings FOR EACH ROW EXECUTE FUNCTION public.discord_notification_settings_cancel();
--> statement-breakpoint
CREATE FUNCTION public.get_discord_notification_setting(p_kind text) RETURNS public.discord_notification_settings
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE s public.discord_notification_settings;
BEGIN
  PERFORM public.lock_discord_result_notifications();
  SELECT * INTO s FROM public.discord_notification_settings WHERE kind = p_kind;
  IF NOT FOUND THEN RAISE EXCEPTION 'notification_invalid_kind' USING ERRCODE = '22023'; END IF;
  RETURN s;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.set_discord_notification_setting(p_kind text, p_enabled boolean) RETURNS public.discord_notification_settings
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE s public.discord_notification_settings;
BEGIN
  PERFORM public.lock_discord_result_notifications();
  UPDATE public.discord_notification_settings SET enabled = p_enabled WHERE kind = p_kind RETURNING * INTO s;
  IF NOT FOUND THEN RAISE EXCEPTION 'notification_invalid_kind' USING ERRCODE = '22023'; END IF;
  RETURN s;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.discord_notification_target_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_target_kind text; reason text; n record;
BEGIN
  IF TG_TABLE_NAME = 'match_drafts' THEN
    IF TG_OP = 'UPDATE' AND NEW.status NOT IN ('confirmed','cancelled') AND NEW.confirmed_match_id IS NULL THEN RETURN NEW; END IF;
    v_target_kind := 'match_draft'; reason := 'draft_unavailable';
  ELSE v_target_kind := 'match'; reason := 'match_deleted'; END IF;
  -- Take the gate even when no receipt exists yet, so a concurrent receiver
  -- cannot commit a pending notification after this transaction deletes its target.
  PERFORM public.lock_discord_result_notifications();
  FOR n IN SELECT DISTINCT t.notification_id FROM public.discord_notification_targets t
    WHERE t.target_kind = v_target_kind AND t.target_id = OLD.id ORDER BY t.notification_id
  LOOP PERFORM public.cancel_discord_notification(n.notification_id, reason); END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- Existing business transactions acquire source row locks first. Delay the
-- notification gate until commit, after all their source writes, to avoid
-- introducing a gate -> source-row inversion between concurrent writers.
CREATE CONSTRAINT TRIGGER discord_draft_change_cancel AFTER DELETE OR UPDATE OF status, confirmed_match_id ON public.match_drafts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.discord_notification_target_changed();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER discord_match_delete_cancel AFTER DELETE ON public.matches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.discord_notification_target_changed();
--> statement-breakpoint
CREATE FUNCTION public.require_discord_notification_input(condition boolean) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
BEGIN
  IF condition IS NOT TRUE THEN RAISE EXCEPTION 'notification_invalid_input' USING ERRCODE = 'DN400'; END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.validate_discord_rank_comparisons(ranks jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE r jsonb; sample jsonb;
BEGIN
  PERFORM public.require_discord_notification_input(jsonb_typeof(ranks) = 'array');
  PERFORM public.require_discord_notification_input(jsonb_array_length(ranks) = 4 AND (SELECT count(DISTINCT value->>'memberId') = 4 FROM jsonb_array_elements(ranks)));
  FOR r IN SELECT value FROM jsonb_array_elements(ranks) LOOP
    PERFORM public.require_discord_notification_input(jsonb_typeof(r->'memberId') = 'string' AND jsonb_typeof(r->'displayName') = 'string'
      AND r ?& ARRAY['before','after','delta','comparison'] AND r->>'comparison' IN ('comparable','initial','empty','incomparable','reused')
      AND jsonb_typeof(r->'delta') IN ('number','null') AND jsonb_typeof(r->'before') IN ('object','null') AND jsonb_typeof(r->'after') = 'object');
    FOR sample IN SELECT value FROM jsonb_array_elements(jsonb_build_array(r->'before', r->'after')) WHERE value <> 'null'::jsonb LOOP
      PERFORM public.require_discord_notification_input(jsonb_typeof(sample->'matchCount') = 'number' AND jsonb_typeof(sample->'averageRank') IN ('number','null'));
      PERFORM public.require_discord_notification_input((sample->>'matchCount')::numeric >= 0 AND (sample->>'matchCount')::numeric = trunc((sample->>'matchCount')::numeric));
      IF (sample->>'matchCount')::numeric = 0 THEN
        PERFORM public.require_discord_notification_input(sample->'averageRank' = 'null'::jsonb);
      ELSE
        PERFORM public.require_discord_notification_input((sample->>'averageRank')::numeric BETWEEN 1 AND 4);
      END IF;
    END LOOP;
    IF r->>'comparison' IN ('initial','empty','incomparable') THEN
      PERFORM public.require_discord_notification_input(r->'delta' = 'null'::jsonb);
    END IF;
    IF r->>'comparison' = 'comparable' THEN
      PERFORM public.require_discord_notification_input(jsonb_typeof(r->'before') = 'object'
        AND (r->'before'->>'matchCount')::numeric > 0 AND (r->'after'->>'matchCount')::numeric > 0
        AND jsonb_typeof(r->'delta') = 'number' AND (r->>'delta')::numeric BETWEEN -3 AND 3);
    END IF;
    IF r->>'comparison' = 'initial' THEN PERFORM public.require_discord_notification_input(r->'before' = 'null'::jsonb); END IF;
    IF r->>'comparison' = 'reused' THEN
      PERFORM public.require_discord_notification_input(r->'before' = r->'after' AND (r->'delta' = '0'::jsonb OR (r->'after'->>'matchCount')::numeric = 0));
    END IF;
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.validate_discord_result_payload(p_payload jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE d jsonb := p_payload->'data'; m jsonb; player jsonb; season jsonb; analysis jsonb; field_name text;
BEGIN
  IF p_payload->'schemaVersion' IS DISTINCT FROM '1'::jsonb THEN RAISE EXCEPTION 'notification_unsupported_version' USING ERRCODE = 'DN422'; END IF;
  PERFORM public.require_discord_notification_input(jsonb_typeof(d) = 'object' AND octet_length(p_payload::text) <= 8388608
    AND p_payload ?& ARRAY['notificationId','kind','schemaVersion','sourceJobId','occurredAt','settingsGeneration','data']
    AND p_payload - ARRAY['notificationId','kind','schemaVersion','sourceJobId','occurredAt','settingsGeneration','data'] = '{}'::jsonb
    AND jsonb_typeof(p_payload->'occurredAt') = 'string' AND p_payload->>'occurredAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    AND jsonb_typeof(p_payload->'settingsGeneration') = 'string' AND p_payload->>'settingsGeneration' ~ '^(0|[1-9][0-9]*)$');
  IF p_payload->>'kind' = 'ocr_completed' THEN
    PERFORM public.require_discord_notification_input(d ?& ARRAY['matchDraftId','ocrDraftId','imageId','screenType','outcome','summary','context']
      AND jsonb_typeof(d->'matchDraftId') = 'string' AND length(d->>'matchDraftId') BETWEEN 1 AND 200
      AND jsonb_typeof(d->'ocrDraftId') = 'string' AND length(d->>'ocrDraftId') BETWEEN 1 AND 200
      AND jsonb_typeof(d->'imageId') = 'string' AND length(d->>'imageId') BETWEEN 1 AND 200
      AND d->>'screenType' IN ('total_assets','revenue','incident_log') AND d->>'outcome' IN ('succeeded','needs_review')
      AND jsonb_typeof(d->'summary') = 'string' AND jsonb_typeof(d->'context') = 'object'
      AND d->'context' ?& ARRAY['gameTitleName','heldDateIso','matchNoInEvent']
      AND jsonb_typeof(d->'context'->'gameTitleName') IN ('string','null')
      AND jsonb_typeof(d->'context'->'heldDateIso') IN ('string','null')
      AND jsonb_typeof(d->'context'->'matchNoInEvent') IN ('number','null'));
    IF d->'context'->'heldDateIso' <> 'null'::jsonb THEN
      PERFORM public.require_discord_notification_input(d->'context'->>'heldDateIso' ~ '^\d{4}-\d{2}-\d{2}$');
      PERFORM (d->'context'->>'heldDateIso')::date;
    END IF;
    IF d->'context'->'matchNoInEvent' <> 'null'::jsonb THEN
      PERFORM public.require_discord_notification_input((d->'context'->>'matchNoInEvent')::numeric > 0
        AND (d->'context'->>'matchNoInEvent')::numeric = trunc((d->'context'->>'matchNoInEvent')::numeric));
    END IF;
  ELSE
    PERFORM public.require_discord_notification_input(d ?& ARRAY['gameTitleId','gameTitleName','disposition','previousAnalysis','currentAnalysis','matches','overall','seasons']
      AND jsonb_typeof(d->'gameTitleId') = 'string' AND jsonb_typeof(d->'gameTitleName') = 'string'
      AND d->>'disposition' IN ('published','reused') AND jsonb_typeof(d->'previousAnalysis') IN ('object','null')
      AND jsonb_typeof(d->'currentAnalysis') = 'object' AND jsonb_typeof(d->'matches') = 'array' AND jsonb_typeof(d->'seasons') = 'array');
    FOR analysis IN SELECT value FROM jsonb_array_elements(jsonb_build_array(d->'previousAnalysis', d->'currentAnalysis')) WHERE value <> 'null'::jsonb LOOP
      PERFORM public.require_discord_notification_input(analysis ?& ARRAY['jobId','inputRevision','algorithmVersion','artifactSchemaVersion','validationContractId']
        AND jsonb_typeof(analysis->'jobId') = 'string' AND jsonb_typeof(analysis->'inputRevision') = 'string' AND analysis->>'inputRevision' ~ '^(0|[1-9][0-9]*)$'
        AND jsonb_typeof(analysis->'algorithmVersion') = 'string' AND jsonb_typeof(analysis->'artifactSchemaVersion') = 'number'
        AND jsonb_typeof(analysis->'validationContractId') IN ('string','null'));
      PERFORM public.require_discord_notification_input((analysis->>'artifactSchemaVersion')::numeric > 0
        AND (analysis->>'artifactSchemaVersion')::numeric = trunc((analysis->>'artifactSchemaVersion')::numeric));
    END LOOP;
    IF d->>'disposition' = 'reused' THEN PERFORM public.require_discord_notification_input(d->'previousAnalysis' = d->'currentAnalysis'); END IF;
    PERFORM public.validate_discord_rank_comparisons(d->'overall');
    PERFORM public.require_discord_notification_input((SELECT count(*) = count(DISTINCT value->>'seasonId') FROM jsonb_array_elements(d->'seasons')));
    FOR season IN SELECT value FROM jsonb_array_elements(d->'seasons') LOOP
      PERFORM public.require_discord_notification_input(jsonb_typeof(season->'seasonId') = 'string' AND jsonb_typeof(season->'seasonName') = 'string');
      PERFORM public.validate_discord_rank_comparisons(season->'ranks');
    END LOOP;
    PERFORM public.require_discord_notification_input((SELECT count(*) = count(DISTINCT value->>'matchId') FROM jsonb_array_elements(d->'matches')));
    FOR m IN SELECT value FROM jsonb_array_elements(d->'matches') LOOP
      PERFORM public.require_discord_notification_input(m ?& ARRAY['matchId','sourceRevision','heldEventId','heldDateIso','matchNoInEvent','playedAt','mapName','seasonId','seasonName','ownerName','players','ginjiTotal','note']
        AND jsonb_typeof(m->'matchId') = 'string' AND length(m->>'matchId') BETWEEN 1 AND 200
        AND jsonb_typeof(m->'sourceRevision') = 'string' AND m->>'sourceRevision' ~ '^(0|[1-9][0-9]*)$'
        AND jsonb_typeof(m->'note') IN ('string','null') AND jsonb_typeof(m->'players') = 'array'
        AND jsonb_typeof(m->'ginjiTotal') = 'number' AND jsonb_typeof(m->'matchNoInEvent') = 'number');
      FOREACH field_name IN ARRAY ARRAY['heldEventId','heldDateIso','playedAt','mapName','seasonId','seasonName','ownerName'] LOOP
        PERFORM public.require_discord_notification_input(jsonb_typeof(m->field_name) = 'string');
      END LOOP;
      PERFORM public.require_discord_notification_input(length(m->>'heldEventId') BETWEEN 1 AND 200
        AND length(m->>'seasonId') BETWEEN 1 AND 200 AND m->>'heldDateIso' ~ '^\d{4}-\d{2}-\d{2}$'
        AND m->>'playedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
        AND (m->>'matchNoInEvent')::numeric > 0 AND (m->>'matchNoInEvent')::numeric = trunc((m->>'matchNoInEvent')::numeric));
      PERFORM (m->>'heldDateIso')::date;
      PERFORM (m->>'playedAt')::timestamptz;
      PERFORM public.require_discord_notification_input(jsonb_array_length(m->'players') = 4 AND (SELECT count(DISTINCT value->>'memberId') = 4 FROM jsonb_array_elements(m->'players')));
      PERFORM public.require_discord_notification_input((SELECT count(DISTINCT value->'rank') = 4 FROM jsonb_array_elements(m->'players')));
      FOR player IN SELECT value FROM jsonb_array_elements(m->'players') LOOP
        PERFORM public.require_discord_notification_input(jsonb_typeof(player->'memberId') = 'string' AND jsonb_typeof(player->'displayName') = 'string'
          AND player->'rank' IN ('1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb) AND jsonb_typeof(player->'ginjiCount') = 'number');
        PERFORM public.require_discord_notification_input((player->>'ginjiCount')::numeric >= 0 AND (player->>'ginjiCount')::numeric = trunc((player->>'ginjiCount')::numeric));
      END LOOP;
      PERFORM public.require_discord_notification_input((m->>'ginjiTotal')::numeric = (SELECT sum((value->>'ginjiCount')::numeric) FROM jsonb_array_elements(m->'players')));
    END LOOP;
  END IF;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN
  RAISE EXCEPTION 'notification_invalid_input' USING ERRCODE = 'DN400';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.receive_discord_result_notification(p_payload jsonb, p_now timestamptz DEFAULT clock_timestamp())
RETURNS TABLE(notification_id text, disposition text, status text)
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_id text := p_payload->>'notificationId'; v_kind text := p_payload->>'kind'; v_job text := p_payload->>'sourceJobId';
  v_hash text; v_generation bigint; v_occurred timestamptz; n public.discord_notifications; v_reason text;
BEGIN
  PERFORM public.require_discord_notification_input(jsonb_typeof(p_payload) = 'object' AND octet_length(p_payload::text) <= 8388608
    AND jsonb_typeof(p_payload->'notificationId') = 'string' AND jsonb_typeof(p_payload->'kind') = 'string'
    AND v_kind IN ('ocr_completed','analysis_completed') AND jsonb_typeof(p_payload->'sourceJobId') = 'string'
    AND v_job ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$');
  PERFORM public.lock_discord_result_notifications();
  v_hash := public.discord_notification_hash(p_payload);
  SELECT d.* INTO n FROM public.discord_notifications d LEFT JOIN public.discord_notification_results r ON r.notification_id = d.id
    WHERE d.id = v_id OR (r.kind = v_kind AND r.source_job_id = v_job) LIMIT 1;
  IF FOUND THEN
    IF n.id <> v_id OR n.family <> 'result' OR n.payload_hash <> v_hash THEN
      RAISE EXCEPTION 'notification_identity_conflict' USING ERRCODE = 'DN409';
    END IF;
    RETURN QUERY SELECT n.id, 'duplicate'::text, n.status; RETURN;
  END IF;
  PERFORM public.require_discord_notification_input(v_id = 'result:' || v_kind || ':' || v_job);
  PERFORM public.validate_discord_result_payload(p_payload);
  BEGIN
    v_generation := (p_payload->>'settingsGeneration')::bigint;
    v_occurred := (p_payload->>'occurredAt')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'notification_invalid_input' USING ERRCODE = 'DN400';
  END;
  INSERT INTO public.discord_notifications (id, family, kind, dedupe_key, payload, payload_hash, created_at, updated_at, next_attempt_at)
    VALUES (v_id, 'result', v_kind, v_id, p_payload, v_hash, p_now, p_now, p_now);
  INSERT INTO public.discord_notification_results (notification_id, kind, source_job_id, occurred_at, settings_generation)
    VALUES (v_id, v_kind, v_job, v_occurred, v_generation);
  IF v_kind = 'ocr_completed' THEN
    INSERT INTO public.discord_notification_targets VALUES (v_id, 'match_draft', p_payload->'data'->>'matchDraftId');
  ELSE
    INSERT INTO public.discord_notification_targets SELECT v_id, 'match', value->>'matchId' FROM jsonb_array_elements(p_payload->'data'->'matches');
  END IF;
  v_reason := public.discord_result_cancel_reason(v_id);
  IF v_reason IS NOT NULL THEN
    PERFORM public.cancel_discord_notification(v_id, v_reason, p_now);
    RETURN QUERY SELECT v_id, 'cancelled'::text, 'CANCELLED'::text;
  ELSE RETURN QUERY SELECT v_id, 'accepted'::text, 'PENDING'::text; END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.discord_notification_immutable_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'notification_identity_retained' USING ERRCODE = '23514'; END IF;
  IF (NEW.id, NEW.family, NEW.kind, NEW.dedupe_key, NEW.schema_version, NEW.payload_hash)
    IS DISTINCT FROM (OLD.id, OLD.family, OLD.kind, OLD.dedupe_key, OLD.schema_version, OLD.payload_hash) THEN
    RAISE EXCEPTION 'notification_identity_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.payload IS DISTINCT FROM OLD.payload AND (
    NEW.payload IS NULL AND OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL
    AND OLD.status IN ('DELIVERED','FAILED','CANCELLED') AND NEW.claim_token IS NULL
    AND OLD.terminal_at <= NEW.purged_at - CASE WHEN OLD.status = 'DELIVERED' THEN interval '7 days' ELSE interval '30 days' END
  ) IS NOT TRUE THEN RAISE EXCEPTION 'notification_payload_immutable' USING ERRCODE = '23514'; END IF;
  IF OLD.purged_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'notification_tombstone_immutable' USING ERRCODE = '23514'; END IF;
  IF OLD.part_count > 0 AND (NEW.part_count, NEW.renderer_version) IS DISTINCT FROM (OLD.part_count, OLD.renderer_version) THEN
    RAISE EXCEPTION 'notification_part_plan_immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'DELIVERED' AND NEW.status <> OLD.status THEN RAISE EXCEPTION 'notification_already_delivered' USING ERRCODE = '23514'; END IF;
  IF OLD.family = 'result' AND OLD.status = 'CANCELLED' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'notification_cancellation_final' USING ERRCODE = '23514';
  END IF;
  IF OLD.family = 'result' AND OLD.status = 'FAILED' AND NEW.status NOT IN ('FAILED','CANCELLED')
    AND NOT (NEW.status = 'PENDING' AND NEW.retry_cycle = OLD.retry_cycle + 1 AND NEW.attempt_count = 0) THEN
    RAISE EXCEPTION 'notification_explicit_retry_required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER discord_notification_immutable BEFORE UPDATE OR DELETE ON public.discord_notifications FOR EACH ROW EXECUTE FUNCTION public.discord_notification_immutable_guard();
--> statement-breakpoint
CREATE FUNCTION public.discord_notification_detail_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME <> 'discord_notification_results'
    AND EXISTS (SELECT 1 FROM public.discord_notifications WHERE id = OLD.notification_id AND purged_at IS NOT NULL) THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'discord_notification_parts' THEN
    IF (NEW.notification_id, NEW.part_no) IS DISTINCT FROM (OLD.notification_id, OLD.part_no) THEN
      RAISE EXCEPTION 'notification_part_identity_immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'DELIVERED' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'notification_part_already_delivered' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'notification_detail_immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER discord_result_identity_guard BEFORE UPDATE OR DELETE ON public.discord_notification_results FOR EACH ROW EXECUTE FUNCTION public.discord_notification_detail_guard();
--> statement-breakpoint
CREATE TRIGGER discord_target_identity_guard BEFORE UPDATE OR DELETE ON public.discord_notification_targets FOR EACH ROW EXECUTE FUNCTION public.discord_notification_detail_guard();
--> statement-breakpoint
CREATE TRIGGER discord_part_identity_guard BEFORE UPDATE OR DELETE ON public.discord_notification_parts FOR EACH ROW EXECUTE FUNCTION public.discord_notification_detail_guard();
--> statement-breakpoint
CREATE FUNCTION public.discord_notification_context_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE n public.discord_notifications; v_id text;
BEGIN
  IF TG_TABLE_NAME = 'discord_notifications' THEN v_id := NEW.id; ELSE v_id := NEW.notification_id; END IF;
  SELECT * INTO n FROM public.discord_notifications WHERE id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF n.family = 'result' AND (NOT EXISTS (SELECT 1 FROM public.discord_notification_results WHERE notification_id = n.id AND kind = n.kind)
    OR EXISTS (SELECT 1 FROM public.discord_notification_attendance WHERE notification_id = n.id)) THEN
    RAISE EXCEPTION 'notification_missing_result_context' USING ERRCODE = '23514';
  END IF;
  IF n.family = 'attendance' AND (EXISTS (SELECT 1 FROM public.discord_notification_results WHERE notification_id = n.id) OR NOT EXISTS (
    SELECT 1 FROM public.discord_notification_attendance WHERE notification_id = n.id
      AND (session_id IS NOT NULL OR n.status IN ('DELIVERED','CANCELLED') OR n.purged_at IS NOT NULL)
  )) THEN RAISE EXCEPTION 'notification_missing_attendance_context' USING ERRCODE = '23514'; END IF;
  IF n.purged_at IS NULL AND n.part_count <> (SELECT count(*) FROM public.discord_notification_parts WHERE notification_id = n.id AND part_no < n.part_count) THEN
    RAISE EXCEPTION 'notification_incomplete_part_plan' USING ERRCODE = '23514';
  END IF;
  IF n.status = 'DELIVERED' AND n.purged_at IS NULL AND (n.part_count = 0 OR EXISTS (SELECT 1 FROM public.discord_notification_parts WHERE notification_id = n.id AND status <> 'DELIVERED')) THEN
    RAISE EXCEPTION 'notification_incomplete_delivery' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER discord_notification_context AFTER INSERT OR UPDATE ON public.discord_notifications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.discord_notification_context_guard();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER discord_attendance_context AFTER INSERT OR UPDATE ON public.discord_notification_attendance DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.discord_notification_context_guard();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER discord_result_context AFTER INSERT OR UPDATE ON public.discord_notification_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.discord_notification_context_guard();
--> statement-breakpoint
CREATE FUNCTION public.enqueue_discord_attendance_notification(
  p_id text, p_session_id text, p_payload jsonb, p_dedupe_key text, p_revision bigint, p_ordinal smallint,
  p_now timestamptz DEFAULT clock_timestamp()
) RETURNS TABLE(notification_id text, skipped boolean)
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_id text;
BEGIN
  PERFORM public.require_discord_notification_input(p_payload->>'kind' = 'send_message' AND jsonb_typeof(p_payload->'renderer') = 'string');
  INSERT INTO public.discord_notifications (id, family, kind, dedupe_key, payload, payload_hash, part_count, renderer_version, created_at, updated_at, next_attempt_at)
    VALUES (p_id, 'attendance', 'send_message', p_dedupe_key, p_payload, public.discord_notification_hash(p_payload), 1, 1, p_now, p_now, p_now)
    ON CONFLICT (dedupe_key) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN QUERY SELECT d.id, true FROM public.discord_notifications d WHERE d.dedupe_key = p_dedupe_key AND d.family = 'attendance';
    IF NOT FOUND THEN RAISE EXCEPTION 'notification_identity_conflict' USING ERRCODE = 'DN409'; END IF;
    RETURN;
  END IF;
  INSERT INTO public.discord_notification_attendance VALUES (v_id, p_session_id, p_revision, p_ordinal);
  INSERT INTO public.discord_notification_parts (notification_id, part_no) VALUES (v_id, 0);
  RETURN QUERY SELECT v_id, false;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.cancel_discord_attendance_successors(p_now timestamptz DEFAULT clock_timestamp()) RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE r record; changed integer := 0;
BEGIN
  FOR r IN
    SELECT n.id FROM public.discord_notifications n JOIN public.discord_notification_attendance a ON a.notification_id = n.id
    WHERE n.status IN ('PENDING','IN_FLIGHT') AND EXISTS (
      SELECT 1 FROM public.discord_notification_attendance previous
      JOIN public.discord_notifications predecessor ON predecessor.id = previous.notification_id
      WHERE previous.session_id = a.session_id AND predecessor.status = 'FAILED'
        AND (previous.aggregate_revision, previous.ordinal) < (a.aggregate_revision, a.ordinal)
    ) ORDER BY n.id
  LOOP IF public.cancel_discord_notification(r.id, 'predecessor_failed', p_now) THEN changed := changed + 1; END IF; END LOOP;
  RETURN changed;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.release_discord_notification_claims(p_family text, p_now timestamptz DEFAULT clock_timestamp()) RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE n public.discord_notifications; changed integer := 0; new_status text;
BEGIN
  IF p_family = 'result' THEN PERFORM public.lock_discord_result_notifications(); END IF;
  FOR n IN SELECT * FROM public.discord_notifications WHERE family = p_family AND claim_expires_at <= p_now
    AND status IN ('IN_FLIGHT','CANCELLED') ORDER BY id FOR UPDATE SKIP LOCKED
  LOOP
    new_status := CASE WHEN n.status = 'CANCELLED' THEN 'CANCELLED' WHEN n.attempt_count >= n.max_attempts THEN 'FAILED' ELSE 'PENDING' END;
    UPDATE public.discord_notification_parts SET status = CASE WHEN new_status = 'CANCELLED' THEN 'CANCELLED' ELSE 'PENDING' END, claim_token = NULL
      WHERE notification_id = n.id AND status = 'IN_FLIGHT';
    UPDATE public.discord_notifications SET status = new_status, claim_token = NULL, claim_expires_at = NULL,
      next_attempt_at = p_now, updated_at = p_now,
      terminal_at = CASE WHEN new_status = 'FAILED' THEN p_now WHEN new_status = 'CANCELLED' THEN terminal_at END,
      last_error = CASE WHEN new_status = 'FAILED' THEN 'attempt_limit' ELSE last_error END WHERE id = n.id;
    changed := changed + 1;
  END LOOP;
  IF p_family = 'attendance' THEN PERFORM public.cancel_discord_attendance_successors(p_now); END IF;
  RETURN changed;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.claim_discord_notifications(p_family text, p_limit integer, p_now timestamptz DEFAULT clock_timestamp(), p_claim_ms integer DEFAULT 60000)
RETURNS SETOF public.discord_notifications
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE n public.discord_notifications; reason text;
BEGIN
  PERFORM public.require_discord_notification_input(p_family IN ('attendance','result') AND p_limit BETWEEN 1 AND 100 AND p_claim_ms BETWEEN 1 AND 300000);
  IF p_family = 'result' THEN PERFORM public.lock_discord_result_notifications(); END IF;
  PERFORM public.release_discord_notification_claims(p_family, p_now);
  FOR n IN
    SELECT d.* FROM public.discord_notifications d
    LEFT JOIN public.discord_notification_attendance a ON a.notification_id = d.id
    WHERE d.family = p_family AND d.status = 'PENDING' AND d.next_attempt_at <= p_now AND d.purged_at IS NULL
      AND (p_family = 'result' OR (a.session_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.discord_notification_attendance previous JOIN public.discord_notifications predecessor ON predecessor.id = previous.notification_id
        WHERE previous.session_id = a.session_id AND predecessor.status IN ('PENDING','IN_FLIGHT','FAILED')
          AND (previous.aggregate_revision, previous.ordinal) < (a.aggregate_revision, a.ordinal)
      )))
    ORDER BY d.next_attempt_at, a.session_id, a.aggregate_revision, a.ordinal, d.id
    LIMIT p_limit FOR UPDATE OF d SKIP LOCKED
  LOOP
    IF n.attempt_count >= n.max_attempts THEN
      UPDATE public.discord_notifications SET status = 'FAILED', last_error = 'attempt_limit', terminal_at = p_now, updated_at = p_now WHERE id = n.id;
      CONTINUE;
    END IF;
    IF p_family = 'result' THEN
      reason := public.discord_result_cancel_reason(n.id);
      IF reason IS NOT NULL THEN PERFORM public.cancel_discord_notification(n.id, reason, p_now); CONTINUE; END IF;
    END IF;
    UPDATE public.discord_notifications SET status = 'IN_FLIGHT', claim_token = gen_random_uuid(),
      claim_expires_at = p_now + p_claim_ms * interval '1 millisecond', attempt_count = attempt_count + 1, updated_at = p_now
      WHERE id = n.id RETURNING * INTO n;
    RETURN NEXT n;
  END LOOP;
  IF p_family = 'attendance' THEN PERFORM public.cancel_discord_attendance_successors(p_now); END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.plan_discord_notification_parts(p_id text, p_token uuid, p_count integer, p_renderer integer, p_now timestamptz DEFAULT clock_timestamp()) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE n public.discord_notifications;
BEGIN
  IF (SELECT family FROM public.discord_notifications WHERE id = p_id) = 'result' THEN PERFORM public.lock_discord_result_notifications(); END IF;
  SELECT * INTO n FROM public.discord_notifications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR n.status <> 'IN_FLIGHT' OR n.claim_token IS DISTINCT FROM p_token OR p_token IS NULL OR n.claim_expires_at <= p_now THEN RETURN false; END IF;
  PERFORM public.require_discord_notification_input(p_count BETWEEN 1 AND 10000 AND p_renderer > 0);
  IF n.part_count > 0 THEN
    IF (n.part_count, n.renderer_version) IS DISTINCT FROM (p_count, p_renderer) THEN RAISE EXCEPTION 'notification_part_plan_conflict' USING ERRCODE = 'DN409'; END IF;
    RETURN true;
  END IF;
  UPDATE public.discord_notifications SET part_count = p_count, renderer_version = p_renderer, updated_at = p_now WHERE id = p_id;
  INSERT INTO public.discord_notification_parts (notification_id, part_no) SELECT p_id, part FROM generate_series(0, p_count - 1) part;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.begin_discord_notification_part(p_id text, p_part integer, p_token uuid, p_now timestamptz DEFAULT clock_timestamp()) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE n public.discord_notifications; reason text;
BEGIN
  IF (SELECT family FROM public.discord_notifications WHERE id = p_id) = 'result' THEN PERFORM public.lock_discord_result_notifications(); END IF;
  SELECT * INTO n FROM public.discord_notifications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR n.status <> 'IN_FLIGHT' OR n.claim_token IS DISTINCT FROM p_token OR p_token IS NULL OR n.claim_expires_at <= p_now THEN RETURN false; END IF;
  IF n.family = 'result' THEN
    reason := public.discord_result_cancel_reason(p_id);
    IF reason IS NOT NULL THEN PERFORM public.cancel_discord_notification(p_id, reason, p_now); RETURN false; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.discord_notification_parts WHERE notification_id = p_id AND part_no < p_part AND status <> 'DELIVERED') THEN RETURN false; END IF;
  UPDATE public.discord_notification_parts SET status = 'IN_FLIGHT', claim_token = p_token, send_started_at = p_now, attempt_count = attempt_count + 1
    WHERE notification_id = p_id AND part_no = p_part AND part_no < n.part_count AND status = 'PENDING';
  RETURN FOUND;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.complete_discord_notification_part(p_id text, p_part integer, p_token uuid, p_message_id text, p_now timestamptz DEFAULT clock_timestamp()) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE n public.discord_notifications;
BEGIN
  IF (SELECT family FROM public.discord_notifications WHERE id = p_id) = 'result' THEN PERFORM public.lock_discord_result_notifications(); END IF;
  SELECT * INTO n FROM public.discord_notifications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR n.status NOT IN ('IN_FLIGHT','CANCELLED') OR n.claim_token IS DISTINCT FROM p_token OR p_token IS NULL OR n.claim_expires_at <= p_now THEN RETURN false; END IF;
  IF n.family = 'result' THEN PERFORM public.require_discord_notification_input(p_message_id IS NOT NULL AND length(p_message_id) BETWEEN 1 AND 200); END IF;
  UPDATE public.discord_notification_parts SET status = 'DELIVERED', delivered_at = p_now, delivered_message_id = p_message_id, claim_token = NULL
    WHERE notification_id = p_id AND part_no = p_part AND status = 'IN_FLIGHT' AND claim_token = p_token;
  IF NOT FOUND THEN RETURN false; END IF;
  IF n.status = 'CANCELLED' THEN
    UPDATE public.discord_notifications SET claim_token = NULL, claim_expires_at = NULL, updated_at = p_now WHERE id = p_id;
  ELSIF NOT EXISTS (SELECT 1 FROM public.discord_notification_parts WHERE notification_id = p_id AND status <> 'DELIVERED') THEN
    UPDATE public.discord_notifications SET status = 'DELIVERED', delivered_at = p_now, terminal_at = p_now,
      last_error = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = p_now WHERE id = p_id;
  ELSE UPDATE public.discord_notifications SET updated_at = p_now WHERE id = p_id; END IF;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.fail_discord_notification(p_id text, p_token uuid, p_error text, p_next_attempt timestamptz, p_now timestamptz DEFAULT clock_timestamp()) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE n public.discord_notifications; new_status text;
BEGIN
  IF (SELECT family FROM public.discord_notifications WHERE id = p_id) = 'result' THEN PERFORM public.lock_discord_result_notifications(); END IF;
  SELECT * INTO n FROM public.discord_notifications WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR n.status NOT IN ('IN_FLIGHT','CANCELLED') OR n.claim_token IS DISTINCT FROM p_token OR p_token IS NULL OR n.claim_expires_at <= p_now THEN RETURN false; END IF;
  IF n.family = 'result' THEN
    PERFORM public.require_discord_notification_input(p_error IN ('discord_unavailable','discord_rate_limited','delivery_uncertain','invalid_payload','unsupported_renderer','delivery_failed','attempt_limit'));
  END IF;
  PERFORM public.require_discord_notification_input(p_error IS NOT NULL AND (p_next_attempt IS NULL OR p_next_attempt >= p_now));
  new_status := CASE WHEN n.status = 'CANCELLED' THEN 'CANCELLED' WHEN p_next_attempt IS NULL OR n.attempt_count >= n.max_attempts THEN 'FAILED' ELSE 'PENDING' END;
  UPDATE public.discord_notification_parts SET status = CASE WHEN new_status = 'CANCELLED' THEN 'CANCELLED' ELSE 'PENDING' END, claim_token = NULL
    WHERE notification_id = p_id AND status = 'IN_FLIGHT' AND claim_token = p_token;
  UPDATE public.discord_notifications SET status = new_status, last_error = left(p_error, 4000),
    claim_token = NULL, claim_expires_at = NULL, next_attempt_at = coalesce(p_next_attempt, p_now), updated_at = p_now,
    terminal_at = CASE WHEN new_status = 'FAILED' THEN p_now WHEN new_status = 'CANCELLED' THEN terminal_at END WHERE id = p_id;
  IF new_status = 'FAILED' AND n.family = 'attendance' THEN PERFORM public.cancel_discord_attendance_successors(p_now); END IF;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.renew_discord_notification_claim(p_id text, p_token uuid, p_now timestamptz DEFAULT clock_timestamp(), p_claim_ms integer DEFAULT 60000) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (SELECT family FROM public.discord_notifications WHERE id = p_id) = 'result' THEN PERFORM public.lock_discord_result_notifications(); END IF;
  PERFORM public.require_discord_notification_input(p_claim_ms BETWEEN 1 AND 300000);
  UPDATE public.discord_notifications SET claim_expires_at = p_now + p_claim_ms * interval '1 millisecond', updated_at = p_now
    WHERE id = p_id AND status = 'IN_FLIGHT' AND claim_token = p_token AND claim_expires_at > p_now;
  RETURN FOUND;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.retry_discord_result_notification(p_id text, p_now timestamptz DEFAULT clock_timestamp()) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE n public.discord_notifications; reason text;
BEGIN
  PERFORM public.lock_discord_result_notifications();
  SELECT * INTO n FROM public.discord_notifications WHERE id = p_id AND family = 'result' FOR UPDATE;
  IF NOT FOUND OR n.status <> 'FAILED' OR n.purged_at IS NOT NULL THEN RETURN false; END IF;
  reason := public.discord_result_cancel_reason(p_id);
  IF reason IS NOT NULL THEN PERFORM public.cancel_discord_notification(p_id, reason, p_now); RETURN false; END IF;
  UPDATE public.discord_notifications SET status = 'PENDING', attempt_count = 0, retry_cycle = retry_cycle + 1,
    terminal_at = NULL, last_error = NULL, next_attempt_at = p_now, updated_at = p_now WHERE id = p_id;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.requeue_discord_attendance_chains(p_now timestamptz DEFAULT clock_timestamp())
RETURNS TABLE(dead_letters_requeued integer, successors_requeued integer)
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE failed_ids text[]; successor_ids text[];
BEGIN
  -- The family relation scopes this legacy recovery policy. Result cancellation
  -- and exhausted retries can never be reopened by a Summit restart.
  SELECT coalesce(array_agg(n.id ORDER BY n.id), ARRAY[]::text[]) INTO failed_ids
    FROM public.discord_notifications n JOIN public.discord_notification_attendance a ON a.notification_id = n.id
    WHERE n.status = 'FAILED' AND n.purged_at IS NULL AND a.session_id IS NOT NULL;
  SELECT coalesce(array_agg(n.id ORDER BY n.id), ARRAY[]::text[]) INTO successor_ids
    FROM public.discord_notifications n JOIN public.discord_notification_attendance a ON a.notification_id = n.id
    WHERE n.status = 'CANCELLED' AND n.purged_at IS NULL AND n.claim_token IS NULL
      AND (n.cancel_reason = 'predecessor_failed' OR n.cancel_reason IS NULL) AND EXISTS (
        SELECT 1 FROM public.discord_notification_attendance previous
        WHERE previous.notification_id = ANY(failed_ids) AND previous.session_id = a.session_id
          AND (previous.aggregate_revision, previous.ordinal) < (a.aggregate_revision, a.ordinal)
      );
  PERFORM 1 FROM public.discord_notifications WHERE id = ANY(failed_ids || successor_ids) ORDER BY id FOR UPDATE;
  UPDATE public.discord_notification_parts SET status = 'PENDING', claim_token = NULL
    WHERE notification_id = ANY(failed_ids || successor_ids) AND status <> 'DELIVERED';
  UPDATE public.discord_notifications SET status = 'PENDING', attempt_count = 0, retry_cycle = retry_cycle + 1,
    last_error = NULL, cancel_reason = NULL, claim_token = NULL, claim_expires_at = NULL,
    terminal_at = NULL, next_attempt_at = p_now, updated_at = p_now
    WHERE id = ANY(failed_ids || successor_ids) AND purged_at IS NULL;
  RETURN QUERY SELECT cardinality(failed_ids), cardinality(successor_ids);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.purge_discord_notifications(p_now timestamptz DEFAULT clock_timestamp(), p_family text DEFAULT NULL,
  p_delivered_before timestamptz DEFAULT NULL, p_failed_before timestamptz DEFAULT NULL)
RETURNS TABLE(notification_id text, status text)
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE n public.discord_notifications;
BEGIN
  IF p_family IS NULL OR p_family = 'result' THEN PERFORM public.lock_discord_result_notifications(); END IF;
  FOR n IN SELECT * FROM public.discord_notifications d WHERE (p_family IS NULL OR d.family = p_family)
    AND d.purged_at IS NULL AND d.claim_token IS NULL AND d.status IN ('DELIVERED','FAILED','CANCELLED')
    AND d.terminal_at <= p_now - CASE WHEN d.status = 'DELIVERED' THEN interval '7 days' ELSE interval '30 days' END
    AND d.terminal_at <= CASE WHEN d.status = 'DELIVERED' THEN coalesce(p_delivered_before, p_now) ELSE coalesce(p_failed_before, p_now) END
    AND NOT EXISTS (SELECT 1 FROM public.discord_notification_parts p WHERE p.notification_id = d.id AND p.status = 'IN_FLIGHT')
    ORDER BY d.id FOR UPDATE OF d SKIP LOCKED
  LOOP
    UPDATE public.discord_notifications SET payload = NULL, purged_at = p_now, last_error = NULL, updated_at = p_now WHERE id = n.id;
    DELETE FROM public.discord_notification_parts WHERE discord_notification_parts.notification_id = n.id;
    DELETE FROM public.discord_notification_targets WHERE discord_notification_targets.notification_id = n.id;
    RETURN QUERY SELECT n.id, n.status;
  END LOOP;
END;
$$;
--> statement-breakpoint
-- Closed sessions have no remaining execution role. Preserve every held event
-- and participant; the schema migration has already changed its FK to SET NULL.
DO $$
DECLARE before_held jsonb; before_participants jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(to_jsonb(h) - 'session_id' ORDER BY h.id), '[]'::jsonb) INTO before_held FROM public.held_events h;
  SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.held_event_id, p.member_id), '[]'::jsonb) INTO before_participants FROM public.held_event_participants p;
  DELETE FROM public.sessions s WHERE s.status IN ('COMPLETED','POSTPONED','SKIPPED') AND s.candidate_date_iso < (clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::date
    AND NOT EXISTS (
      SELECT 1 FROM public.discord_notification_attendance a JOIN public.discord_notifications n ON n.id = a.notification_id
      WHERE a.session_id = s.id AND ((n.purged_at IS NULL AND n.status IN ('PENDING','IN_FLIGHT','FAILED')) OR n.claim_token IS NOT NULL)
    );
  IF before_held IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(h) - 'session_id' ORDER BY h.id), '[]'::jsonb) FROM public.held_events h)
    OR before_participants IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.held_event_id, p.member_id), '[]'::jsonb) FROM public.held_event_participants p) THEN
    RAISE EXCEPTION 'notification_migration_history_changed' USING ERRCODE = '23514';
  END IF;
END;
$$;
