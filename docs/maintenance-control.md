# 移行の停止状態と承認証拠

`pnpm maintenance:control` は、移行の停止世代・固定候補・実行許可を GitHub の専用 Git ref に保存する。対象 DB の restore や CLI 終了で状態を失わず、期限切れを通常運用の再開とは扱わない。これは deploy の入口と証拠を照合する制御であり、API・worker・Summit の drain や永続起動設定を代行するものではない。

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
