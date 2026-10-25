# `0073`–`0095` 本番停止切替の完了記録

本番移行、全 consumer の切替・通常再開、通常 CD の再開は完了した。終了済みの切替 CLI・証拠 producer・リハーサル入口と操作手順は撤去した。通常 migration の guard と、保存値・schema の移行回帰試験は維持する。

当時の設計・実行計画、script、検証手順は[整理前の固定 commit](https://github.com/ponta2git/momo-db/tree/7ddfe784eb5c74d934f3088d00e17b822fc70ca0)から参照できる。保存した backup・暗号化証拠・鍵の保持は別に管理する。現在の適用・復旧は [development.md](../development.md#6-適用と-release-順序) に従い、過去の固定候補や操作手順を再利用しない。

## 工程4：完了記録（2026-10-23）

本番 migration と保存対象の比較、対応する全 consumer の切替・通常再開を完了した。通常 CD の再開と、終了済みの切替専用入口の整理も以下の範囲で完了している。事前リハーサル、本番での観測、整理 PR の CI はそれぞれの対象・時点の証拠として扱う。

| 項目 | 結果・参照 |
| --- | --- |
| 本番 DB | `0073`–`0095` を適用し、全 migration 履歴と移行後の保存値比較が成功。[適用・比較 run](https://github.com/ponta2git/momo-db/actions/runs/39779714834) attempt 1。詳細な比較結果と復元資材は非公開記録に保持 |
| consumer | 固定した対応版へ切り替え、全 consumer の readiness、Runtime の公開応答、再開後の代表読取りを確認。実際の image・設定・run / attempt は非公開の実行記録に固定 |
| 通常 CD | [Summit #28](https://github.com/ponta2git/summit/pull/28)、[momo-result #114](https://github.com/ponta2git/momo-result/pull/114)・[#115](https://github.com/ponta2git/momo-result/pull/115) を反映。通常の承認・排他を維持して再開 |
| 切替専用入口 | [momo-db #32](https://github.com/ponta2git/momo-db/pull/32) と [Summit #29](https://github.com/ponta2git/summit/pull/29) は master、[momo-result #116](https://github.com/ponta2git/momo-result/pull/116) は develop へ反映。専用 workflow と公開専用 job を撤去 |
| 整理差分の検証 | 各 PR の必須 CI と momo-result の System E2E が成功。momo-db / Summit の master CI も成功。整理作業による本番 SQL・再配備は実施していない |

### 確認の範囲と後続への引継ぎ

- 本番再開後の実 OAuth 操作と、専用の Summit 通知業務 probe は未実施。事前の業務検証、CI の E2E、readiness や代表読取りを、その本番確認の代替として成功扱いにしない。
- momo-result #116 の master への反映は次回 release に残る。develop への統合を、本番 release 済みと扱わない。
- この完了記録の時点では通常運用の保護、保守起動、比較・復元用 script と tests は保持した。切替専用 credential / 権限の撤去は未実施であり、「全一時資材を撤去済み」とはしない。撤去には現在の依存先と保持要件の確認が必要である。
- backup、暗号化証拠、固定 image の識別情報と当時の実行入力を保持する。過去の有効期限・未実施判定は書き換えない。新規書込みを再開した後の復旧は新規データを保全する forward fix を原則とし、切替前の DB や image を単独で戻さない。

この完了記録の整理では本番への再接続・再試験・配備を追加していない。個別機能の本番受入が未確認の場合は、その機能のチケットで残りを追跡する。

関連チケットの記録も整理した。[MOM-34](https://linear.app/ponta/issue/MOM-34)（仕様）と [MOM-35](https://linear.app/ponta/issue/MOM-35)（DB 保存・移行）は Done。[MOM-33](https://linear.app/ponta/issue/MOM-33) はロール別の本番利用確認を残すため In Progress を維持する。
