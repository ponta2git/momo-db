# Discord 通知の共有 DB 契約

物理 schema は [src/schema.ts](../src/schema.ts)、A/B の型と ID は [src/notifications.ts](../src/notifications.ts) が正本。TypeScript は `@momo/db` と `@momo/db/notifications` を使う。他言語も本書と JSON 例に従う。migration の作成・適用・復旧は [development.md](development.md) に従う。

通知可否、設定世代、取消、受付検証、配送・再試行・保持の判断と集約の更新境界はアプリケーションが所有する。DB に通知用の業務関数・trigger は置かない。一意制約・外部キー・形状制約と transaction / row lock / advisory lock はアプリの決定を永続化する機構として使う。

## 保存先

| テーブル | 責務 |
| --- | --- |
| `discord_notifications` | 親、固定 payload、内容 hash、配送状態、初回描画の renderer / 部分数 / delivery_context |
| `discord_notification_attendance` | 出欠アンケートの Session と revision / ordinal |
| `discord_notification_results` | A/B の種別・元ジョブ・成功時刻・設定世代。元ジョブ一意性を永久保持 |
| `discord_notification_settings` | A/B ごとに一行。初期 ON、世代 0 |
| `discord_notification_targets` | A の下書き、B に掲載する全試合。元データへの FK を持たない |
| `discord_notification_parts` | 部分番号、送信開始、所有権、試行数、Discord message ID。本文は複製しない |

`family=attendance` は `kind=send_message`、`family=result` は `ocr_completed` / `analysis_completed`。親と関連行の組合せは受付アプリが同一 transaction で保証する。DB は宣言済みの一意性・参照・形状制約を保証する。

元ジョブ・成果物・対象試合の整理で通知本体を連鎖削除しない。開催の `session_id` は `ON DELETE SET NULL` とし、出欠アンケート整理後も開催履歴と参加者・試合を残す。

## 通知 ID と内容照合

A/B は `result:<kind>:<sourceJobId>`。version、実行 attempt、HTTP request では変更しない。`sourceJobId` は `^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$`。A は画像単位の OCR ジョブ、B は成功した論理分析ジョブ。新しい手動分析ジョブは新しい ID。`(kind, source_job_id)` も一意とする。TypeScript の生成・受付・運用入口は `buildDiscordNotificationId` / `isNotificationSourceJobId` / `parseDiscordNotificationId` を共用し、末尾改行を含む部分一致を許可しない。既存 ID の内容照合は引き続き version 検証より先に行う。

既存の `jsonb-numeric-sha256-v1` を維持する。Summit が生 JSON を PostgreSQL の組込み JSONB text 表現へ正規化し、文字列の外の数値だけ末尾小数ゼロを除き、UTF-8 の SHA-256 を計算する。JSON.parse / JSON.stringify の数値丸めを内容照合に使わない。array の順序、文字列、欠落と null の違いを保持する。producer は hash を送らない。

同じ ID / 元ジョブと同じ内容は、取消・配送済み・本文整理済みでも既存行へ収束する。既存識別の照合を新規 version の検証より先に行い、異なる内容への差替えは 409。親 ID、family、種別、payload、hash、結果関連の識別はアプリから更新しない。

## v1 の固定 payload

完全な例は [OCR](examples/ocr-completed-v1.json) と [分析](examples/analysis-completed-v1.json)。例の ID・表示名は架空。

共通 envelope は `notificationId`、`kind`、`schemaVersion: 1`、`sourceJobId`、`occurredAt`、`settingsGeneration`、`data`。世代・分析 input revision・試合 source revision は精度を失わない十進文字列。成功時刻と試合日時は UTC の `YYYY-MM-DDTHH:mm:ss.sssZ`、開催日は `YYYY-MM-DD`。受付アプリは JSONB text 表現で 8 MiB を上限とし、本文を切り捨てない。

| data | 固定する内容 |
| --- | --- |
| A | 下書き・OCR・画像 ID、画像種別、succeeded / needs_review、要約、分かる範囲の作品名・開催日・試合番号 |
| B | 作品 ID・表示名、published / reused、前回と今回の分析識別、掲載試合、作品通算とシーズン通算 |
| B 掲載試合 | 試合 ID・source revision・開催 ID / 日・番号・日時、マップ・シーズン・owner、4人の名前 / 順位 / 銀次回数、銀次合計、メモ全文または null |
| B 集計 | 4人の memberId / 名前、前後の対象試合数 / 平均順位、丸め前の差分、比較状態 |

分析識別は `artifactId`、`inputRevision`、`algorithmVersion`、`artifactSchemaVersion`、`validationContractId`。`sourceJobId` は今回成功した論理ジョブを表し、成果物を作った元ジョブの履歴が整理されても結果の識別・比較を続ける。再利用は新しい通知 ID / `sourceJobId` と、前後で同じ成果物識別を持つ。配送時に元ジョブや成果物を再検索しない。

