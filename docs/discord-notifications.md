# Discord 通知の共有 DB 契約

物理 schema は [src/schema.ts](../src/schema.ts)、A/B の TypeScript 型と ID 関数は [src/notifications.ts](../src/notifications.ts) を正本とする。TypeScript consumer は `@momo/db` と `@momo/db/notifications` を利用する。他言語の consumer も本書と JSON 例に従う。

この契約は [MOM-14](https://linear.app/ponta/issue/MOM-14) の共有永続化と既存 Summit の切替を扱う。管理画面・設定 API は MOM-15、OCR producer は MOM-16、分析 snapshot producer は MOM-17、A/B の HTTP handler・renderer・配送 orchestration は MOM-18 が接続する。DB 変更・適用の規範は [development.md](development.md) に集約する。

## 保存先

| テーブル | 責務 |
| --- | --- |
| `discord_notifications` | 永続受付と配送待ちを兼ねる親行。payload はここだけに保存する |
| `discord_notification_attendance` | 既存アンケートの Session と revision / ordinal。A/B には存在しない |
| `discord_notification_results` | A/B の種別・元ジョブ・成功時刻・設定世代。ジョブ一意性を永久保持する |
| `discord_notification_settings` | A/B ごとに一行。初期値 ON、世代 0 |
| `discord_notification_targets` | A の対象下書き、B に掲載した各試合。元データへの FK を持たない |
| `discord_notification_parts` | 部分番号、送信開始、claim token、試行数、Discord message ID。描画済み本文を複製しない |

通知の `family` は `attendance` / `result`。アンケートだけが `send_message` を持ち、A/B は `ocr_completed` / `analysis_completed` を持つ。family と関連行の取り違えは commit 時にも拒否する。

元ジョブ、成果物、対象試合・下書きの整理で通知本体を連鎖削除しない。開催履歴の `session_id` は `ON DELETE SET NULL` とし、アンケート整理後も開催 ID・日時・参加者・試合との参照を保持する。

## 通知 ID と内容照合

A/B の ID は次の文字列で固定する。version、実行 attempt、HTTP request ごとには変えない。

```text
result:<kind>:<sourceJobId>
```

`sourceJobId` は `^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$`。A は画像単位の OCR ジョブ、B は成功した論理分析ジョブであり、新しい手動分析ジョブには新しい ID を使う。`(kind, source_job_id)` にも独立した一意制約を持つ。

内容照合は DB の `discord_notification_hash(jsonb)` が行う。v1 は JSONB の object key 順と数値の末尾ゼロを正規化して SHA-256 を計算する `jsonb-numeric-sha256-v1`。array の順序、文字列、欠落と null の違いは保持する。consumer 独自の JSON.stringify 等の hash は送らない。

同じ ID / 元ジョブで同じ JSON 内容なら、取消・配送済み・本文整理済みでも既存行を返す。異なる内容や version に差し替えようとした場合は `DN409`。親 ID、family、種別、payload、照合情報と結果関連の識別は更新しない。

## v1 の固定 payload

完全な例は [OCR](examples/ocr-completed-v1.json) と [分析](examples/analysis-completed-v1.json)。例中の ID・表示名・分析契約名は架空である。

共通 envelope は `notificationId`、`kind`、`schemaVersion: 1`、`sourceJobId`、`occurredAt`、`settingsGeneration`、`data`。世代・分析 input revision・試合 source revision は精度を失わない十進文字列とする。`occurredAt` と試合の `playedAt` は UTC の `YYYY-MM-DDTHH:mm:ss.sssZ`、開催日は `YYYY-MM-DD`。DB 受付は JSONB 表現で 8 MiB を上限とし、超過や不正形式を保存前に拒否する。本文を切り捨てて成功扱いにしない。

| data | 固定する内容 |
| --- | --- |
| A | matchDraftId、ocrDraftId、imageId、screenType、succeeded / needs_review、要約、分かる範囲の作品名・開催日・試合番号 |
| B | 作品 ID・表示名、published / reused、前回と今回の分析識別、掲載試合、作品通算とシーズン通算 |
| B の掲載試合 | 試合 ID・source revision・開催 ID / 日・番号・日時、マップ・シーズン・owner の表示、全 4 人の名前 / 順位 / 銀次回数、銀次合計、メモ全文または null |
| B の各集計 | 全 4 人の memberId / 表示名、前後の対象試合数 / 平均順位、丸め前の差分、比較状態 |

作品・シーズン通算は全マップを含む。掲載試合は前回成功から追加・更新された対象であり、全履歴を表示時に再検索しない。後日のメモ・表示名・試合内容の編集は payload に反映しない。リンクの対象は保存した下書き・試合・開催の ID に固定し、v1 renderer がアプリの正規 route へ変換する。

比較状態は `comparable`、`initial`、`empty`、`incomparable`、`reused`。件数 0 の平均は null、初回の前値は null、比較できない差分は null。比較できる微小差分は丸めず残す。`reused` は同じ現在分析を previous / current に使い、同じ集計を前後に置く。旧分析で検証契約が不明な場合、`validationContractId` は null を許容する。DB は snapshot の形式を検査し、分析計算や元データとの突合は行わない。

## 設定と業務成功の境界

設定の取得・変更には次を使う。関数は `kind, enabled, generation, updated_at` を返す。

```sql
SELECT * FROM public.get_discord_notification_setting($1);
SELECT * FROM public.set_discord_notification_setting($1, $2);
```

producer は業務成功 transaction 内の最後に設定・世代を取得し、commit 後に一度だけ HTTP 送出する。取得後に追加の業務行ロックや外部 I/O を行わない。ON ならその世代と成功時点の固定内容を送る。OFF なら送らない。通知を省略する設定取得失敗については SAVEPOINT 等で業務成功を保護し、後から現在の設定を読んで送出し直さない。

設定は ON/OFF が変わるたびに世代を一つ進め、同じ値の保存では進めない。OFF の保存と該当通知の未開始部分取消は同じ transaction で成立する。再 ON でも古い世代・取消済み ID は復活しない。アンケートにはこの設定を適用しない。

producer outbox、通知 HTTP の再試行・未受付通知の回収、API の代理送出は作らない。Summit の永続受付前に通知が欠落する場合は許容する。

## 永続受付

```sql
BEGIN;
SELECT * FROM public.receive_discord_result_notification($1::jsonb);
COMMIT;
```

戻り値は `notification_id, disposition, status`。親行、固定 payload、結果関連、取消対象、配送待ちまたは取消状態をまとめて保存する。handler は commit の成功後にだけ HTTP 応答とローカル wake を返す。

| 結果 | HTTP handler の対応 |
| --- | --- |
| `accepted` | 202。新規 PENDING |
| `duplicate` | 200。保存済みの状態を返す |
| `cancelled` | 200。設定 OFF、世代不一致、対象の確定・削除等で取消状態を新規保存 |
| `DN409` | 409。既存識別の内容不一致 |
| `DN400` | 400。不正な v1 入力 |
| `DN422` | 422。新規通知の未対応 schemaVersion |

2xx は Discord 配送完了ではない。commit 後に応答だけ失っても、保存済み行から回復する。rollback では通知・関連行を残さない。DB 例外を HTTP / log へそのまま渡さず、code を境界で変換する。payload、SQL bind、接続情報、Discord の secret をログへ出さない。

## 排他と対象変更

A/B の受信、設定、claim、送信開始、確定、回復は短い共通 advisory transaction lock で直列化する。通常の isolation は `READ COMMITTED`。snapshot が更新されない isolation でこの契約を呼ぶと `25001` で拒否する。

下書きの確定・取消・削除と、掲載試合の削除には、commit まで遅延する constraint trigger を使う。既存の業務 transaction が必要な行ロックと書込みを終えてから通知の lock を取り、対象変更と通知取消を同じ commit に含める。取消が必要な対象変更では、通知がまだ存在しなくても lock を取得し、並行受付の取りこぼしを防ぐ。

通知 lock を持つ処理は業務対象を `FOR UPDATE` しない。業務変更の後に設定取得を行い、対象変更の constraint trigger を業務書込みの途中で IMMEDIATE に切り替えない。設定行の変更は専用関数を使い、その前に独自の行ロックを取得しない。DB transaction を Discord HTTP の完了まで保持しない。

A は match draft の確定・取消・削除で未開始部分を取り消す。B は掲載試合の一件でも削除されたら、通知全体の未開始部分を取り消す。残存試合だけの payload を再構成しない。元ジョブ・古い成果物の履歴整理だけでは取り消さない。

## 配送と回復

時刻の省略時は DB の `clock_timestamp()` を使う。明示時刻を渡す consumer は、各呼出し直前の clock を使い、古い batch 開始時刻を使い回さない。

| DB 関数 | 引数と意味 |
| --- | --- |
| `claim_discord_notifications` | family, limit, now?, claimMs?。通知ごとの token・期限を発行し、試行数を加算する |
| `plan_discord_notification_parts` | id, token, count, rendererVersion, now?。初回描画で部分数と renderer を固定する |
| `begin_discord_notification_part` | id, partNo, token, now?。Discord 呼出し直前に所有権・期限・取消・先行部分の完了を確認する |
| `complete_discord_notification_part` | id, partNo, token, messageId, now?。同じ有効 owner の送信結果を記録する |
| `fail_discord_notification` | id, token, errorCode, nextAttemptAt または null, now?。再試行または FAILED にする |
| `renew_discord_notification_claim` | id, token, now?, claimMs?。有効な所有権だけを延長する |
| `release_discord_notification_claims` | family, now?。期限切れの未完了部分を回復し、上限到達なら FAILED にする |
| `retry_discord_result_notification` | id, now?。保持中の FAILED に対する明示再試行。設定・世代・対象を再検査する |

部分番号は 0 始まりで連続する。初回に count と rendererVersion を固定した後は、同じ値でのみ再開できる。部分 N は 0..N-1 がすべて DELIVERED のときだけ開始する。保存済み message ID の部分は送らず、残りだけを描画・配送する。renderer の旧版を削除する場合は、その版を必要とする保持中の通知がないことを確認する。

claim は送信開始ではない。`begin` が true で commit した後に Discord を呼ぶ。false なら送らない。OFF / 対象削除は既送信部分を残し、未開始部分を CANCELLED にする。すでに開始した部分は到達し得るため、その有効 token からの message ID を保存するが、親は CANCELLED のままにする。

親は PENDING → IN_FLIGHT → DELIVERED / PENDING / FAILED と遷移する。取消後の A/B は再 ON、起動時回復、明示再試行でも PENDING に戻さない。既定の最大試行数は schema の `max_attempts`。claim したまま停止し続ける場合も上限へ到達する。手動再試行は `retry_cycle` を進め、同じ ID と payload のまま新しい有限の cycle を開始する。

A/B の失敗理由は `discord_unavailable`、`discord_rate_limited`、`delivery_uncertain`、`invalid_payload`、`unsupported_renderer`、`delivery_failed`、`attempt_limit`。外部例外全文を保存しない。旧 owner は開始・結果確定できないが、Discord 受理後の停止や応答喪失では重複投稿を許容する。

Summit は受付・起動・既存の低頻度 supervisor と次回実行時刻に基づいて wake する。DB の受信関数は外部送信・新しい常時 polling を行わない。

## アンケート固有の処理

`enqueue_discord_attendance_notification(id, sessionId, payload, dedupeKey, revision, ordinal, now?)` は Session の変更 transaction から呼ぶ。部分数は 1、既存の typed renderer を使う。Session ごとの revision / ordinal の順序を守り、先行 FAILED の後続を取り消す。

`requeue_discord_attendance_chains(now?)` は保持中のアンケート FAILED と、それによる CANCELLED 後続だけを起動時に復帰させる。手動の週取消や A/B は対象外。Summit の既存 OutboxPort は、この family に限定した共通関数の adapter とする。

リマインド配送後は従来どおり Session の完了、開催・参加者の作成を同一の業務 transaction で行い、その後に通知を DELIVERED にする。message ID backfill は既存の CAS-on-NULL を維持する。

## 保持期間

`purge_discord_notifications(now?, family?, deliveredBefore?, failedBefore?)` は、終端から DELIVERED 7 日、FAILED / CANCELLED 30 日を過ぎた本文・parts・targets・最終エラーを整理する。追加の cutoff は期間を延ばす方向にだけ適用する。PENDING、IN_FLIGHT、有効な claim / 送信中の部分は整理しない。

親 ID、dedupe、kind、version、内容 hash、終端状態と、A/B の元ジョブ一意性は永久保持する。本文整理後の再受付は同じ行へ収束し、古い本文の閲覧・再送はできない。本文整理後のアンケートは、終了 Session を削除しても最小記録として成立する。

## 導入順序と検証

0041 は共通 table 群と開催 FK を追加し、0042 は旧 outbox の ID・本文・順序・送達証跡を移して関数・trigger を導入し、整理可能な終了 Session / 回答を削除する。0043 で旧 table を削除する。未配送・再試行可能な通知に必要な Session、進行中 Session、未来の日付の Session は残す。不明な過去開催を推測して作り直さない。

この切替は全 writer・配送の停止、復元確認済み backup、対応 consumer の一括切替が前提。DB 適用後に対応する既存 Summit を稼働させ、MOM-15 / 18 が整ってから MOM-16 / 17 の送出を有効化する。停止解除後の新規データを失う旧 backup への単純復元は行わず、development.md の recovery 規範に従う。

ローカル検証は保存対象の compose volume を使わず、専用 PostgreSQL 18 container と `momo_db_test_*` DB を用意する。`MOMO_DB_TEST_HOST` は localhost / 127.0.0.1 だけを許可し、DB 名が規約外ならテストは停止する。

```bash
export MOMO_DB_TEST_DATABASE=momo_db_test_notifications
export MOMO_DB_TEST_USER=postgres
export MOMO_DB_TEST_PORT=5432
export MOMO_DB_TEST_CONTAINER=your-disposable-postgres-container
pnpm build
pnpm db:check
pnpm test:prepare
pnpm test:integration
pnpm test:migrations
```

認証が必要ならテスト用の password を環境へ安全に注入する。`test:migrations` は同じ専用 container 内にランダム名の DB を作成し、0040 までの代表データを pg_dump / pg_restore して最新 tail を適用する。開催・参加者・試合・順位・事件・メモ・下書きの ID / 値、旧配送状態、一意性、既存 migration hash を比較し、自身の DB だけを後始末する。接続エラー・テスト失敗を skip 扱いにはしない。
