# canonical identity の切替契約

この文書は consumer が実装する target schema と ID の保存契約を固定する。現時点では canonical schema migration を含まない。適用済み schema の説明や本番切替の許可ではなく、[正規開発手順](development.md)に従う migration と consumer gate の入力である。

[列対応表](contracts/canonical-identities-v1.json)は `0080_snapshot.json` の全 public column を列挙し、型、変換先 entity、保持する旧列、既存 FK を記録する。実データの値・件数・運用状態は含めない。`drizzle.__drizzle_migrations` は通常 migrator の追記以外変更しない。public number と fencing counter は、それぞれの独立した契約を維持する。

## 外向き ID と計算 ID

DB 内部の entity ID と参照を native `uuid` にする。既存の API、ブラウザ principal/workspace、URL、通知、計算の入力には、従来の完全一致する文字列 ID を返す。公開 payload の同名フィールドを UUID に置換しない。特に `accountId` の変更による sessionStorage 消去、固定メンバー列挙の変更、bootstrap seed と ID 順序の変更を起こさない。

既存の route は legacy ID を優先して認証済み scope 内で解決する。新しい public number の route は `/m/:publicId`、`/e/:publicId` とし、数値だけの旧 ID を public number と再解釈しない。認証・所有者確認・endpoint scope は ID 変換前後で維持する。

通常の新規 entity は UUID を一度だけ生成し、再送時も同じ値を使用する。新しい `legacy_id` は原則としてその標準 UUID 文字列とする。name/slug を canonical ID の生成元にしない。既存の構造化 job/attempt/storage identity が必要な場合は、以下の typed mapping を使用する。既存 row の参照はまず保存された対応を解決し、未知の利用者入力を自動的に hash 化して認可済み参照とみなさない。

## 決定的な割当

- algorithm: `sha256-uuidv8-v1`
- namespace: `deabc659-a5ca-4dc0-9711-eae0614fa478`
- entity namespace: [参照実装](../scripts/identity/canonical.mjs)の固定 allowlist。別名、単数形、prefix 除去を認めない。
- PostgreSQL が受理する UUID 表記は同じ 128 bits を保持する。version/variant を限定せず、nil/max UUID も保持する。旧文字列は別途そのまま保存する。
- 非 UUID は `namespace の 16 network-order bytes || entity namespace の ASCII bytes || 0x00 || 旧 ID の UTF-8 bytes` の SHA-256 を求め、先頭 16 bytes の byte 6 上位 nibble を 8、byte 8 上位 2 bits を `10` にする。
- trim、大小文字変換、Unicode 正規化、表示名への置換を行わない。NUL と不正 Unicode は拒否する。
- 同じ entity 内で別の row が同じ canonical UUID になる場合は停止する。異なる UUID 表記同士、hash 同士、hash と既存 UUID の衝突をすべて検査する。衝突を random 再割当や row 統合で解消しない。
- 異なる entity namespace での UUID の一致は許される。candidate と basis の旧 ID が共通でも、それぞれの型で解決する。

