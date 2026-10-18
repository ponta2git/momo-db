# 移行の停止状態と承認証拠

`pnpm maintenance:control` は、移行の停止世代・固定候補・実行許可を GitHub の専用 Git ref に保存する。対象 DB の restore や CLI 終了で状態を失わず、期限切れを通常運用の再開とは扱わない。API・worker・Summit の段階的な drain と永続起動設定には、同じ記録を照合する `pnpm maintenance:freeze` を使う。

## 保存と権限

`ponta2git/momo-db` の `maintenance-control` branch / `control.json` を使う。記録は公開可能な SHA、digest、run / attempt、段階だけに制限し、接続先・token・保存データは含めない。更新は一人の operator が行う。親 commit を固定した新 commit を `force: false` で fast-forward するため、同時更新の一方は失敗する。古い head に対する失敗を新しい head で自動再試行しない。

導入時には、削除と force push の禁止、管理者への保護適用、更新主体の確認を行う。各 workflow は読取りだけにする。repository 管理者による設定変更や別 credential からの直接更新を、この client だけで防げるとはみなさない。使用する credential / 自動処理も停止対象の一覧に含める。

初期記録がない場合も通常 deploy は拒否する。初期化・保護設定と P0 の先行配備は、移行前に既存の承認経路で準備する。以下のコード追加だけでは、本番の保護設定や停止確認が完了したことにならない。

## 世代と段階

`stateVersion` は更新の競合確認、`stopEpoch` は停止の継続を表す。段階が進んでも停止世代を変えない。writer の再開、不明な配備、接続先変更等は `invalidate` で世代を進め、証拠と許可を失効させる。完了後も epoch を保持するため、同じ cutover 名が再使用されても過去の停止とは一致しない。

通常経路は `PREPARING → DRAINING → FROZEN → VERIFIED → DB_APPLIED → SUMMIT_STAGED → CONSUMERS_STAGED → READY_TO_RESUME → REOPENING → RESUMED`。各段階は対応する証拠 digest を必要とする。`PREPARING` から通常 deploy を閉じ、通常業務の停止は別途 drain で行う。

中止・旧構成への復旧には `recovery-ready → RECOVERY_READY → RECOVERY_REOPENING → RECOVERY_RESUMED → close-recovery` を使う。別 DB への接続切替、旧 consumer、旧 target の書込み禁止を確認した証拠が必要である。新構成へ配備したことを表す段階を偽装して復旧を完了しない。通常経路・復旧経路とも、最初の通常書込みや外部送信より前に REOPENING を記録する。それ以降は backup 上書きによる復旧へ戻さない。

## GitHub 承認との引継ぎ

- 通常 master push は固定候補の品質確認と artifact 作成を行う。`normal-status` は通常 mutation を進めてよいか返し、mutation 直前の `normal-guard` が再確認する。
- 移行は固定候補の `cutover/<id>` branch から dispatch する。既存 environment の許可 ref をその branch だけに絞り、承認者・待機条件は保持して管理者 bypass を閉じる。これにより、古い master workflow の再実行も現在の environment 境界で拒否する。既に承認済み・実行中の job や外部 credential は別途停止する。
- `bind-receipt <operation> input.json output.json` は actual workflow / SHA / run / attempt を付与し、停止状態と元 producer の成功 attempt・artifact ID / digest / 有効期限を照合する。その receipt を承認前に immutable artifact として保存する。
- operator は artifact の receipt digest、実際の run / attempt、期限を `permit` に登録する。`maintenance-guard <operation> receipt.json` は承認後の mutation 直前に同じ receipt と許可を再照合する。database / consumers / analysis / publish は各専用 workflow に固定され、別の操作の許可を流用できない。
- retry は新しい実行 receipt と許可を作り、既存の承認を受ける。producer の artifact は同じものを再利用できる。DB が既に target なら読取り検証だけを行い、未知の ledger は停止する。

`capture-approvals <file>` は変更前の承認条件を保存する。`verify-freeze <file> <output>` は exact branch、承認条件の維持、bypass、control ref 保護と更新主体を読取り検査する。既承認 job・外部 writer・旧 workflow の拒否実証はこの出力の `incomplete` に残り、別の確認なしに FROZEN の証拠へ使わない。

