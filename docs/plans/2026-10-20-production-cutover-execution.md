# `0073`–`0095` 本番停止切替の実行計画

更新日: 2026-10-20。対象: momo-db / momo-result / Summit。これは現行の準備・実行計画であり、[2026-10-17 の設計計画](./2026-10-17-db-refactor-and-migration-plan.md)に残る撤去済み P0 制御を実行指示として使わない。DB 変更と承認の規範は [development.md](../development.md)、実環境の人間向け手順は各 consumer の運用 runbook に従う。

## 現在の位置

- Neon production の適用済み migration は `0000`–`0072` の73件で、ローカル SQL の hash・timestamp と順序まで一致する。`0073`–`0095` は未適用。この照合は ledger の証拠であり、schema 全体の drift や復旧可能性の証明ではない。
- 現在把握した常時稼働の writer は momo-result API、analysis Worker、Summit の3アプリ。手動・CI の本番変更経路も停止対象とする。接続 pooler、外部 batch、人手操作まで含む網羅性は停止前に確定し、停止後に再確認する。
- 旧版の稼働 image、出所、対応 ref は非公開の運用棚卸しに記録した。停止直後の復元可能な backup と、旧 DB・旧 consumer の復元 copy 上の組合せ検証は未実施。
- GitHub の本番承認は維持する。現行 momo-db CI は `drizzle/` に差分がない master push では本番 migration job を起動しないため、保留中の tail を doc-only push や過去 run の安易な rerun で適用しない。

## 工程1：宣言前に済ませる基盤の修正・調査

2026-10-20 の作業で次を実施した。

1. momo-result の現行 private runbook を [公開 Git 規約](https://github.com/ponta2git/momo-result/blob/develop/docs/dev-rule.md) と一致させた。release branch の独立 patch / revert、対象 gate、候補の再固定、後日の develop PR を認める。private runbook は git 管理外のローカル資料である。
2. momo-db の通常 preflight に、承認済み direct hostname と `neondb` の URL・実接続 DB 照合を追加した。期待 hostname は GitHub `CI Actions` の非 secret Variable に Neon の現行 production read-write endpoint から登録済み。今回の切替専用 guard は、同じ接続先の ledger が厳密に `0000`–`0072` と一致する場合だけ通す。どちらも読み取り専用で、URL 実値を出さない。ローカルテストと現在の Neon ledger 照合は成功したが、GitHub Secret `DIRECT_URL` を使った新 guard の CI 実行は未実施。
3. 3アプリの現行 Machine / image、GitHub の本番変更経路、旧版候補を棚卸しした。観測できる範囲と不明点を分け、停止後の実証項目を定めた。

## 工程2：メンテナンス宣言前の実装と合格条件

1. 正規の migration・承認・preflight を維持した一時的な DB 適用入口を作る。固定 commit、baseline guard、停止証拠、適用済み状態を照合し、再実行で盲目的に再適用しない。既存の `production-db` と `CI Actions` を通す。GitHub Secret を使う guard は読み取り専用 run で先に通す。
2. Summit の固定 image 配備と3アプリの停止・起動手順を作り、隔離した Fly 環境で単一 Machine、停止維持、自動起動の抑止、失敗後の状態確認を試す。本番アプリではまだ実行しない。
3. 本番コピーを隔離 DB に復元し、`0073`–`0095` の適用、保全比較、consumer smoke、旧 DB・旧 consumer の別 DB への復旧をリハーサルする。対象の [リハーサル手順](../migration-rehearsal.md)と各 repo の gate を通し、所要時間と復旧余裕を測る。
4. DB、Summit、momo-result の対応 commit / image / 設定を固定する。momo-result は現行 develop の対象変更全体を release 候補とし、許可された事前 master merge と CI を終えて本番承認待ちにする。release 専用修正が必要なら独立 commit として検証し直す。
5. 外部 writer と手動変更経路を再点検し、旧 image artifact の保持・再配備、旧 DB の復元先と権限、通知・drain 担当、開始期限を確定する。これらが未確定なら宣言しない。

## 工程3：宣言後の停止切替

1. 利用者へ案内し、受付と全 writer・scheduler・batch・外部配送を収束・停止する。自動再起動、旧 workflow の rerun、手動操作を凍結し、Machine・未完了処理・DB 接続を照合する。
2. 停止直後の backup を取得し、復元 copy を読み出す。ID・値・参照の比較基準を固定して最終リハーサルと復旧確認を行う。停止が一度でも破られたら backup 後の証拠を失効させて取り直す。
3. 固定候補に対して `production-db` 承認付き CI で migration を適用し、ledger・schema・データ保全を照合する。DB が不合格なら consumer 配備へ進まない。
4. Summit、momo-result の順に対応する固定 image を maintenance 状態で配備し、実接続先、契約、readiness、通知抑止と旧データを確認する。新規業務書込み・外部送信はまだ開かない。
5. 再開境界を判断して受付・処理・配送を開き、監視する。最初の新規書込み・外部送信より前の障害なら、検証済みの旧 DB・旧 consumer の組へ戻せる。以後は新規データを守る forward fix を原則とする。

## 工程4：完了後

最終 SHA、run / attempt、比較結果、復旧候補、未確認範囲を記録する。release 専用 patch は develop 向け PR に反映し、一時 workflow・配備 script を撤去する。本番 migration、consumer 切替、再開と安定確認までを完了条件とし、ローカルテストや事前 merge だけで完了扱いにしない。