SHA-256 の name-based UUID に version 8 を使う根拠は [RFC 9562 Appendix B.2](https://www.rfc-editor.org/rfc/rfc9562.html#appendix-B.2)。入力 UUID の表記は [PostgreSQL UUID type](https://www.postgresql.org/docs/18/datatype-uuid.html) に合わせる。[共有 fixture](../tests/fixtures/canonical-identities-v1.json)は合成値だけを含む。Scala、Rust、migration SQL の実装は全 vector と RFC の独立 vector を通す。

## mutable entity と通常の参照

対応表の `mutableEntities` はそれぞれ `id uuid PRIMARY KEY` と `legacy_id text NOT NULL UNIQUE` を持つ。既存 `legacy_id` は元の `id` と完全一致する。旧 ID の一律失効期限は設けない。

宣言 FK のある通常の参照は native UUID に変換し、参照先の entity または後述の typed anchor に接続する。既存の nullability、composite scope、UNIQUE、ON DELETE、ON UPDATE を維持する。保存済み text FK がある場合は親の `legacy_id` に付け替える。

宣言 FK のない以下の参照は、同じ nullability の `legacy_<column> text` も保持する。canonical と legacy の NULL 状態は一致させ、INSERT/UPDATE/clear は両方を同じ transaction で処理する。保存前の割当や削除後の履歴を表す参照に、新しい live-parent FK を追加しない。親が存在しない読み出しは保存した legacy 文字列を使用する。

| table | canonical column と保持する旧文字列 |
| --- | --- |
| `app_sessions` | `member_id` / `legacy_member_id` |
| `match_drafts` | `total_assets_draft_id` / `legacy_total_assets_draft_id`、`revenue_draft_id` / `legacy_revenue_draft_id`、`incident_log_draft_id` / `legacy_incident_log_draft_id` |
| `ocr_drafts` | `job_id` / `legacy_job_id` |
| `ocr_jobs` | `draft_id` / `legacy_draft_id` |
| `ocr_submissions` | `match_draft_id` / `legacy_match_draft_id` |
| `series_analysis_campaign_targets` | `game_title_id` / `legacy_game_title_id`、`job_request_id` / `legacy_job_request_id` |
| `series_analysis_job_requests` | `game_title_id` / `legacy_game_title_id`、`assigned_attempt_id` / `legacy_assigned_attempt_id` |
| `series_analysis_jobs` | `lease_attempt_id` / `legacy_lease_attempt_id`、`radar_operation_id` / `legacy_radar_operation_id` |
| `series_analysis_operation_requests` | `game_title_id` / `legacy_game_title_id` |
| `series_radar_acknowledgements` | `requested_by` / `legacy_requested_by` |
| `series_radar_operations` | `origin_operation_id` / `legacy_origin_operation_id`、`requested_by` / `legacy_requested_by`、`job_id` / `legacy_job_id` |

`worker_execution_slots.job_id` と `attempt_id` も UUID とし、`legacy_job_id` と `legacy_attempt_id` を保持する。`task_kind = 'analysis'` では jobs/attempts の typed mapping、`'ocr'` では OCR job の mapping と既存 OCR attempt UUID の同じ bits を使用する。OCR attempt に analysis namespace を使わない。全 holder field の既存 NULL-shape、owner、期限、fencing token を維持し、解放時は追加した legacy field も NULL にする。

## 保存済み artifact / radar の typed anchor

以下の新しい table を作る。両者とも `id uuid PRIMARY KEY`、`legacy_id text NOT NULL UNIQUE`、`game_title_id uuid NOT NULL`、`legacy_game_title_id text NOT NULL` を持つ。

| 新しい table | 元の変更しない table |
| --- | --- |
| `series_analysis_artifact_identities` | `series_analysis_artifacts` |
| `series_radar_basis_identities` | `series_radar_bases` |

各 anchor の制約は次の通り。

- `UNIQUE(id, game_title_id)` と `UNIQUE(legacy_id, game_title_id)`。
- `(legacy_id, legacy_game_title_id)` から元の `(id, game_title_id)` への composite FK。元の row が正当に削除された場合だけ `ON DELETE CASCADE`。
- `(game_title_id, legacy_game_title_id)` から `game_titles(id, legacy_id)` への composite FK。title 削除の既存 cascade と同じ結果を保ち、title に `UNIQUE(id, legacy_id)` を追加する。
- live state の artifact/basis 参照は canonical anchor に接続し、元の restrictive composite FK と title scope を保持する。

元の artifact/header/chunk、basis、radar revision は一切 backfill しない。元の table の id、game_title_id、attempt_id、source snapshot、JSONB、bytea、checksum、scope、attestation は元の値を保持する。artifact の title FK は `game_titles.legacy_id`、attempt FK は attempt の `legacy_id` に付け替え、既存の nullable cleanup を維持する。artifact の radar basis は元の text basis table への参照を維持する。

`series_radar_candidates` と `series_radar_operations` は `legacy_game_title_id text NOT NULL` と `UNIQUE(legacy_id, legacy_game_title_id)` も持つ。canonical/legacy title pair を title の composite unique に接続する。保存済み revision の text/text FK はこれらに接続し直す。candidate の `source_basis_id text` は変更せず、`(source_basis_id, game_title_id)` を basis anchor の `(legacy_id, game_title_id)` に接続する。`source_candidate_id`、`saved_by`、その他の provenance も元の text を保持する。

新しい artifact/basis を保存するときは、元の row と対応する anchor を同じ transaction で作る。元の checksum を検証してから必要な lookup projection を作り、投影後の値で保存済み checksum を作り直さない。guard の無効化や sealed row の型書換えを移行手段にしない。

## 順序と CHECK

`matches.legacy_held_event_id text NOT NULL` を保持し、`(held_event_id, legacy_held_event_id)` から `held_events(id, legacy_id)` へ composite FK を張る。親に対応する UNIQUE を追加し、元の FK action を保つ。

`matches_navigation_idx` は `played_at, legacy_held_event_id COLLATE "C", match_no_in_event, legacy_id COLLATE "C"`、`held_events_navigation_idx` は `start_at, legacy_id COLLATE "C"` の順序を維持する。`uuid` に COLLATE を付けない。旧 cursor と新旧同時刻 row の tie-order を変更しない。

同じ理由で、次の index の自分自身の `id` tie-breaker は `legacy_id` に置き換える。FK scope と equality key は native UUID のままとする。

- `ocr_jobs_claimable_idx`
- `ocr_submissions_status_id_idx`、`ocr_submissions_status_deadline_idx`
- `series_analysis_job_requests_pending_title_idx`、`series_analysis_job_requests_job_idx`
- `series_analysis_jobs_title_terminal_idx`、`series_analysis_jobs_recent_idx`、`series_analysis_jobs_claim_idx`
- `series_radar_operations_pending_idx`

`ocr_submissions_id_check` の長さ・表記条件は `legacy_id` に向ける。canonical ID の構文は UUID 型で保証する。計算 input の title/event/match/season/map/member/owner の ID と全 sort key、bootstrap seed は元の legacy 文字列を使用する。

## HTTP replay の table 境界

旧 `idempotency_keys` は `idempotency_keys_legacy` に rename し、全 row を完全保存する。key/account/member は text のまま、親参照はそれぞれの legacy ID に付け替える。raw key、request hash、response bytes/headers/status、時刻、期限を変換しない。

新しい `idempotency_keys` は `key uuid NOT NULL`、`account_id uuid NOT NULL`、`member_id uuid NULL` とし、それ以外の field の型と意味を維持する。PRIMARY KEY の列順は正確に `(key, account_id, endpoint)`。account/member FK の削除動作も従来どおりとする。新しい table は空から開始する。

consumer は認証と scope 確認、元の request representation の hash 計算、legacy account/endpoint/raw key の完全一致 lookup を先に行う。旧 row の replay/pending/hash conflict を従来どおり処理し、旧 request body の ID を hash 照合前に canonical 化しない。

完全一致する旧 row がない場合だけ新規 key を UUID として検証する。同一 account の予約 lock 内で、同じ account/endpoint に UUID として同値の旧 key が別表記で存在する場合は conflict にする。別表記だった旧処理を統合・再送しない。両 table を横断して予約上限・cleanup を扱い、期限・pending の既存扱いを維持する。移行のために replay/session の期限を延長しない。

## UUID 化しない値

列対応表の `notification`、`frozen_storage`、`encoded_reference`、`opaque_image`、`semantic`、`operational`、`value`、`replay_legacy` は値をそのまま保持する。特に、通知の structured ID/dedupe/source job/context/payload、Discord IDs、owner/lease label、token/hash、validation contract、incident key、layout/profile、scope key、画像 object key/path を entity ID と混同しない。

`source_images.id` は canonical entity だが、古い `image_id` は metadata row の存在を意味しない。画像 object の mirror と OCR 実行 gate は DB scalar の変換と別に確認する。`layout_family` の既知 alias 正規化は専用の P4 移行単位で行い、この UUID migration で意味を変更しない。

## migration と完了 gate

schema 宣言から生成する expand/contract と custom backfill/guard を分け、metadata は Drizzle Kit だけで生成する。typed mapping と衝突検査は全 writer 停止後に取得した基準に対して行う。元の FK が PK に依存している点を含め、FK の付け替え、legacy uniqueness、canonical PK の順を明示する。

fresh と復元 copy で、全 row の approved projection、元の payload bytes/checksum、全 FK/null/composite/delete/update、index/trigger/function、失敗時 transaction rollback、通常 migrator の no-op を比較する。旧 basis から次の preview/edit/apply/restore/publication、通知 baseline、同じ input の全数値と順序、旧ブラウザ state/replay、旧 link と public route、認証境界、consumer の新規書込みも gate に含む。

切替前の復旧は DB と consumer を対応する保存済み baseline に戻す。namespace を変えたり hash を逆変換したりしない。復旧手順と本番承認は[正規開発手順](development.md)に従う。契約の unit test 成功だけで migration、consumer、実データの切替 gate を完了扱いにしない。