receipt の `evidence` は source identity、baseline / target ledger、pending tail、baseline / target schema、baseline / target 全保存値、snapshot、最終リハーサル、前段階を結ぶ。DB 側の digest はリハーサルの固定 comparator が生成する値をそのまま渡す。schema digest には locale provider / rules / version と構造比較を含め、data digest には全保存行と sequence を含める。receipt 自体の digest は key を並べた canonical JSON の SHA-256 とする。ローカルの秘密 manifest や dump を GitHub に渡さず、operator がその元証拠との対応を確認する。digest 単独が証拠の真偽を証明するものではない。

Release 発行は RESUMED の証拠を使う専用継続入口で行う。`close` は公開結果の digest を完了記録へ保存してから通常 deploy を開く。復旧経路は `close-recovery` で旧構成の安定確認を保存する。過去の各状態は Git 履歴に残る。

## 実接続と復旧先の照合

各 consumer の frozen probe は `database: { formatVersion: 1, targetFingerprint, ledgerFingerprint }` を返す。実接続の `current_database()` と、同じ read-only transaction 内の `drizzle.__drizzle_migrations ORDER BY id` 全行を使う。空・不正・不可視な ledger は失敗とする。接続設定のファイルを差し替えただけでは復旧完了とせず、API・worker・Summit・migration 接続の全てを期待する証拠と照合する。

v1 の target は、`["momo-database-target-v1", host, port, actualDatabase]` の compact JSON / UTF-8 を SHA-256 にする。host は lowercase、`.neon.tech` 配下だけ先頭 label の末尾 `-pooler` を除き、port は既定 `5432` の十進文字列とする。ledger は `momo-drizzle-ledger-v1\n` に各行の lowercase SHA-256、`:`、timestamp の十進文字列、`\n` を順に連結して hash する。role / password / 設定 URL の database path は含めない。これは設定先と実接続した DB の照合であり、role 権限や全保存値の一致は別 gate のままである。

全体の実行順・停止枠・復旧条件は[統合計画](plans/2026-10-17-db-refactor-and-migration-plan.md)を参照する。

## 全 writer の停止

`maintenance:freeze` は、旧 schema に対応した準備 release が全 consumer に配備され、認証付き process drain と実接続・ledger の frozen probe が使えることを前提とする。本番で実行する前に、通常の承認経路による準備 release、運用案内、停止枠、復旧 image / 設定、外部 writer の停止を確定する。ローカルのテスト成功だけではこの前提を満たさない。

### 非公開入力

接続 URL は所有者だけが読める別ファイルから読み、argument や標準出力に含めない。key は 32-byte の mode `0600` ファイル、実行 directory は repository 外の mode `0700` とする。計画、machine の全設定・boot identity、secret の名前・digest、途中状態と最終証拠は AES-GCM で保存する。GitHub に保存するのは証拠全体の digest だけである。

`prepare` の JSON 入力は次の field を持つ。実値を含む入力・証拠は公開 repository / PR に置かない。

| field | 内容 |
| --- | --- |
| `formatVersion` | `1` |
| `targets` | 全 machine の `{role, app, id, image, configDigest}`。role は `api` / `worker` / `summit`、image は `registry/repository@sha256:…`、configDigest は `control.mjs` の canonical JSON digest |
| `database` | 準備 release が使う旧 schema の migration 接続 proof。全 consumer が同じ target / ledger を使う |
| `approvals` | `maintenance:control capture-approvals` の保存結果 |
| `deadline` / `recoveryReserveMs` | UTC の終了期限と、最後まで消費しない正の復旧余裕。各 mutation はさらに 120 秒の実行余裕を必要とする |
| `externalEvidence` | 下記の operator 証拠 |

`externalEvidence` は `formatVersion: 1`、`operator`、`cutoverId`、`stopEpoch`、固定 `candidates`、`deploymentFreezeDigest`、`observedAt`、`validUntil`、`checks` を持つ。`deploymentFreezeDigest` は現在の `verify-freeze` の出力 digest と一致させる。`checks` は [全 writer の必須区分](../scripts/maintenance/freeze-contract.mjs)ごとの `{kind, evidenceDigest}` を一つずつ含め、元の確認記録を非公開で保持する。