作品・シーズン通算は全マップを含む。シーズン一覧は追加・変更・削除で影響するシーズンだけとし、削除前とシーズン移動前後の所属を含める。試合の変更がない再計算では現在の全シーズンを載せる。掲載試合は前回成功から追加・更新された対象で、全履歴を表示時に再検索しない。削除試合は掲載せず、対象試合なしを全員銀次 0 回と区別する。未入力メモ欄は省略する。後日のメモ・表示名・試合編集を本文へ反映しない。リンク先は現在の下書き・試合詳細と最新分析であり、通知時点の分析を固定して表示する画面ではない。

比較状態は `comparable`、`initial`、`empty`、`incomparable`、`reused`。件数 0 の平均、初回の前値、比較不能な差分は null。微小差分は丸めず保存する。`reused` は同じ分析識別と集計を前後に置く。旧分析の `validationContractId` は null を許容する。形式検証は Summit、snapshot 計算と成功時点の内容保証は producer の責務。

## アプリケーションの更新境界

| command / 所有者 | 同じ commit に含めるもの |
| --- | --- |
| Summit の result 受付 | 親・payload・結果関連・対象一覧と、PENDING または取消状態 |
| momo-result API / Summit の設定変更 | ON/OFF、必要な世代加算、該当通知の未開始部分取消 |
| momo-result の対象変更 | 下書き確定・取消・削除、試合削除と、その対象を含む通知の未開始部分取消 |
| producer の成功 | 業務成功と、最後に取得した設定・世代・通知 snapshot の判断材料 |
| Summit の配送 command | claim、初回部分計画、開始、結果確定、失敗、期限回収の各短い更新 |
| Summit の出欠 command | Session の遷移と対応する attendance intent |

A/B の共通 gate は `pg_advisory_xact_lock(19790514, 1)`、attendance 配送は同じ名前空間の key 2。これらの値と取得順はアプリ間の排他契約であり、DB が業務上の集約単位を決めるものではない。

- isolation は `READ COMMITTED`。Summit と momo-result の設定 command は transaction に明示する。
- 対象変更は業務行の更新をすべて終えてから result gate を取得し、対象一覧から通知を決定論的な順で lock・取消して commit する。通知がまだなくても gate を取得する。
- gate を保持する通知 command は業務行を `FOR UPDATE` しない。受付が先なら対象変更側が新規通知を取り消し、対象変更が先なら受付側が commit 済みの取消条件を読む。
- gate 取得後に追加の業務行 lock や Discord I/O を行わない。取消 helper の後に別の業務書込みを追加するときは command 全体の順序を再検討する。
- DB 機構だけでは漏れた writer を補えない。下書きや試合を変更する新経路には、同じアプリ command と競合・rollback test を追加する。

momo-result は確認・取消・試合削除に加え、マスター・開催削除時の古い下書き清掃もこの境界に含める。業務判断を trigger で補完する方法は採用しない。将来 writer / throughput が増えて gate を細分化する場合は、全 writer の取得順と競合試験を同時に改訂する。

## 設定と producer

ON/OFF が変わるたび世代を一つ進め、同じ値の保存では進めない。OFF と未開始部分取消は同一 command。再 ON でも取消済み ID・古い世代を復活させない。attendance には適用しない。

利用者向け設定は momo-result API が共有 DB へ直接保存し、Summit の稼働・HTTP・worker に依存しない。2種類をまとめて保存する command は共通 result gate の取得後に最新の両設定を読み、両方の期待世代を確認してから変更する。一方でも競合したら両方とも変更せず、変更のない種類は世代・更新日時を維持する。変更判定と世代の遷移はアプリに置き、OFF にする種類の未開始部分取消を同じ transaction へ合成する。

Summit の `ResultNotificationsPort.setSetting` と専用運用 HTTP も同じ共有 gate・世代・取消契約を守る。利用者向け API の呼出先としては使わない。旧 `get/set_discord_notification_setting` 関数は存在しない。

MOM-16 / 17 の producer は成功 transaction の末尾で result gate を取得し、設定行を組込み SELECT で読む。ON ならその世代と成功時点の固定内容を確保し、commit 後に HTTP を一度送る。OFF なら送らない。B のメモ・表示名は、業務更新と gate 取得後の一括 SELECT の保存済み snapshot で固定する。その SELECT 後から commit までの編集は取り込み保証の対象外であり、このために編集側へ排他を追加しない。設定取得失敗を理由に業務成功を失敗させない設計は SAVEPOINT 等で明示し、後から現在の設定を読んで送出し直さない。

producer outbox、通知 HTTP の再試行・未受付通知の再構築、API の代理送出は追加しない。永続受付前の欠落は許容する。

## 永続受付

Summit の `ResultNotificationsPort.receive(rawJson, now)` が command を実行する。handler は commit 成功後だけ応答し、ローカル配送 wake を出す。

