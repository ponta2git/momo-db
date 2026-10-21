# 本番コピーのローカル移行リハーサル

`pnpm migration:rehearsal` は、本番を読み取り、暗号化した整合 snapshot を所有確認付きのローカル PostgreSQL 18 へ復元する。所有確認済みのローカル copy では固定 commit の正規 `pnpm exec drizzle-kit migrate` を使う。本番の通常 CI 入口とは分け、破壊的 tail を通常 CI から適用できない guard を維持する。本番への migration / restore / maintenance 切替はこの入口に実装していない。

**この CLI の `rehearse` / `recover-rehearsal` が合格しても、切替リハーサルは完了しない。** 現行実装は DB の復元・移行・保存値比較と旧 DB の復元までを扱う。実 consumer image の起動・接続切替・業務操作、停止の継続、外部送信の遮断、本番適用は別の gate である。今回の `0073`–`0095` 切替で不足する実行入口と宣言条件は[現行の実行計画](plans/2026-10-20-production-cutover-execution.md#工程2メンテナンス宣言前の実装と合格条件)に記す。未実施の gate を `status.checks` の DB 成功で代替しない。

## 準備

Node 24、repository 固定 pnpm、Docker 28 以降、取得済みの PostgreSQL 18 image を使う。image 内に OpenBSD / BusyBox の `nc` と system CA bundle が必要で、`prepare` が検査する。OpenBSD 版には `-N` を付け、migrator の終了時にも stdin EOF を PostgreSQL 側の接続終了へ伝える。未知の `nc` 実装は受け入れない。作業 tree は未追跡ファイルを含め clean にし、候補を commit する。CLI は SHA・lockfile・migration 履歴の digest を固定し、以降に変更があれば停止する。3 repo の対応する image・設定も別途固定し、CLI の DB 候補 SHA だけを一式の同一性証明としない。

source と locale metadata が一致する image を選ぶ。Alpine は `C.UTF-8` の LC_COLLATE を `C` として初期化する場合があり、その差は許容しない。Debian 版が必要なら、データや接続設定を含まない stdin Dockerfile から中継用 `nc` と system CA bundle を追加する。作成後の image ID は `prepare` が固定する。

```sh
docker build --tag momo-db-rehearsal:18 - < scripts/migration/postgres.Dockerfile
```

この場合、後述の `--postgres-image` は `momo-db-rehearsal:18` を指定する。

実 DB の major version・locale、dump / restore の所要時間、必要容量は事前に読み取り・実行して確認する。ローカル container は PGDATA 2 GiB・memory 3 GiB 固定で、baseline / migration / reference / smoke / recovery の複数 DB と WAL・一時領域が同じ上限を使う。`pg_database_size` だけでは収まる保証にならない。実コピーで上限や棚卸し・dump の statement timeout（各 statement は 5 分、dump 全体は 20 分）に当たれば、容量・時間の設計を変更して**新しい候補で最初から通す**。停止中に上限を緩めて初成功を狙わない。

source は明示した direct 接続だけを使い、`.env.local` を自動読込みしない。接続 URL を shell 引数・履歴へ書かず、承認済みの secret 注入で `MOMO_REHEARSAL_SOURCE_URL` に渡す。以下は環境変数の値を表示せず、repository 外の private directory に鍵と接続設定を作る例である。

`migration:source-preflight` は承認済み `MOMO_REHEARSAL_PROJECT_ID` / `MOMO_REHEARSAL_BRANCH_ID` / `MOMO_REHEARSAL_ENDPOINT_ID` / `MOMO_DB_EXPECTED_DIRECT_HOST` と `neondb` を照合する。Neon endpoint は `NEON_API_KEY` による GET、未指定なら認証済み Neon CLI の GET で DB 観測前後に再照合する。実接続の DB・read-only・primary・厳密な `0000`–`0072` 履歴も確認する。`prepare` と `snapshot` / `inspect` も同じ承認情報を要求し、旧形式の URL だけの設定は拒否する。

```sh
install -d -m 700 /private/tmp/momo-rehearsal-secrets
node --input-type=module <<'JS'
import { createKey } from './scripts/migration/files.mjs';
await createKey('/private/tmp/momo-rehearsal-secrets/source.key');
JS
# 上記の承認済み識別子と MOMO_REHEARSAL_SOURCE_URL を安全に環境へ注入してから実行する。
pnpm migration:source-preflight \
  --key-file /private/tmp/momo-rehearsal-secrets/source.key \
  --output /private/tmp/momo-rehearsal-secrets/source.json.enc
```

鍵は 0600、directory は 0700 とする。共有・commit しない。接続設定、manifest、棚卸し、dump は AES-256-GCM で暗号化する。鍵と暗号化ファイルの両方を紛失すると復元できないため、必要な保持期間は管理された private storage に保管する。CLI の `cleanup` はこれらを消さない。

SQL 棚卸しは検証付き TLS と必要な SCRAM channel binding を使う。dump は同じ接続設定を libpq に安全に注入する。`channel_binding=require` の fallback、未知の URL parameter、pooler URL は拒否する。URL parameter は `sslmode` / `channel_binding` のみ許可する。

## DB 部分の実行

`prepare` は存在しない run directory を指定する。今回の tail は **`--profile canonical-identities-retired-slots-v1` を必ず指定**する。省略時の `preserve-v1` は pending migration を拒否する。source の取得中は別 migration / DDL を禁止する。以後は同じ鍵・manifest を明示する。以下は DB 部分のコマンドであり、consumer gate は後述の別作業である。

```sh
pnpm migration:rehearsal prepare \
  --run-dir /private/tmp/momo-rehearsal-run \
  --key-file /private/tmp/momo-rehearsal-secrets/source.key \
  --source-config /private/tmp/momo-rehearsal-secrets/source.json.enc \
  --postgres-image momo-db-rehearsal:18 \
  --profile canonical-identities-retired-slots-v1

pnpm migration:rehearsal snapshot --manifest /private/tmp/momo-rehearsal-run/manifest.json.enc --key-file /private/tmp/momo-rehearsal-secrets/source.key
pnpm migration:rehearsal restore --manifest /private/tmp/momo-rehearsal-run/manifest.json.enc --key-file /private/tmp/momo-rehearsal-secrets/source.key
pnpm migration:rehearsal rehearse --manifest /private/tmp/momo-rehearsal-run/manifest.json.enc --key-file /private/tmp/momo-rehearsal-secrets/source.key
pnpm migration:rehearsal recover-rehearsal --manifest /private/tmp/momo-rehearsal-run/manifest.json.enc --key-file /private/tmp/momo-rehearsal-secrets/source.key
pnpm migration:rehearsal status --manifest /private/tmp/momo-rehearsal-run/manifest.json.enc --key-file /private/tmp/momo-rehearsal-secrets/source.key
```

`status` で少なくとも `sourceSnapshot`、`restore`、`freshReference`、`migratorFirstRun`、`migratorNoop`、`migrationSchema`、`savedRows`、`canonicalIdentityProjection`、`workerSlotRetirement`、`databaseRecovery` が真であることと、`incomplete` を確認する。`incomplete` は DB コマンドだけでは解消しない。途中失敗後の既存 migration copy は再適用せず、`verify` で読み取り分類する。二回目の migrator 実行証拠を失った場合は fresh run とする。`inspect` は dump を作らず source の棚卸しを保存する任意の入口。未知の ledger、row-level security による不可視行、schema / 保存値差分は成功扱いにしない。dump と移行前監査は同じ exported snapshot を使い、source 接続は読取り専用とする。source 上で migration や修復は行わない。

業務 gate と証拠の保全が終わるまで `cleanup` しない。`cleanup` は所有確認した一時 DB / network を消すが、暗号化 archive・manifest・鍵は消さない。保持・削除の担当と期限を別に決める。

```sh
pnpm migration:rehearsal cleanup --manifest /private/tmp/momo-rehearsal-run/manifest.json.enc --key-file /private/tmp/momo-rehearsal-secrets/source.key
```

候補を更新した初期リハーサルでは、取得済みの整合 snapshot を再利用できる。新しい run directory と候補 commit を使い、`--source-config` の代わりに `--snapshot-manifest <previous-run>/manifest.json.enc` を `prepare` に渡す。同じ鍵で元 manifest / 監査を認証し、archive digest と新候補への ledger prefix を検証して暗号化 copy を作る。この経路は source DB や接続設定を開かない。以降は `snapshot` を省いて `restore` から実行する。旧 run の consumer・migration・復旧結果は引き継がず、取得時刻も更新しない。稼働中に取得した古い snapshot を、停止直後の最終 backup として使うことはできない。

公開番号の追加 `0073`〜`0077` には、`prepare` 時に `--profile public-identifiers-v1` を明示する。旧 ledger が `0072` までの完全な prefix、候補が固定した五つの tail と一致することを検査する。専用の空 DB に正規 migrator で旧 prefix と候補を順に適用して比較用 schema を作り、復元 copy にも同じ候補を適用する。元 SQL / metadata は変更しない。参考 DB の作成中に終了して証拠が揃わなかった場合は、既存 DB を再利用せず fresh run を要求する。

この profile で許容する保存値の差分は、`held_events.public_id` と `matches.public_id` の追加だけである。旧 ID の UTF-8 byte 順から求めた連番、最大番号の次を返す identity sequence、既存 ledger 行の不変性と正確な五行の追加を検査する。ほかの列・全 table・schema・既存 sequence は比較対象から除外しない。追加の tail は別 profile が必要になる。

UUID への停止切替 `0073`〜`0093` には `--profile canonical-identities-v1` を指定する。旧 ledger は同じ `0072` prefix とし、公開番号・fencing counter・layout 正規化・明示的な analysis transition・canonical identity の固定 tail と[列契約](contracts/canonical-identities-v1.json)の digest を検査する。public profile と同じ方法で、空の reference DB に正規 migrator から移行前後の完全な schema を作る。`worker_execution_slots` はこの候補では保持する。slot の削除や追加の tail をこの profile で許可しない。

canonical profile は全 source / target column に検証方法を割り当て、未対応列・余分な列・欠落した legacy 列を拒否する。旧列は明示的な SELECT projection で再構成する。ID は保存した legacy 列または FK 先の exact legacy alias を使い、JSONB の数値・bytea・時刻は PostgreSQL 内で hash にする。109 個の変換列と anchor の UUID は別に JavaScript の typed mapping と照合し、47 個の legacy 列、NULL の組、参照、凍結 source の全行を検証する。比較対象から列を単に削除する方法は使わない。

layout の三列だけは、基準 audit と同じ read-only snapshot で既知 alias の正規化結果を hash にし、移行後と比較する。この証拠は baseline と profile の digest に結び付けて `canonical-source.json.enc` に保存する。anchor は元の凍結 source との旧 ID / title の全行対応と二つの UUID を確認する。旧 HTTP replay は rename 後の全列・全 bytes が同一、新しい UUID replay table は空であることを確認する。公開番号の byte 順、sequence の次値、counter の `max(0, global slot, active lease, attempts)`、元 ledger 行と正確な追加行もそれぞれ検証する。保存済み notification、artifact、radar payload は値を書き換えずに比較する。

slot の廃止まで含む `0073`〜`0095` には `--profile canonical-identities-retired-slots-v1` を指定する。この別 profile は `0094` / `0095` の名前・時刻・hash を追加で固定し、元の `worker_execution_slots` 全列を廃止対象として記録する。基準 audit と同じ snapshot で slot 全行の fingerprint と job ごとの期待 fence を保存し、移行後の table 不在、残る 107 個の変換列・45 個の legacy 列、その他すべての保存値・schema・ledger・sequence を確認する。slot を黙って比較から外すことはない。元 slot の値は暗号化 archive と証拠に残し、archive からの recovery で再確認する。既存の `canonical-identities-v1` はこの追加 tail を拒否する。

実データ copy で見つかった migration 管理外の `public.show_db_tree()` は、catalog を読み取る診断関数として定義を確認し、identity と全構造 digest を固定して保全する。存在する場合は移行前後の期待 schema に同じ関数を含めるため、削除・定義変更も不一致になる。それ以外の未知の追加関数や、管理対象 schema の差は許容しない。既存 DB の変更や関数の作り直しは行わない。

ローカル PostgreSQL は run 固有 label、固定 image ID、internal / isolated network、tmpfs のみを使い、port を公開しない。各 command の間だけ host の 127.0.0.1 へ一時 TCP relay を開き、所有確認した container 内の `nc` へ接続する。relay の socket・子 process は終了時に回収し、port は manifest へ保存しない。restore と cleanup は実体を毎回再確認する。任意 DB URL、保存対象 `summit-postgres`、named volume、bind mount は対象にできない。上限は container memory 3 GiB / PGDATA 2 GiB なので、複数 copy が収まらない場合は容量設計を改訂して候補を作り直す。

実行中は private run lock を保持する。異常終了した lock は TTL で自動解除しない。残存 process と所有資源を確認してから管理者が解除する。migration 結果が不明なときは ledger を読み取り確認し、盲目的に再適用しない。

## アプリケーション権限の再現と接続 gate

consumer の業務 gate 前に、実行中の API / worker / Summit 全 instance の DB login role と boot を確認し、接続先の source schema / ledger とともに権限を監査する。接続 URL 全体は採取せず、process 内で role 名だけを取り出す。instance の設定・boot が監査前後で一致しなければ取り直す。`captureApplicationRoleAudit` はその観測一覧を受け取り、read-only transaction 内で schema、ledger、role 属性・membership、DB / schema / table / column / sequence / function の実効権限を収集する。返した監査は同じ run の鍵で暗号化した `source-role-audit.json.enc` として private に保存する。通常の dump だけではこの観測の代わりにならない。`capture-role-audit.mjs` が暗号化済みの3観測、source 設定、source 棚卸しを受け取り、鮮度・image・boot・接続先・ledger を検査して監査を保存する。新 image の自己報告は5分以内とする。旧 image は30分以内の同一 instance/config、実プロセスの設定と DB socket、ログを関連付け、helper を本人の自己報告と扱わない。PgBouncer の共有 backend はアプリ別に一意帰属できないことを記録する。失敗・期限切れ・instance変更時は観測から取り直す。default privilege も監査に含める。

primary 接続用 mapper は、全 consumer の主接続と migration が同じ非 superuser の application owner を使い、`public` / `drizzle` の全 table、sequence、function を所有する契約を対象とする。source の schema / ledger digest、全 object と column の権限を照合し、RLS、SECURITY DEFINER、複数 role、部分権限、未知の schema / type、role 設定があれば停止する。その場合は対象に合う mapping を別途レビューする。

```sh
node scripts/migration/capture-role-audit.mjs \
  --key-file /private/tmp/momo-rehearsal-secrets/source.key \
  --source-config /private/tmp/momo-rehearsal-secrets/source.json.enc \
  --source-report /private/tmp/momo-rehearsal-run/source.json.enc \
  --consumer-reports /private/tmp/momo-rehearsal-secrets/consumer-observations.json.enc \
  --output /private/tmp/momo-rehearsal-secrets/source-role-audit.json.enc

pnpm migration:rehearsal application-role \
  --manifest /private/tmp/momo-rehearsal-run/manifest.json.enc \
  --key-file /private/tmp/momo-rehearsal-secrets/source.key \
  --role-audit /private/tmp/momo-rehearsal-secrets/source-role-audit.json.enc \
  --copy smoke

pnpm migration:rehearsal application-role \
  --manifest /private/tmp/momo-rehearsal-run/manifest.json.enc \
  --key-file /private/tmp/momo-rehearsal-secrets/source.key \
  --role-audit /private/tmp/momo-rehearsal-secrets/source-role-audit.json.enc \
  --copy recovery
```

`smoke` は検証済み migration copy から専用 DB を作り、`recovery` は検証済みの復旧 copy を使う。保存行と sequence を既存の検証証拠と照合してから、run 固有 role へ DB と object の owner を対応付ける。role 属性は監査値を再現し、`public` の owner は source と同じ `pg_database_owner` とする。実際の application login で実効権限・全保存値・sequence の不変性を読み戻し、暗号化した `application-role-<copy>.json.enc` に結果を残す。baseline / migration copy は対象にできない。

停止制御に結び付いた旧 `finalFreeze` manifest はこの CLI の対象外であり、`FINAL_REHEARSAL_RETIRED` で拒否する。汎用リハーサルには新しい run を使う。

この証拠は application DB 内の実効権限の再現を表す。provider の管理権限や cluster membership は元監査に記録し、ローカルで再現したとは扱わない。`applicationRoleMapping` が true でも業務処理は未実行なので、`application-role-behavior` は残す。consumer の読み書き、function / trigger、画像・通知先を含む別 gate の実行結果が必要である。

127.0.0.1 relay は各 DB command の終了時に閉じる。`consumer-runner.mjs` の `withMaintenanceConsumer` は所有する隔離 network 上に固定 image を置き、callback の間は同じ DB 接続先を使える。`consumer-probe.mjs` は暗号化 manifest・owner proof・config を照合し、実 process の DB identity・role・ledger・image・boot と、起動前後の全保存値・sequence の不変を検査する。保守 mode の起動だけを扱い、通常業務と旧 image の復旧 smoke は P4 の別 gate とする。SQL が通ったこと、DB が復元できたこと、または `applicationRoleMapping` だけで「consumer smoke」「旧 consumer による復旧」を合格にしない。

追加の Worker 読取・待受け接続は primary owner で代用しない。`application-reader.mjs` は別の role 監査を基に、read-only default、public 全 table の SELECT、drizzle 不可視、書込み不可、既存 sequence 権限なしと、owner が作る新規 public table への SELECT default privilege を限定的に検証する。`mapApplicationReader` は owner mapping 済みの所有 copy で実効権限を再現し、実 login の全 public table 読取り、`processing_jobs` / `ocr_submissions` の LISTEN、禁止操作の拒否、全保存値不変を確認する。group membership は実効 grant に集約し、SET ROLE や provider 管理権限を再現したとは扱わない。未知の role/default grant、RLS 等は拒否する。追加 sequence は、移行・schema 比較済みの smoke copy で `0076` の `held_events.public_id` / `matches.public_id` に所有される2本の identity sequence だけを許可し、監査済み owner default privilege に従って SELECT のみ再現する。既存 sequence には権限を追加せず、USAGE / UPDATE も許可しない。owner が今後作る public table / sequence の SELECT default privilege も設定する。smoke / recovery は別の reader role を持つ。この module の proof と専用 local role を、P4 の分析・待受け接続へ渡す。primary の保守 probe だけで追加接続を合格にしない。

## 証拠の範囲

初期 CLI の `checks` は DB のコピー・比較結果を表し、統合計画全体の完了ではない。必ず `incomplete` も確認する。

- 全 user schema の構造、全 table の保存行と件数、migration ledger を比較する。全行を PostgreSQL の JSON 文字列表現から SHA-256 にし、その固定長 digest を並べて table ごとの multiset を hash する。巨大な保存値そのものを sort / 転送せず、重複行と全値を含める。数値を JavaScript の number に変換しない。
- owner / ACL は完全な元棚卸しを private に保持するが、ローカル restore は owner を置換し ACL を省く。構造比較はこれらを除外するため、実アプリ role / SECURITY DEFINER の挙動は別の必須 gate とする。
- locale 名だけでなく provider・rules・記録済み / 実際の collation version を比較する。source の builtin / libc 設定で初期化し、復元前に一致を確認する。version drift、未対応の ICU 等は停止し、名前の正規化だけで同一とみなさない。
- constraint は元の定義を private inventory に保持し、比較には PostgreSQL 自身の deparser で不要な括弧を抑えた表現を使う。dump / restore に伴う同じ AND 条件の括弧差だけで失敗させず、AND / OR の優先順位や条件変更は検出する。この比較表現を復元用 SQL としては使わない。
- 稼働中の snapshot では sequence は MVCC に従わない。sequence の元 DB と同時点の保全や停止継続は証明しない。二つの復元 copy 間では identity sequence を含め一致を検査する。
- 停止直後の source sequence を復元 copy と直接照合する機能、および backup 後から本番 SQL 直前までの停止継続・全保存値の再照合はこの CLI にない。最終 backup と CI 適用を結ぶ別の guard と証拠が必要である。
- 既定の `preserve-v1` comparator は schema・アプリ保存値の変更を一切許容せず、pending tail がある場合は適用前に停止する。公開番号・canonical・slot retirement の各 profile の許容差分は、それぞれ上記の固定 tail と列別契約に限定する。候補を拡張する場合は期待 schema・列別 mapping と専用 comparator を更新し、その候補で再リハーサルする。
- 新規の移行 copy では正規 migrator を再実行し、二回目が schema・ledger・保存値・sequence を変えないことまで検証する。途中終了後の既存 copy は読取り比較で分類し、再適用しない。二回目実行の証拠が残っていなければ未確認として fresh run を求める。
- consumer の smoke、別 DB への実接続切替、画像本体、停止直後の最終 snapshot、本番承認・適用・再開は別の証拠が必要である。

停止後の時間短縮に使う「最終 backup を実際に復元して読み、成功済み rehearsal の復元 baseline と全保存値・schema・ledger・sequence・locale を、role / 接続先 / 設定は事前の source 監査・固定設定と比べる。一致すればその移行証拠を再利用し、保存行 / sequence だけが変われば最終 copy で移行を一回実行して全件比較する」という分岐は、**この CLI の現行 command では実行できない**。最終 source の sequence 照合、停止継続、実際の consumer / 復旧 image 接続、適用前 guard まで含む停止専用入口を実装・実コピーで検証するまでは、[現行計画](plans/2026-10-20-production-cutover-execution.md)の短い経路を利用可能なものとして扱わない。

今回の手順と宣言条件は[現行の実行計画](plans/2026-10-20-production-cutover-execution.md)、正規 migration の規範は[開発手順](development.md)に従う。[旧統合計画](plans/2026-10-17-db-refactor-and-migration-plan.md)は設計背景であり、撤去された停止制御や未実装の consumer gate を実行済みとみなさない。

## 全工程による最終証拠と読み取り専用分類

`cutover-final-evidence.yml` は、成功済み master CI と同一 SHA、固定した Summit / momo-result の ref、復旧余裕を入力にする。鍵は既存の `CUTOVER_EVIDENCE_KEY_BASE64`、source と provider の接続は `CI Actions` の Secret / Variable を使う。実行ログへ値を出さず、backup・source・比較 report・最終証拠を暗号化 artifact として保存する。鍵の private 保管と artifact の保持期間を別途確保する。

- `rehearsal` は本番を読み取り専用で snapshot し、その復元 copy を停止中 source に見立てる。別の模擬最終 backup を実際に取得し、さらに別 copy で restore / reference / migration / no-op / recovery を通す。実 copy の行・sequence の変更、模擬 writer の再起動で guard が閉じることと、baseline / target の読み取り分類を確認する。模擬 writer は実 consumer の業務証拠ではない。出力の `kind: cutover-rehearsal-evidence` は本番 SQL が拒否する。
- `production` は停止操作を行わず、承認済み `CUTOVER_WRITER_INVENTORY_JSON` の3 Machine が既に停止している場合だけ進む。restart / autostart / schedule、instance、設定とイベント履歴を固定し、全 client の drain、source の全保存値・schema・role・ledger・sequence・locale を読み取る。backup の後と全工程の後にも同じ基準と照合し、復元 baseline を停止中 source の sequence まで比較する。設定した復旧余裕を残せない場合、証拠を発行しない。

最終証拠は manifest の `checks` だけから作らない。archive と各暗号化 report の digest、正確な candidate / profile、canonical 全件比較、no-op と recovery を再検証し、適用後比較に必要な baseline / profile / 変換証拠も同じ暗号化証拠へ含める。producer run / attempt、取得・検証・失効時刻を結び付け、SQL 入口は成功した producer の同一 artifact と照合する。全工程の成功も P4 の実 consumer 業務・旧版復旧を代替しない。

`cutover-apply.yml` の `operation: apply` は従来の本番承認を通した後だけ正規 migrator を実行する。直後に読み取り専用の全件比較を行う。SQL が失敗した場合も再実行せず分類する。結果を取り直す場合は同 workflow の `operation: classify` を使う。この選択では SQL の承認 job と migrator を実行せず、停止中の実 DB を `baseline-unchanged`、`target-preserved`、`partial-or-unknown`、`comparison-failed` に分類する。失効済み証拠は読み取り分類だけに使え、SQL の再承認には新しい有効な証拠が必要である。

producer の成功した模擬 run と P4 の業務・復旧結果を同じ候補へ結び付けるまで、これらの入口の存在だけで本番の実行条件を満たしたとは扱わない。模擬最終 backup の取得時刻を、本番停止後の取得時刻へ付け替えない。

ローカルで同じ模擬経路を確認するときは `final-run.mjs --mode rehearsal` に `--snapshot-manifest` を渡し、既存 CLI と同じ認証済み snapshot の import を使える。この場合は source DB / credential を開かず、元の取得時刻を保持する。`production` mode はこの option を拒否し、必ず停止中 source から新しい backup を取得する。