GitHub の migration / deploy / rollback / analysis / publish、既承認 job、旧 workflow の拒否実証、Summit の手動配備・CLI・seed、手動 SQL / provider console、臨時 script / 別 machine、外部 credential を対象とする。特に **environment 保護がなかった旧 publisher** の rerun も含める。停止していない入口を、現行 YAML に guard があることや `success: true` だけで確認済みにしない。operator 証拠はその確認を参照するもので、digest 自体が実環境の停止を証明するわけではない。

`maintenance:control` で候補を固定し、現在の GitHub barrier digest を付けて `DRAINING` へ進めてから入力を作る。`prepare` は source DB / provider / process の読取り検査だけを行う。対象 app に一覧外の machine がある、既に drain されている、他の secret が staged / partial / unknown、app secret を無視する起動設定である場合は停止する。DB 検査用 role には全対象 table の SELECT と全 session の可視性（`pg_read_all_stats` 相当）が必要で、RLS による絞込みを許可しない。

```bash
pnpm maintenance:freeze create-key /private/path/freeze.key
pnpm maintenance:freeze prepare --input /private/path/input.json \
  --source-url-file /private/path/direct-url --run /private/path/freeze-run \
  --key /private/path/freeze.key
pnpm maintenance:freeze status --run /private/path/freeze-run --key /private/path/freeze.key
```

### 停止順序と失敗時

本番停止への承認が揃った同じ計画に対して `stop` を実行する。

```bash
pnpm maintenance:freeze stop --run /private/path/freeze-run --key /private/path/freeze.key
pnpm maintenance:freeze verify --run /private/path/freeze-run --key /private/path/freeze.key
```

1. 全 app の次回起動用 `MOMO_MAINTENANCE_MODE=frozen` を secret として stage する。既存 process を再起動せず、無関係な secret の変更も許可しない。
2. API と Summit の admission を閉じる。既存 OCR admission、分析の利用者要求・campaign、result 通知と送信中処理が通常経路で収束するのを待つ。業務期限の延長、通知設定変更、queue の取消しはしない。将来の attendance PENDING は保存できる。
3. worker の admission と子 process 回収を確認し、API / worker の全 writer、最後に Summit の通知受信・送信を drain する。DB の未完了処理、active transaction と prepared transaction が残れば進まない。
4. 全 machine を固定 image と元の全設定に `frozen` だけを追加した設定へ切り替える。lease と `current_version` で競合を拒否する。各 process の frozen readiness、migration 接続、全 ledger を照合する。
5. 非公開の最終証拠を書き終えた後、CAS で `FROZEN` と `writersStopped` digest を記録する。