| 結果 | HTTP |
| --- | --- |
| accepted | 202、新規 PENDING |
| duplicate | 200、既存状態 |
| cancelled | 200、取消条件を満たす新規終端行 |
| identity_conflict | 409、識別と内容が不一致 |
| invalid_input | 400、不正入力 |
| unsupported_version | 422、新規通知の未対応 version |
| payload_too_large | 413、上限超過 |
| 受付不能 | 503、開始前・容量・DB・deadline 等 |

2xx は Discord 配送完了ではない。commit 後の応答喪失でも DB から回収する。caller の timeout は未受付の証明にならない。rollback は親・関連行を残さない。例外の SQL bind、payload、token、接続情報を response / log へ渡さない。

## 配送・取消・回復

Summit が保存 snapshot だけで描画し、初回に部分数・renderer version と `delivery_context={webOrigin, channelId}` を固定する。再試行は同じ本文・区切り・リンク・宛先で残りだけを配送する。部分番号は 0 始まりで連続し、N はそれ以前がすべて DELIVERED のときだけ開始する。

claim は送信開始ではない。各 Discord 呼出し直前に `begin` command が所有権・期限・取消・部分順序を検証して commit する。Discord I/O 中に DB transaction を保持しない。実際の呼出しごとに新しい clock を使う。

A は下書き確定・取消・削除、B は掲載試合の一件でも削除されたら通知全体を取り消す。設定 OFF / 世代不一致も取消条件。既送信部分と開始済み部分は残し、未開始部分を CANCELLED にする。開始済みの message ID を同じ有効 token で記録できるが、親は CANCELLED のまま。残存試合だけの B を作り直さない。

PENDING → IN_FLIGHT → DELIVERED / PENDING / FAILED。取消済み A/B は再 ON、起動、手動再試行でも復帰しない。期限切れ claim も最大試行数へ加算され、FAILED は自動復帰しない。保持中の適格な FAILED だけ、明示 retry で同じ ID / payload の `retry_cycle` を進め、別の有限 cycle を開始する。

失敗理由は `discord_unavailable`、`discord_rate_limited`、`delivery_uncertain`、`invalid_payload`、`unsupported_renderer`、`delivery_failed`、`attempt_limit`。外部例外全文は保存しない。旧 owner は確定できないが、Discord 受理後の停止では重複があり得る。安定 nonce は補助であり exactly-once を保証しない。

受付・起動・再接続・既存 supervisor の wake と DB の次回時刻で配送する。idle 中は通知専用の短周期 polling を行わない。長い通知は上限付き並行 slot で処理し、attendance の scheduler とは独立させる。

## 出欠アンケートと保持

Session の command は `enqueueOutboxInTransaction` で attendance intent を保存する。部分数は 1、既存 typed renderer が最新 Session を読む。Session ごとの revision / ordinal の順序を守り、先行 FAILED の後続を取り消す。

起動時は保持中の attendance FAILED と、それが原因の CANCELLED 後続だけを復帰させる。手動週取消・A/B は対象外。リマインド後の Session 完了・開催・参加者作成、message ID の CAS-on-NULL は維持する。

Summit は終端から DELIVERED 7 日、FAILED / CANCELLED 30 日を過ぎた payload・parts・targets・delivery_context・最終エラーを整理する。追加 cutoff は保持を延ばす方向だけ。PENDING、IN_FLIGHT、claim / 送信中部分は整理しない。親の ID・dedupe・kind・version・hash・終端状態と A/B の元ジョブ一意性は永久保持する。本文整理後の閲覧・再送はできない。

## 導入順序と検証

0041–0043 は旧 outbox を共有 table 群へ移し、開催履歴を守りながら旧 table を削除する。0044 は nullable delivery_context の追加、0045 は通知の業務関数・trigger の撤去。旧 migration は変更せず、保存済み通知・hash・設定世代・部分配送をそのまま残す。

全 writer・配送を停止し、復元確認済み backup と対応 commit を揃えて DB、Summit、momo-result API を一括で切り替える。旧 SQL 関数に依存する consumer / producer を残さない。新 producer の送出は設定連携・受付・配送が揃ってから有効化する。停止解除後は新規データを守る forward fix を原則とする。

旧 result に部分計画があり delivery_context が null の場合、Summit は宛先を推測せず unsupported_renderer にする。保持中の旧 renderer と宛先を特定できる回復版を用意するまで配送を再開しない。attendance はこの context を必要としない。

検証は保存対象 compose volume を使わず、専用 PostgreSQL 18 container と `momo_db_test_*` DB を使う。`MOMO_DB_TEST_HOST` は localhost / 127.0.0.1 のみ。

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

テスト用 password は必要な場合だけ安全に注入する。DB integration は native constraint・保存・業務関数撤去を検証する。業務遷移・競合・HTTP・配送は Summit、対象変更と取消の原子性は momo-result の integration test が保証する。migration test は 0040 / 0043 の2種類の prefix に代表履歴・全5状態・部分配送を作り、pg_dump / pg_restore 後に最新 tail を適用して全行・旧 hash・migration 履歴を比較する。自身の一時 DB だけを後始末し、失敗を skip としない。
