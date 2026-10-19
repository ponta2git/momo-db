# DB 改修・データ移行・デプロイの統合計画

作成日: 2026-10-17。敵対的レビューによる改訂: 2026-10-18。対象: momo-db / momo-result / summit。

2026-10-19 追記: この文書は計画当時の判断と受入条件を保存する。P0 の停止・配備制御と専用 repair は撤去し、P1 の汎用リハーサルと P2–P7 の DB 改修・検証資材は維持する。以下の P0 に依存する dispatch・停止・再開手順は現行の実行手順ではない。現在の CI と適用条件は [README](../../README.md#ci--cd) と [正規開発手順](../development.md#6-適用と-release-順序)、汎用 CLI は [リハーサル手順](../migration-rehearsal.md) を参照する。

内部 ID、公開 URL、冪等性、マスター、OCR、worker、DB function / trigger の改修を、準備 release、データ保全検証、本番適用、consumer 切替、復旧まで一つの計画として扱う。**本番の実データをローカルへ復元するリハーサルを必須とし、本番では全 writer を停止するメンテナンス時間を確保する。**

この文書は実装計画である。新しい migration、consumer 修正、移行 CLI、workflow 制御は未実装。本番接続、dump、リハーサル、本番適用も未実施。下記の受入条件は今後通す条件であり、通過済みの検証ではない。

規範は [DB 変更の正規開発手順](../development.md)、[共有通知契約](../discord-notifications.md)、[本番接続先の更新規約](../ops/neon-production-connection-rotation.md)。この計画を理由に migration の作成規則や本番承認を迂回しない。通常 workflow の入口・運用を変える準備 PR では、実装と正規手順を同時に整合させる。

## 1. 決定とレビュー結果

### 1.1 全体で守る決定

- 本番コピーでの事前リハーサルに加え、**全 writer 停止後の最終 backup でも、復元・移行・保全比較・consumer smoke・復旧確認を行う**。停止枠に収まらなければ延期または移行単位を縮小する。
- ローカルは準備・比較・GitHub 実行の起動と監視を担う。本番 SQL は固定した正規 migration を保護された CI から適用する。変換済みローカル DB を本番へ上書き restore しない。
- 最終証拠を承認対象へ渡すため、移行用 `workflow_dispatch` を準備する。DB は既存の `production-db`、momo-result は既存の `production` 承認を維持する。Summit は固定 image の手動配備を維持する。
- 一度の巨大変更にはまとめない。準備、ID、OCR、trigger、scheduler、互換撤去を分け、各本番 release に同じ適用・復旧手順を使う。組み合わせる場合は組合せ全体をリハーサルする。
- 停止状態は CLI や runner が終了しても残す。再開を明示記録するまでは、通常受付・処理・配送・別 deploy を閉じる。利用者の通知設定を保守スイッチに流用しない。

### 1.2 敵対的レビューで修正した破綻経路

| 重要度 | 破綻経路 | 計画に組み込む対策・受入先 |
| --- | --- | --- |
| 重大 | 通知設定 OFF が未配送通知を取消し、generation を変える | 設定を変えない runtime 停止。enabled / generation / 部分配送を保全（P0・P2） |
| 重大 | 保守再計算が pending の利用者要求に合流し、通知基準まで消費する | 最終停止前に対象の要求を通常処理で収束。保守処理との合流を検査（P0・P2） |
| 高 | backup 後に writer が一度動いて再停止すると、古い証拠で適用できる | 永続停止、状態の世代、証拠失効、SQL 直前のデータ fingerprint 比較（P0・P1） |
| 高 | ローカルの証拠と GitHub の承認・実行 attempt が結び付かない | 固定入力の dispatch、承認前の証拠 artifact、適用時の再照合（P0・P1） |
| 高 | DB は復元できても API・worker・Summit・CI が別々の DB を向く | 別 DB への接続先切替と実接続確認まで復旧訓練（P0・P1） |
| 中 | account ID の変更を別利用者と誤認し、ブラウザの未保存入力を消す | 安定した client identity と旧保存状態の互換、旧タブからの E2E（P2・P3） |
| 中 | 長時間停止で未完了 OCR 受付が業務上の期限切れになる | 新規受付停止後、既存 admission を通常完了・正規終端させる（P0・P2） |
| 中 | 旧 artifact は表示できても、旧 basis を使う次の更新に失敗する | 元 checksum 検証と identity 変換を分離し、次の操作まで検証（P2・P3） |
| 中 | maintenance 起動でも startup / reconnect が先に書込み・送信する | 起動処理より前の mode 判定、専用 readiness、設定 identity の固定（P0） |
| 中 | deploy 後に Release 発行を止めると、再開後に発行する契機がない | 再開証拠を使う publish 専用入口。deploy は再実行しない（P0） |
| 中 | 再計算の timeout や遅延で復旧余裕がなくなる | 各段階の開始期限、同じ campaign の確認・継続経路（P0・P1） |

具体的な実装根拠は第 10 節、失敗注入の受入条件は第 7 節にまとめる。

## 2. 改修範囲・実装単位・依存関係

### 2.1 到達点と境界

| 項目 | 到達点 | 保持する契約 |
| --- | --- | --- |
| 内部 ID | canonical な実体 ID と内部参照を native `uuid` へ移す | 既存 UUID の値、immutable 履歴の旧表現、意味のある TEXT・外部 ID を区別 |
| 公開 URL | まず `matches` / `held_events` に `public_id bigint GENERATED ALWAYS AS IDENTITY UNIQUE` | 内部 UUID と型・名前を分け、旧リンクと認可を維持。JSON は十進文字列、欠番可 |
| HTTP 冪等性 | 新規キーと `idempotency_keys.key` を UUID 契約へ統一 | `(key, account_id, endpoint)`、旧 replay / pending / 保存応答、SHA-256 `request_hash` の `bytea` を維持 |
| マスター・事件 | 作品・マップ・シーズンは名前と独立した UUID。事件は UUID と意味の `key` を分離 | 作成再試行で同じ ID、業務 UNIQUE、事件は固定 6 項目 |
| OCR | `momotetsu_2` / `world` / `reiwa` をコード所有の正式な layout 契約にする | 既知 alias の正規化、不明値拒否、未指定と自動選択、TEXT と CHECK |
| Function / trigger | 暗黙の業務判断・補正を API / worker の明示更新へ移す | 同一 transaction、lock 順序、参照整合性、公開済み不変性 |
| Scheduler | インスタンス単位の CPU / メモリ予算と同時実行数を管理 | 初期同時実行数は 1。job 単位の lease / fencing / 回収を DB に残す |
| OCR 優先 | queued job の選択優先度と実行中分析の中断を別に判断 | 確定入力 revision・公開時検査による正しさ。preemption は待ち時間と再計算コストで判断 |
| Capability | 実行中 worker / reader の能力、heartbeat、draining を DB で共有し続ける | 対応仕様の定義はコード。release 世代照合と排他を維持 |

SHA-256 の hex 列全般の `bytea` 化、OCR 定義の DB マスター化、汎用 DAG、処理内のタスク分割、並列数引上げ、事件の作品別追加・削除・改名は範囲外。事件の将来拡張に必要な「意味の key、作品別適用、対象外と 0 の区別」は論点だけ記録する。

### 2.2 PR と release の分割

DB は momo-db、API / Web / processing-worker は momo-result、通知受付・配送・出欠は Summit が所有する。各 P の PR に対応 repo、固定 SHA、受入証拠を紐づける。merge、配備、再開を別状態として管理する。

| 単位 | 実装するもの | 依存・完了 gate |
| --- | --- | --- |
| P0 停止・配備・復旧の準備 | 永続 maintenance 制御、全 writer 一覧、drain、起動前 guard、専用 readiness、固定 image / 設定保持、証拠付き dispatch、publish 専用入口 | 旧 schema で先行 release。通常運用と停止・復旧の両方を検証。旧 workflow の再実行も停止を破れないこと |
| P1 棚卸し・移行 CLI | 列別変換表、manifest、接続先・ledger・データ guard、隔離 snapshot / restore / compare、接続先切替の復旧訓練 | P0 と独立にローカル実装可。本番コピーを復元して schema・値・ledger の一致を確認。第 3 節の設計を実データで確定 |
| P2 Consumer 互換 | 旧 ID / URL / HTTP replay、ブラウザ保存状態、計算 identity、旧 basis の操作互換、固定 6 事件の key 参照、旧 OCR payload 読取り | P1 の参照棚卸しに依存。旧 schema 対応を先行配備。追加列が必要なら互換的な expand を独立 migration にし、新旧組合せを検証 |
| P3 ID・保存契約 | 公開番号、HTTP キー、canonical UUID、マスター生成を個別 migration・比較単位に分割。対応表、backfill、参照切替、constraint を実装 | P0〜P2 完了。immutable identity の設計 gate、本番コピー、fresh DB、全 consumer、復旧訓練が合格 |
| P4 OCR 正規化 | API / Web / worker の同一契約、既知 alias 正規化、3 table の CHECK | P1・P2 完了。既存 hints / pending payload と不明値を監査。P3 とは別 release を基本とする |
| P5 Function / trigger | 第 3.4 節の 3 暗黙更新の移植、2 guard の業務部分分離 | 全 mutation path を先行修正。trigger 撤去後にも整合・競合試験を通す。P3 と release を分ける |
| P6 Scheduler | job 単位の所有権と資源予算を分離し、global slot を使う経路を置換。OCR 優先方針を改訂 | 複数 worker、期限切れ、旧 owner、子 process 回収を検証後に slot 撤去を判断。P5 と独立検証 |
| P7 互換撤去・運用完了 | 不要な旧列・互換コードの段階的撤去、運用文書、残存互換経路の記録 | 再送、履歴、旧 URL の実参照がない対象だけ別 release で撤去。永続 alias は残せる |

最初の DB 側 PR は P1 の変換表・manifest・隔離復元・比較・接続 guard の骨格とする。consumer / workflow 側では P0 を先行させる。P0 を本番で確認する前に破壊的な ID 切替を開始しない。P1 の実データ設計 gate より前に変換 SQL を確定しない。

P0 自体はデータ変換を含めず、現行の通常承認・配備手順で導入する。その bootstrap を未実装の新しい停止手順に依存させない。導入後に旧 schema 上で停止・再開を確認し、以後の移行で使う復旧版を固定する。

## 3. データと consumer の設計 gate

### 3.1 列別変換表と ID の割当

全 column と参照元について「値の分類、移行先、生成規則、互換期間、比較、復旧方法」を記録する。FK 以外に JSON、汎用 target ID、保存応答、session / token、ブラウザ保存値、URL、checksum、seed、object key を含める。

- 有効な UUID は同じ 128 bit 値を保持する。表記差の正規化で衝突する別実体は黙って統合しない。worker 名、lease owner、構造化通知 ID / dedupe、Discord ID、layout family、validation contract 名を一括変換しない。
- 非 UUID は entity 種別と旧 ID をキーに一意な対応を持つ。割当アルゴリズム・namespace を固定し、再実行や最終コピーへの新規行追加でも既存割当を変えない。
- 公開番号は安定した旧キー順等、明示した規則で割り当てる。sequence が既存最大値を超えて採番することを確認する。番号を件数・作成時刻・試合順の代わりに使わない。
- 旧 ID と新 public ID が同じ URL 名前空間で衝突しないか調べる。特に旧 ID が数字の場合、二重 lookup の優先順位だけで別実体へ誘導しない。必要なら route を区別し、旧 path / `focusMatchId` 等の query と認可を維持する。
- 旧 URL、保存通知、immutable 履歴が参照する alias に一律の撤去期限を設けない。未知値、参照漏れ、衝突、非一意な変換が残る column の移行は進めない。

### 3.2 分析値・immutable 保存値・次の操作

現行コードは ID を入力の再整列、乱数 seed、artifact / radar checksum に使う。SQL の並び順だけを修正しても分析結果は保全できない。

1. DB の canonical UUID と、既存データの安定した計算 identity・同時刻の順序を分離する。旧版 / 新版で同じ入力を計算し、ID 対応を正規化して集計値・順位・bootstrap 区間・対象・radar 値を比較する。UUID 化だけを理由に数値差を許容しない。
2. sealed / 公開済み artifact、radar basis の既存 header・payload・scope key・checksum・source snapshot は保持する。header 全体の不変性検査があるため、新列 backfill や FK の連鎖更新も無条件に許さない。
3. canonical UUID への接続は別の対応表を第一候補とし、旧 FK を支える legacy identity・一意性を残す。保存用 identity、計算用 identity、canonical ID の境界を列別に確定する。guard を外して payload を書き換える方法で済ませない。
4. 旧 payload は**各保存形式の既存 checksum 契約で先に検証**する。bytea は元 bytes、JSONB は元値と既存の decode・canonical serialization を維持し、その後に計算・参照用の一時的な identity 変換を行う。JSONB の表示文字列を直接 hash する方式へ変えず、変換済み payload に元 checksum を付けたり、checksum を更新して改変を隠したりしない。
5. 閲覧だけでなく、移行後最初の試合確定・分析再実行、旧 basis からの radar 手動編集・適用・復元まで通す。旧 current を保持する案は、これらと reader / worker 契約が成立する場合だけ採用する。
6. 新形式への切替が必要なら identity / schema 契約を明示し、閉じたメンテナンス中に再計算・検証・promotion を行う。不要なら別 release に分ける。current / previous / 通知基準の扱いは最終リハーサル前に固定する。

保守再計算は queued / running job に合流し、同じ attempt の利用者要求を fulfilled にし得る。通知抑止だけでは未通知変更を守れない。**基本方式は、対象の利用者要求と通知待ちの分析状態を停止前に通常経路で収束させること。** 収束できなければ延期する。残したまま移す必要が判明した場合だけ、request 単位の分離・通知基準の保全を別途実装し、その方式で再リハーサルする。

根拠となる DB guard は [0067](../../drizzle/0067_radar-manual-validation-contract.sql) と [0059](../../drizzle/0059_radar-publication-guards.sql)。

### 3.3 HTTP・ブラウザ・通知・OCR の互換

- HTTP は認証・scope を検証した上で旧キーの既存 replay / pending を解決する。新規キーの UUID 検証だけを先に置いて旧再送を拒否しない。UUID 表記差で別操作だった旧キー、account / endpoint scope、保存応答、request hash の比較順序を保持する。旧 body 内 ID の正規化で同じ操作を再実行・誤った 409 にしない。
- 内部 UUID の変更を Web に別利用者と認識させない。安定した client principal identity または先行する保存形式互換を用意し、account / workspace を含む storage key・baseline fingerprint・未保存入力・再送状態を引き継ぐ。旧タブの新規操作を受け入れる範囲と、入力を保ったまま更新を案内する範囲を定義する。別利用者の状態を誤復元しない。
- account / member / role / 所有者と session の参照、credential 保存値を維持する。正規の session / replay 期限経過は別に扱い、期限を一律延長しない。互換撤去は保持期間だけでなく、清掃・pending 解消・再送契約まで確認する。
- 通知の enabled / generation、ID、`(kind, source_job_id)`、dedupe、payload / hash、renderer、宛先、取消、部分配送、message ID を維持する。停止は runtime の新規処理・送信禁止で行い、設定 OFF→ON で代用しない。既存 envelope や履歴整理済み identity も保持し、JSON の検索置換・再hash・一括再配送をしない。
- 新規 OCR admission を閉じた後も、既に受け付けた upload 等は期限内に通常完了・正規終端させる。未完了 admission を最終 baseline へ持ち込まない方式を基本とする。技術的 lease の回収と、業務 deadline による失敗を区別し、長時間停止・再試行を検証する。
- OCR の canonical 値・alias・不明値拒否を API / Web / worker で一致させる。`game_titles` / `matches` / `match_drafts` の `layout_family` を対象にし、下書きの nullable 契約を維持する。既存 hints / pending payload は互換 reader を用意してから CHECK を強化する。
- object key は原則維持する。DB 参照と OCR payload の一致を検査し、実画像 smoke に必要な object はローカル mirror を準備する。DB dump だけでは画像本体を保全・検証したことにならない。

### 3.4 Function / trigger と scheduler

| 対象 | 明示的なアプリ更新 | DB に残す保証 |
| --- | --- | --- |
| `ensure_series_analysis_title_state` | API が作品と分析初期状態を同一 transaction で作成。release 世代の lock も移植 | 対応・一意性・release 切替との整合 |
| `bind_series_analysis_radar_job` | API / worker が作成・coalesce・requeue の basis / generation を決定 | 参照整合、job 所有権、世代との整合 |
| `clear_series_analysis_lease_validation_contract` | 終端化・supersede・期限回収等が lease 関連列を明示 clear | 不正な組合せを CHECK で拒否 |
| `validate_series_analysis_artifact_pointers` / `guard_series_analysis_artifact_publication` の業務部分 | 対応 schema / validation contract、outlook の必須リソース・件数をアプリ検証へ集約 | 同一作品、公開状態、desired tuple、sealed / 公開済み不変性 |

全 mutation path を修正・検証してから trigger を撤去する。新旧共存時の二重作成・上書きも確認する。非同期処理への分解や CHECK 全般の削除はしない。公開済み child、radar basis、candidate 入力、revision 履歴の保護を残す。

`worker_execution_slots` の撤去は、job 単位の claim / renew / finish / recover と fencing の完全性を確認してから決める。作品単位の有効 job 制約、input revision、公開 guard は維持する。DB lease は旧 owner の書込みを拒否し、runtime は停止した子 process と実資源を回収する。将来の子タスクも同じ予算に計上できる境界を作るが、今回その分割や並列数増加は行わない。

OCR 完了は下書きを作り、確定・編集・削除が分析入力 revision を更新する。queued OCR の優先を基本候補にし、分析 preemption は待ち時間と捨てる計算量で再評価する。要件・運用文書も実装と揃える。

## 4. メンテナンス制御と候補固定

### 4.1 停止を継続する仕組み

P0 で一つの `cutover_id` と停止の世代 `stop_epoch` を管理し、所有者、候補、許可操作、run / attempt、証拠を結び付ける。段階の進行を表す `state_version` と、停止が継続していることを表す `stop_epoch` は分ける。制御記録は対象 DB の restore と CLI 終了に影響されない永続先に置き、更新主体を一つに限定する。保存先・更新排他・各 repo の読取り権限は P0 の設計記録で具体化し、障害注入を通すまで P0 を完了にしない。ローカル manifest や複数の独立した boolean だけを正本にしない。

- app / machine 側にも maintenance mode と自動起動禁止を永続化する。通常 deploy、analysis operation、rollback、手動操作も同じ制御記録を確認する。repository ごとの concurrency は横断排他の代わりにならない。
- 停止は scheduler だけでなく、API の業務更新・認証更新、worker の claim / recovery / cleanup、Summit の member 同期・通知受付・Discord 接続・startup reconcile、batch、外部配送、storage cleanup を含める。起動・reconnect の処理より前に mode を判定する。
- maintenance readiness は「固定 image / 設定、接続先、schema / reader 契約を確認でき、通常処理は閉じている」状態とする。許可する capability 登録・heartbeat・保守生成データ等を列挙し、それ以外の DB 差分と外部送信を禁止する。
- CLI 終了、runner timeout、machine 再起動で解除しない。writer の一時復帰、許可外 deploy、停止継続の不確実性があれば停止世代を無効化し、最終 backup と証拠を失効させて調べ直す。許可された段階の進行は `state_version` を更新するが、それだけで baseline を失効させない。
- 移行前には、候補以外の実行中・承認待ち本番 run を整理する。旧 workflow の rerun は元の SHA / REF を使うため、新 guard の追加だけでは保護できない。既存 environment の承認・配備権限側でも旧 run を拒否できることを実証する。できなければ切替を開始しない。[GitHub の rerun 仕様](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs?tool=cli)

新規受付を閉じた drain 段階では、既存の利用者要求、分析と正当な通知生成、OCR admission、送信中の処理を通常契約で収束させる。残る PENDING / 部分配送通知は保存できるが、送信結果不明のまま配送済みと推定しない。汎用のキュー退避・全期限延長・時計停止機構は導入しない。

### 4.2 固定する候補と復旧版

DB / Summit / momo-result の完全 SHA と DB ref、producer run / attempt、artifact ID・image digest、lockfile、非 secret config digest、secret 設定の version 識別を固定する。secret 実値やその単純 hash は公開しない。同じ image でも設定が違えば同じ検証対象とは扱わない。

復旧版は **maintenance 対応済みで旧 schema に対応する準備 release** とする。起動と同時に通常処理を再開する旧 image を復旧確認に使わない。Summit の image も事前に build・検証・保持し、当日の remote build で作り直さない。候補・復旧 image と証拠の保持期限を停止枠・復旧期間より長く確保する。

候補作成前に `PREPARING` として配備制御を有効にし、master push の通常 mutation を保留して build / quality / candidate 作成だけを進められるようにする。この段階では既存サービスの通常稼働を続け、DRAINING で新規受付を閉じ、FROZEN で全 writer を止める。各 repo の最終 master SHA を揃えて以降は release を凍結する。追加 merge、SQL / consumer / mapping / 依存 / 設定変更があれば候補を作り直し、影響する証拠を更新する。

## 5. Migration・CLI・GitHub への証拠受渡し

### 5.1 正規 migration の共用

宣言可能な DDL は `src/schema/` から `pnpm db:generate`、precondition / backfill / function / trigger は `pnpm db:generate --custom` で生成し、DDL・custom SQL・data migration を分ける。適用済み SQL / journal / snapshot は変更しない。[Drizzle custom migrations](https://orm.drizzle.team/docs/kit-custom-migrations)

同じ固定 commit の SQL・順序・mapping 規則をローカルと本番で使う。復元 DB は `drizzle.__drizzle_migrations` を保持し、正規 migrator で pending tail だけ適用する。momo-result の空 DB 用 `apply-momo-db-migrations.sh` は ledger を作らないため流用しない。

現固定版の migrator は pending tail 全体を一つの transaction で実行する。ファイル分割だけでは中間 commit・consumer 切替点は作れない。適用境界が必要なら release / commit を分ける。index、FK / CHECK、型変更、backfill の lock・容量・時間を測り、transaction 内で使えない index 作成方式を混ぜない。

### 5.2 計画する CLI

momo-db の `scripts/migration/run.mjs` と必要最小限の module に実装する。Node 24・固定依存と既存の接続・履歴検査を再利用する。以下は **未実装の予定 interface**。

| subcommand | 役割・書込み先 |
| --- | --- |
| `prepare` / `inspect` | 候補・writer・変換表・接続先・ledger・値を棚卸しし、private manifest をローカルへ保存。source は読み取り |
| `snapshot` / `restore` | 整合 dump を保存し、所有 marker がある隔離ローカル DB だけへ復元 |
| `rehearse` / `verify` | 固定 tail の適用、保存値比較、別 copy の consumer smoke、所要時間記録。verify 自体は読み取り |
| `recover-rehearsal` | 別 DB への旧 backup 復元、旧 consumer と migration 接続の切替・照合 |
| `maintenance-stop` / `status` | 明示した対象を drain・停止し、永続状態と証拠を記録・確認。SQL migration は行わない |
| `production-run` | 固定証拠を dispatch 入力へ渡し、DB / アプリの既存承認順を案内・監視。Summit の手動配備証拠も登録 |
| `maintenance-continue` | 同じ cutover・operation / campaign の状態確認と許可済み保守処理の継続。通常 job を開かない |
| `resume` / `publish` | 再開条件を確認して再開境界を永続記録。安定確認後、証拠付き publish 専用 workflow を起動 |
| `cleanup` | run が所有するローカル一時資源だけ削除。機密成果物は保持方針に従う |

例: `node scripts/migration/run.mjs rehearse --manifest <private-path>/manifest.json`。source / target credential を分離して安全に注入し、URL・token を引数・ログ・manifest に出さない。暗黙の `.env.local` fallback、任意 target の `--force` は設けない。

restore / cleanup は loopback、container 所有 marker、DB 名と実体を照合し、remote DB を対象にできない構造にする。保存対象の `summit-postgres` / named volume は使わない。本番 restore をこの CLI のローカル復元機能で実行しない。

### 5.3 private manifest と CI 証拠

詳細 manifest は暗号化・アクセス制限したローカル領域に保存し、実 ID・差分・mapping・実接続先を CI artifact や repository へ載せない。CI 用には allowlist した JSON 証拠を生成する。

| 証拠 | 含める内容 |
| --- | --- |
| 候補 | 3 repo SHA、workflow revision、producer run / attempt、artifact ID / digest、image / config identity、tool / lockfile / mapping / 比較仕様 version |
| 最終 baseline | cutover ID・stop epoch、source の opaque identity、取得時刻、dump・全 ledger・保存対象データ fingerprint・pending tail の digest |
| 合格結果 | fresh / 本番コピー / consumer / 復旧の結果、所要時間、詳細 manifest digest、停止継続の証拠 |
| 実行 | 対象 repository・workflow・run ID・attempt・操作、state version と許可する遷移、直前段階の DB / Summit / deploy 証拠、許可する保守 operation |
| 再開・完了 | 再開境界、実際の配備組合せ、安定確認、対象 deploy attempt、復旧済みでないこと |

受渡しは次の一つの経路に固定する。

1. master push で候補を build・検証する。maintenance 中は通常の自動適用を保留する。最終コピーの検証後、CLI が検証証拠を入力に DB の maintenance dispatch を起動する。
2. 承認前 job が入力を検査し、自分の run ID / attempt と候補を付けた証拠 artifact を作る。その artifact ID / digest と要約を既存承認 job に渡し、承認者が private な詳細結果と照合できるようにする。
3. mutation job はその特定 artifact を取得し、digest、自分の run / attempt、候補、永続停止状態、実 DB を再照合する。可変の repository 変数、最新 artifact の名前検索、成功 boolean で承認対象を差し替えない。
4. DB 成功・本番比較と Summit の配備確認後、同じ方式で momo-result の maintenance dispatch を起動し、既存 `production` 承認を受ける。事前 build の producer artifact を使い、配備 attempt と区別する。
5. 再開・安定確認の証拠を publish 専用 dispatch へ渡し、既存 publisher を共用して Release を発行する。DB / deploy を再実行して発行をやり直さない。

dispatch と通常 deploy は migration / 配備の実装、接続 guard、既存 environment、排他を共用し、別の SQL 適用経路を作らない。dispatch の ref と checkout は許可した最終 SHA に一致させる。`production-db` と後続 mutation の間でも承認済み証拠を引き継ぐ。[GitHub の手動起動](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow?tool=cli)

同じ run の再実行でも attempt は変わる。maintenance mutation の retry は原則として新しい dispatch とし、実 DB の状態を確認して新しい実行証拠を作り、既存承認を受け直す。以前成功した承認 job を再利用して failed mutation だけ実行しない。変更のない producer artifact / 通常 quality 証拠は再利用できるが、停止状態と実行証拠は再確認する。digest はローカル検証の真実性そのものを証明しないため、承認者による詳細結果の照合を省略しない。

### 5.4 SQL 適用直前の guard

CI は接続先が許可した本番実体であることに加え、現在の **全 ledger が最終 baseline と一致し、target の正しい prefix であること**を確認する。SQL hash・順序・timestamp、実 pending tail、候補・設定・mapping と証拠が一致しなければ適用しない。

さらに保存対象データの fingerprint を停止直後 baseline と比較し、停止の連続性・stop epoch・許可された現在の段階を再確認する。停止後の許可外更新、古い証拠、別 branch / DB を拒否する。現在の ledger が既に target と一致する場合は「適用成功の可能性がある結果不明」として verify-only へ回し、元 baseline のふりをして再適用しない。部分一致・未知状態は中止して調査する。

## 6. 本番コピーを使うリハーサル

### 6.1 コピーと隔離

初回は本番の整合した snapshot、最終実行は全 writer 停止後の backup を使う。fixture や値・参照分布を変える匿名化 DB だけでは代替しない。稼働中の取得は dump と同じ snapshot の監査値、または復元 baseline を基準にし、後から変わった本番の件数と比較しない。取得中の別 migration も排除する。

`pg_dump` の custom format で application schema、`drizzle` ledger、sequence を含む DB 全体を取得する。`public` だけに限定せずファイルへ stream する。既存 test helper の 32 MiB buffer・全 row のメモリ展開は本番規模に流用しない。PostgreSQL major、extension、collation、timezone、owner / ACL を実体から確認する。repository の検証環境が PostgreSQL 18 でも本番と同じとは仮定しない。[pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)

復元エラーを失敗として扱い、schema・値・ledger を読み戻して検査する。owner / ACL はローカルへ対応付け、app の制限された権限も再現する。superuser だけで動く検証にはしない。cluster role・provider 設定・外部 object は dump に含まれない部分として別管理する。[pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html)

dump・差分・mapping は secret 相当とし、暗号化、ディレクトリ / ファイルの権限制限、保持期限、削除責任を決める。検証 container の外向き通信を制限し、本番 token を渡さない。Discord、object storage、wake、メール等は local stub / mirror に向け、cleanup も本番資源へ届かないようにする。

### 6.2 一回のリハーサルで行うこと

1. dump を復元して baseline copy を保存する。移行せず読み取り専用の比較基準とする。
2. 初回調査では移行前 copy で未知値・参照・immutable 設計を確認し、第 3 節の設計 gate を確定する。その後の各リハーサルでは precondition を通した migration copy へ固定 tail を適用し、lock・所要時間・容量を記録する。最終回に未知値が見つかれば適用せず戻る。
3. app 起動前に全保存値・参照・schema・ledger を比較する。旧 ID をキーに対応後の値を stream / chunk 比較し、日時、null、JSON 数値、bytea の精度を保つ。許容差分は column と理由で明示し、JSON 全体などを除外しない。
4. 移行済み DB の別 smoke copy で、新 consumer の maintenance 起動、切替、旧データ読取り、次の更新、再送、再計算・promotion・通知抑止を確認する。通常の書込み試験はこの copy で行う。必要な実画像 mirror がなければ該当 OCR smoke は未合格とする。
5. 別の recovery DB へ旧 backup を戻す。旧 pool を閉じ、旧 consumer と migration 接続の全てを recovery DB へ切り替え、各プロセスの実接続先・ledger を確認する。元 DB への writer が残らない状態で旧版の動作・保全を確認し、復旧時間を測る。
6. 同じ baseline からの割当再現性と、完了 DB への正規 migrator 再実行が追加適用しないことを検証する。既存の破壊的 fixture suite は別 DB で行い、baseline / migration copy を初期化しない。

旧ブラウザ bundle、sessionStorage 等、未保存入力、応答喪失後の再送状態は DB コピー外の fixture として保存し、移行・auth 再取得・reload・次の操作・復旧まで E2E に含める。

固定 artifact の通常 quality suite と CLI 障害注入は事前に完了させ、変更がなければその証拠を再利用する。**最終 backup 自体の復元・移行・比較・切替 smoke・復旧確認は省略しない。** 停止枠には drain、backup / 転送、最終リハーサル、本番適用、全件保守再計算、配備、確認、復旧余裕を含める。各段階で残り時間が後続処理＋復旧余裕を下回れば、次の変更を開始しない。

## 7. 受入条件と検証の責任

| 対象 | 必須の合格条件 |
| --- | --- |
| 履歴・schema | fresh DB の全履歴と復元 DB の tail が成功。全 ledger、型・constraint・index・function・trigger・snapshot が期待どおり |
| ID・マスター | 一意 mapping、全件 coverage、孤児なし、非変更値の保持、sequence 正常。rename / 再試行で実体不変。固定 6 事件の意味と件数を保ち旧 PK literal 分岐なし |
| 分析・immutable | 同じ計算 identity で数値・順序・対象を保全。元 header / payload / checksum 不変。旧 basis からの次の操作と current / previous / 通知基準が整合 |
| HTTP・認証・URL | replay、409、scope、旧非 UUID、表記差、pending、期限境界、応答喪失後再送。既存 session・所有者・認可、旧 path / query、新 public ID、数値 ID 衝突を検証 |
| ブラウザ | 旧タブの未保存入力・再送状態が移行 / reload / 復旧で失われず、別利用者へ漏れない |
| 通知 | 設定 generation、payload / hash / dedupe、取消、部分配送、既存 envelope の保持。同一再送は duplicate、異なる内容は conflict、非対応 version 拒否を維持 |
| 保守と利用者要求 | 旧 current＋pending match mutation＋保守 campaign のケースで、元要求・正当な通知が欠落・二重生成しない。保守由来のみの通知を作らない |
| OCR・期限 | 3 canonical family、alias、未指定、自動、不明値、旧 payload / object key。admission deadline を超える停止・再試行を検証 |
| Trigger・lease | 作品作成と release 切替、coalesce / requeue / recovery、全終端の clear。不正参照・公開・履歴変更、二重 claim、期限切れ旧 owner の finish / publish を拒否 |
| Scheduler・鮮度 | 子 process 回収、再起動、取消、再取得。OCR 到着では確定入力を変えず、確定・編集・削除後に古い成果物を current にしない |
| 復旧 | 旧 backup＋maintenance 対応旧版が別 DB で成立。全 app / CI の実接続先と ledger が揃い、元 DB の writer がなく、時間内に復旧できる |

P0 / P1 の障害注入は次を必須とする。

| 注入する失敗 | 期待する挙動 |
| --- | --- |
| CLI 強制終了、runner timeout、machine restart / reconnect | 停止が残り、許可外 DB 差分・外部送信がゼロ。専用 readiness で確認可能 |
| 旧 deploy / rollback / analysis の rerun、writer 一時復帰後の再停止 | 変更を拒否。停止が破られた場合は final backup / 証拠を失効させる |
| 承認後の差替え、別 run / attempt、同 SHA・別 image / config、証拠欠落 | mutation を開始しない。旧承認の成功だけで新 attempt を通さない |
| SQL commit 後の CI 応答喪失、切断、未知 ledger | 自動再適用・再開せず実状態を確認。target 全一致なら verify-only |
| 復旧先設定の一部更新失敗、旧 pool 残存 | 全 consumer と CI が同じ DB を向くまで再開しない |
| 長時間 campaign、backup 遅延、復旧余裕不足 | 次の変更を開始せず、同じ operation の確認・継続が可能。二重 campaign を作らない |
| deploy 成功後・再開前の publish、別 cutover 証拠、publish 再試行 | 再開前・不一致は拒否。正しい再開証拠で一度だけ発行し、再試行は冪等 |

通常 gate は各固定 commit の正規手順に従う。momo-db は `pnpm build` / `pnpm db:check` / 専用 DB の `pnpm test:prepare`・`pnpm test:integration`・`pnpm test:migrations`。Summit は typecheck・lint・test・build・DB integration。momo-result は API の `apiQuality` / `testFull` / `apiDbQuality`、Web の format・lint・contract・typecheck・test・scripts・build と対象 E2E、worker の fmt・clippy・workspace test・Linux 実運用 image / process lifecycle を通す。本番コピーと fixture suite は相互に代用しない。

## 8. 本番の承認・配備・再開順序

これは各移行 release で使う唯一の本番順序とする。現在の workflow を無変更で実行できる手順ではなく、P0 の実装・検証が前提である。

| 順番・状態 | 実施する操作 | 次へ進む条件・承認 |
| --- | --- | --- |
| 0 準備完了 | P0 を旧 schema へ先行 release。復旧版、復旧先・権限、制御記録、GitHub 保護設定、旧 run 拒否を確認 | private runbook と実環境を照合。担当者、停止枠、各開始期限を確定 |
| 1 PREPARING / 候補固定 | 通常サービスは稼働したまま配備制御を有効にして通常適用を保留。DB 最終 SHA → Summit の DB ref・SHA・image → momo-result の DB / Summit ref・release PR の順で候補を作る | exact な最終候補の CI と事前本番コピーのリハーサルが成功。通常 DB / app deploy は承認しない |
| 2 DRAINING | 担当者の運用で案内し、新規受付を閉じる。既存 user request / OCR admission / 分析と通知生成 / 送信中処理を収束 | 残せる PENDING・履歴を明示。未解決の要求・送信結果・期限状態があれば停止完了にしない |
| 3 FROZEN | app deploy から独立して全 writer・配送・cleanup と自動復帰を止める。旧子 process・transaction の終了を確認 | 永続停止、実接続先、全 ledger、保存値の基準が揃う |
| 4 最終検証済み | 停止直後 backup を取得し、第 6 節の最終ローカルリハーサルと接続先切替の復旧訓練を行う | 全保全・consumer・復旧が合格。停止継続と残り時間も有効 |
| 5 DB_APPLIED | 固定証拠で DB dispatch。GitHub の `production-db` を承認し、必要なら `CI Actions` の既存承認も受ける | CI の直前 guard → 正規 migration → ledger / schema / 本番データ保全比較が成功 |
| 6 SUMMIT_STAGED | 固定 Summit image / 設定を既存の手動経路で maintenance 配備 | 実接続・identity・専用 readiness・新 schema 契約を確認。通常受付・配送は閉じたまま |
| 7 CONSUMERS_STAGED | DB・Summit の証拠を添えた momo-result dispatch の `production` を承認。同じ deploy 内で API / Web → worker を maintenance 配備 | mutation 前に証拠と停止を再照合。各 image / 設定 / DB 接続・reader / worker 契約を確認。API と worker の間に新たな人手承認は加えない |
| 8 READY_TO_RESUME | 必要な許可済み保守再計算・promotion / backfill を実行し、全 consumer・current / previous・通知基準・旧 URL・認可を確認 | 元入力・利用者要求を保全し、通知抑止と許可差分を確認。残る通常 writer は閉じる |
| 9 REOPENING | **最初の通常書込み・外部送信より前に**再開境界を永続記録し、受付・処理・配送を監視しながら開く | この時点から forward fix を基本とする。部分再開や結果不明でも停止前 backup へ安易に戻さない |
| 10 RESUMED / 完了 | 既存キュー、lease、分析公開、通知、旧リンク、異常率を確認。再開・安定証拠で publish 専用入口を起動 | GitHub Release はここで発行。実 SHA / run / attempt / 証拠 / 残存互換経路を記録し、保持期間後に一時資源を整理 |

DB 失敗時は Summit / app へ進まず、Summit 失敗時は app を承認しない。API 成功・worker 失敗等は実際の混在状態を記録して停止を維持する。保守 campaign の timeout は失敗・完了・rollback の証拠にせず、同じ operation を確認・継続する。

本番での通常書込み smoke はローカル copy の試験で代替し、本番は maintenance の読取り・契約確認と明示した保守書込みに限定する。追加の本番 smoke が必要なら、変更対象・通知抑止・復旧時の破棄可否を事前定義する。利用者の新規書込みや外部送信を許す場合は先に REOPENING へ進める。

Summit の migration 禁止窓（金曜 17:30〜土曜 01:00 JST）を避け、復旧余裕もその外に収める。PITR を使う定常 backup と今回の移行用 dump の位置付けを運用文書に明記する。残り時間が不足したら次の変更へ進まず、復旧または延期する。

## 9. 中止・復旧・再実行

| 状態 | 対応 |
| --- | --- |
| SQL 適用前の不一致 | 適用しない。元 DB と準備 release で安全に再開するか、停止を維持して修正。再開したら final backup / 証拠は失効 |
| migration の失敗・切断・結果不明 | 停止を維持し、transaction・schema・ledger・run を読み取り確認。baseline / target / 未知を区別し、target なら verify-only。盲目的な再適用をしない |
| 適用後、REOPENING 前の失敗 | 検証済みの別復旧 DB と旧 consumer の組合せへ戻す。保守生成データ以外の新規業務入力がないことを確認 |
| REOPENING 以降、または通常書込み・外部送信の有無が不明 | 新規入力・配送記録を守る forward fix を基本とする。移行前 backup への上書きで失わない |

復旧は restore 成功だけでは完了しない。元 DB の書込みを閉じたまま全 pool を終了し、API、worker、Summit、momo-db CI の `DIRECT_URL` を同じ復旧先へ揃える。各アプリの実接続と migration 接続から DB identity・期待 ledger を確認し、maintenance readiness と保全比較を通してから再開する。設定更新が一部失敗した場合は閉じたまま修復する。

provider の restore / branch・role・extension・secret 更新の具体的手順と実行権限は、最終リハーサル前に runbook で確定する。旧 endpoint を使う writer を残さず、制御記録は DB 復元で巻き戻さない。復旧後の新しい接続先・候補は別の証拠で管理し、復旧前の成功 run を再利用しない。

本番復旧・緊急直接適用は [正規 recovery 手順](../development.md#7-rollback--recovery) と実環境 runbook に従う。ローカル CLI に本番 restore の汎用機能を持たせず、通常 rollback で旧 binary だけを戻したり、ledger だけを削除したりしない。

## 10. 調査根拠・残る実環境確認・完了条件

調査 checkout は momo-db `49114b68795d53baa66339a980819a29e5103f27`、Summit `d90ba5093ff277ea7a4723ec8c3f51cd744940ed`、momo-result `9601a4d7140ca0fb0b4e763c3debe9370508b338`。momo-db の最新ファイルは `0072`。これは本番 ledger / 稼働 version の証明ではない。consumer の `.momo-db-ref` / `.summit-ref` / CI `MOMO_DB_REF` は現 checkout 間で一致しておらず、候補作成時に整合させる。

現行経路と今回必要な差分は次のとおり。

- [momo-db CI](../../.github/workflows/ci.yml) は master push → Build & Check → `production-db` 承認 job → `CI Actions` の Migrate Neon。dispatch と最終証拠の受渡しは未実装。
- [momo-result deploy](https://github.com/ponta2git/momo-result/blob/9601a4d7140ca0fb0b4e763c3debe9370508b338/.github/workflows/deploy.yml) は release PR merge → quality / image / system E2E → `production` の単一 deploy。既存 cutover は承認後に API / worker を止めて DB を待つため、今回の独立した全 writer 停止を代替しない。現状の worker 通常起動と自動分析保守も maintenance 対応が必要。
- [Summit CI](https://github.com/ponta2git/summit/blob/d90ba5093ff277ea7a4723ec8c3f51cd744940ed/.github/workflows/ci.yml) は検査を行うが本番 CD はない。固定 image の保持・手動配備を準備し、CD 新設は必須にしない。[startup](https://github.com/ponta2git/summit/blob/d90ba5093ff277ea7a4723ec8c3f51cd744940ed/src/index.ts) の member 同期・接続・reconcile は scheduler より前から停止対象になる。
- [通知設定更新](https://github.com/ponta2git/summit/blob/d90ba5093ff277ea7a4723ec8c3f51cd744940ed/src/db/repositories/resultNotifications.state.ts) は OFF 時の取消・generation 更新を含む。[通知判定](https://github.com/ponta2git/summit/blob/d90ba5093ff277ea7a4723ec8c3f51cd744940ed/src/domain/notification.ts) は旧 generation を拒否する。
- momo-result の [job materialization](https://github.com/ponta2git/momo-result/blob/9601a4d7140ca0fb0b4e763c3debe9370508b338/apps/processing-worker/src/series_analysis/materialization.rs)、[要求の終端化](https://github.com/ponta2git/momo-result/blob/9601a4d7140ca0fb0b4e763c3debe9370508b338/apps/processing-worker/src/series_analysis/control/transaction.rs)、[publication](https://github.com/ponta2git/momo-result/blob/9601a4d7140ca0fb0b4e763c3debe9370508b338/apps/processing-worker/src/series_analysis/control/publication.rs) は保守 job の合流と通知基準更新に関係する。[radar_prepare](https://github.com/ponta2git/momo-result/blob/9601a4d7140ca0fb0b4e763c3debe9370508b338/apps/processing-worker/src/series_analysis/radar_prepare.rs) は旧 payload の identity / checksum を検証し、[statistics](https://github.com/ponta2git/momo-result/blob/9601a4d7140ca0fb0b4e763c3debe9370508b338/apps/processing-worker/crates/analysis-core/src/compute/review/statistics.rs) は ID を seed に使う。
- Web の [principalClientState](https://github.com/ponta2git/momo-result/blob/9601a4d7140ca0fb0b4e763c3debe9370508b338/apps/web/src/shared/auth/principalClientState.ts) と [保存下書き](https://github.com/ponta2git/momo-result/blob/9601a4d7140ca0fb0b4e763c3debe9370508b338/apps/web/src/features/matches/workspace/matchWorkspaceSessionDraft.ts) は principal 変更時の状態消去・旧 ID を含む保存状態を持つ。[OCR 受付](https://github.com/ponta2git/momo-result/blob/9601a4d7140ca0fb0b4e763c3debe9370508b338/apps/api/src/main/scala/momo/api/usecases/ocr/OcrSubmissions.scala) と [期限回収](https://github.com/ponta2git/momo-result/blob/9601a4d7140ca0fb0b4e763c3debe9370508b338/apps/processing-worker/src/ocr/submissions/control.rs) は元 admission deadline と期限切れを扱う。
- [runtime-release](https://github.com/ponta2git/momo-result/blob/9601a4d7140ca0fb0b4e763c3debe9370508b338/.github/workflows/runtime-release.yml) の既存契機は deploy 完了であり、移行後の publish 専用入口が必要。分析保守の既定待機 1800 秒を停止枠や処理完了の保証として扱わない。

GitHub の required reviewers、branch 制限、bypass、`CI Actions` の追加保護は live 設定を確認していない。YAML の environment 名だけでは承認待ちを保証できないため、P0 の実環境 gate とする。[deployment protection](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)

ほかに本番の接続先・ledger・データ量・値の分布、停止対象の実数、control record の保存・権限、provider 復旧権限、private runbook を実行前に確定する。これらは準備工程の成果物であり、未確認のまま「当日判断」に持ち越さない。

各 P の完了は実装・対象 gate の成功と証拠の記録で判定する。計画全体の完了は必要な本番移行・全 consumer 切替・再開確認まで含める。ローカル試験、PR merge、DB 適用のいずれかだけで全体を完了扱いにしない。PR merge をもってチケットを Done にできる範囲は `Fixes <issue ID>`、本番受入等が残る範囲は `Refs <issue ID>` を使う。