[Fly の running machine 更新](https://docs.fly.io/machines/api/machines-resource#update-a-machine)は reboot を伴うため、全 drain より前の設定更新には使わない。[staged secret](https://docs.fly.io/apps/secrets)を先に保存する。アプリ内で同じ normal 環境を使って子を再起動する supervisor を準備 release に追加した場合、この停止契約も再検証する。

各 mutation は先に非公開 journal に記録し、provider / GitHub の読取り後、実行直前に停止世代を再確認する。失敗・timeout・設定変更・boot 変更では自動再開せず、確認可能なら停止世代を `INVALIDATED` にする。`verify` で停止継続を確認できない場合も証拠を失効させる。control store 自体が利用不能なら、それ以降の作業を許可しない。

CLI 強制終了、途中更新、結果不明の後は同じ run の `stop` を再実行できない。残る lock / journal、実 machine / secret / process / DB を照合し、必要な `invalidate` と新世代の証拠を揃える。停止を解除するには、[復旧または通常再開の境界](#世代と段階)を先に記録する。`stop` の失敗処理が normal secret を戻すことはない。

この証拠は停止完了の記録であり、最終 backup の代わりにはならない。停止後に取得した backup の復元・移行・比較・consumer smoke・別 DB への復旧を行い、同じ停止世代へ結び付けてから `VERIFIED` へ進める。

## 停止後の最終リハーサル

`maintenance:rehearsal` は、新規 run と停止後の dump だけを受け入れる。既存の online snapshot を最終 backup として再利用できない。freeze run と同じ鍵を使い、全詳細を暗号化した private directory に保存する。

```bash
pnpm maintenance:rehearsal prepare --run /private/path/final-run \
  --freeze-run /private/path/freeze-run --key /private/path/freeze.key
pnpm maintenance:rehearsal snapshot --run /private/path/final-run --key /private/path/freeze.key
pnpm maintenance:rehearsal restore --run /private/path/final-run --key /private/path/freeze.key
pnpm maintenance:rehearsal rehearse --run /private/path/final-run --key /private/path/freeze.key
pnpm maintenance:rehearsal recover-rehearsal --run /private/path/final-run --key /private/path/freeze.key
```

`prepare` は停止対象の接続から source 設定を導出し、現在の clean commit を DB 候補と照合する。`--postgres-image` と、対応する比較器を実装した候補の `--profile` を指定できる。既定の保全比較器は pending migration を拒否する。未対応の変更を通すために比較を弱めない。

各段階とローカル mutation の前に、live GitHub 保護設定、外部 writer 証拠の期限、machine / boot / secret、consumer 接続、全 writer の収束を再照合する。source の exported read-only snapshot が開いている間だけ、その transaction を他の writer と誤認しないよう完全検査を前後へ置く。dump と同一 snapshot の全保存値、取得前後の sequence を比較し、最終 seal 時にも現在の source 全体が一致することを確認する。

DB の復元・移行・全保存値 / schema / ledger 比較と正規 migrator の二回目 no-op、旧 backup からの recovery は CLI が検証する。アプリの実操作、実画像、制限 role、旧ブラウザ、次の更新や計算等は、同じ final run の smoke / recovery copy 上で別途実行する。operator は実際の private report と実行記録を確認し、次の暗号化 acceptance JSON を作る。hash だけで実行済みとは認定しない。

- `formatVersion: 1`、制御記録と同じ `operator`、この manifest の `runId` と `candidates`。
- この run の `snapshotDigest`（archive）、`migratedDigest`、`recoveredDigest`。
- UTC の `reviewedAt` / `validUntil` と、未完了項目がない `incomplete: []`。
- [必須受入区分](../scripts/maintenance/final-rehearsal.mjs)ごとに一件の `checks`。各項目は `kind`、`outcome: "passed"`、実レポートの `reportDigest`、実行記録の `executionDigest`、`durationMs`、`completedAt` を持つ。最終 snapshot より前の結果、skip、未完了、重複、欠落は拒否する。変更のない通常 quality suite の証拠は参照できるが、最終コピー自体での必須確認は省略できない。

```bash
pnpm maintenance:rehearsal seal --run /private/path/final-run --key /private/path/freeze.key \
  --acceptance /private/path/final-acceptance.json.enc
pnpm maintenance:rehearsal status --run /private/path/final-run --key /private/path/freeze.key
```

`seal` は authenticated report・archive・全比較・停止継続・時間余裕を確認し、private proof を保存してからその digest を `VERIFIED` へ CAS 登録する。途中終了や CAS の結果不明では proof を保持し、自動再実行しない。control と proof を照合して実際の段階を確定する。通常の `migration:rehearsal` へこの run を渡して停止確認を省略することはできない。

receipt の入力は、この proof から生成する。

```bash
pnpm maintenance:rehearsal receipt --run /private/path/final-run --key /private/path/freeze.key \
  --input /private/path/producer-input.json --output /private/path/receipt-input.json
```

producer input は既存の receipt 契約の `operation`、`producer`、必要な操作の `scope` だけを指定する。source / baseline / target / snapshot / final proof / 前段階の digest は検証済み記録から導出し、execution tuple は含めない。CI の `bind-receipt` が実 run / attempt を付け、master producer と artifact の成功・同一性を確認する。生成だけでは mutation の許可を与えない。

`cleanup` は同じ run が所有するローカル資源だけを削除し、暗号化 backup と証拠は保持する。本番 restore、接続先変更、再開は行わない。
