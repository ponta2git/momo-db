# `0073`–`0095` 本番停止切替の実行計画

記録時点: 2026-10-21。対象: momo-db / momo-result / Summit。

> 2026-10-23 完了記録：本番移行、全 consumer の切替・通常再開、通常 CD の再開は完了した。[工程4の結果](#工程4完了記録2026-10-23)に完了範囲、検証、後続へ引き継ぐ項目をまとめる。以下の P1–P5 / C1–C6 は当時の計画・検証記録であり、現在の操作指示ではない。通常の適用・復旧は [development.md](../development.md#6-適用と-release-順序) に従う。

この文書は、メンテナンスの宣言条件、停止中の進行条件、中断時の行き先を定める。実際の担当者・操作時刻・実コマンド、本番状態の観測値、復旧資材の所在と保管構成は Git 管理外の `private/` または各 consumer の非公開 runbook に記録する。公開文書には受入条件・実装契約・検証結果の要約を残す。DB 変更と承認の規範は [development.md](../development.md) に従い、[2026-10-17 の設計計画](./2026-10-17-db-refactor-and-migration-plan.md)に残る撤去済み P0 制御を実行指示として使わない。

**P1–P4 の技術検証は完了した。P5 の結果・宣言可否と当日の実行記録は private runbook で管理する。** 採用経路は、停止・source guard を付けた既存 CLI の全工程である。P5 で候補と前提の鮮度、担当・承認待機、通知、本番停止予算を確定する。本番アプリの停止・配備、本番 SQL は実施していない。以下の合格は固定候補に対する記録であり、後続 commit や現在の本番状態へ自動的に引き継がない。

## P4 までの確認結果と証拠の扱い

10月21日時点で、準備 PR の統合・正式公開・同一 digest の短い検証と、P3・P4 の実コピー検証を完了した。固定候補と実測の詳細は後述の「P3・P4 の実施結果と後続への反映」に記録する。

| 項目 | P4 までの到達点・本番に残る確認 |
| --- | --- |
| 本番 DB | 読み取り専用の source 確認と本番コピー取得が成功した。取得時点の ledger は承認済み baseline と一致した。`0073`–`0095` は隔離 copy にだけ適用した。宣言前・SQL 直前には接続先と状態を取り直す。 |
| writer と role | 実プロセス設定・DB socket・Machine / boot の関連付けを更新し、primary owner と Worker 追加 reader を smoke / recovery copy で検証した。隔離した旧3 consumer の停止継続も実証した。本番の全 writer・pooler・外部 batch・人手・CI 経路の停止は C1 で実証する。共有 PgBouncer backend のアプリ別一意帰属は保証しない。 |
| 旧版と backup | 隔離 copy の実 consumer 停止後に模擬最終 backup を取得・復元読取りし、別の recovery DB で実際の旧3 image の通常起動・読取り・安全な書込みと pool 解放を確認した。本番停止後の最終 backup は C2 で新しく取得する。 |
| DB 入口 | 最終証拠 producer、保護付き SQL 入口、適用後全件比較、結果不明時の読み取り分類を実装・検証した。模擬証拠は本番 SQL が拒否する。本番用証拠は C1–C3 の停止中 source から生成する。 |
| リハーサル | DB 全件保全、maintenance 接続、通常業務・旧版復旧を同じ固定候補へ結び付け、実停止から最終照合までの連続リハーサルが成功した。`status.checks` と `incomplete`、独立した consumer report を分けて読む。 |
| 配備 | 正式公開した固定 digest と component 別の停止・配備・read-only 確認・再開経路を検証済み。本番状態を変更していないことの観測記録は非公開 runbook に保存した。本番配備と再開は C5–C6 に残る。 |

合格の単位は、**同じ固定候補に対する独立して成功した gate** である。失敗 run の途中までの結果を継ぎ足して合格にしない。暗号化 DB report の `checks: true` は DB gate の結果であり、consumer と復旧の合格ではない。合格記録には次を結び付け、人が report と実行結果を読む。

- 候補: DB commit / profile、3 repository の ref、実 image の producer run / attempt・digest、設定。
- source / backup: 接続先の識別子、取得時刻・digest。URL や secret の実値は含めない。
- gate ごとの run ID、操作の入力・許容差分・実結果、失敗・未実施、段階別時間。実データをログや公開記録へ出さない。

候補固定時の `consumerBusinessGate: pending` / `recoveryGate: pending` や DB manifest の `incomplete` は、その時点・担当範囲の記録である。P4 の完了判定は、最終集約記録と、そこに digest で結び付けた各 gate の report で行う。過去の記録を一律に書き換えて成功にしない。本番承認・適用・再開は引き続き未実施として区別する。

参考資料 `momo-restart-assets/restart-guide.md` と `postmortem-2026-10-19.md` は当時の経緯であり、現行環境の合格証拠ではない。前回は別のローカル image の成功では実配備 P0 image の DB 接続を証明できず、検証器の失敗も長い試験の後段で判明した。今回は固定した実 image と短い入口試験から確認する。

## 工程1：実施済みの基盤修正・調査

1. momo-result の現行 private runbook を[公開 Git 規約](https://github.com/ponta2git/momo-result/blob/develop/docs/dev-rule.md)と一致させた。release branch の独立 patch / revert、対象 gate、候補の再固定、後日の develop PR を認める。private runbook は git 管理外のローカル資料である。
2. momo-db の通常 preflight に、承認済み direct hostname と `neondb` の URL・実接続 DB 照合を追加した。期待 hostname は GitHub `CI Actions` の非 secret Variable に、Neon の現行 production read-write endpoint から登録済み。今回の切替専用 guard は、同じ接続先の ledger が厳密に `0000`–`0072` と一致する場合だけ通す。いずれも読み取り専用で、URL 実値を出さない。工程2で GitHub Secret を使う CI 実行も成功した。
3. 3アプリの現行 Machine / image、GitHub の本番変更経路、旧版候補を棚卸しした。観測できた範囲と不明点を分け、停止後の実証項目を定めた。

## P1・P2 の実施結果と計画への反映

10月20日から21日にかけて、P1・P2 の準備実装、短い隔離試験、下記の実装 ref の PR CI が成功し、その後に統合・正式公開・同一 digest の短い確認も完了した。下表は統合前の証拠として残す。文書追記や merge 後の commit は下表と異なるため、実行候補の証拠として付け替えない。

| repository / PR | 実装確認時点の ref | 成功した CI |
| --- | --- | --- |
| [momo-db #28](https://github.com/ponta2git/momo-db/pull/28) | `b1f3fb6` | [39439927314](https://github.com/ponta2git/momo-db/actions/runs/39439927314)：build、migration 整合性、DB 回帰検証。本番適用 job は skipped。 |
| [Summit #25](https://github.com/ponta2git/summit/pull/25) | `8febd9b` | [39440903776](https://github.com/ponta2git/summit/actions/runs/39440903776)：静的検査、DB integration、実 runtime image、capacity、canonical gate。 |
| [momo-result #110](https://github.com/ponta2git/momo-result/pull/110) | `e64dcf05` | [39441131893](https://github.com/ponta2git/momo-result/actions/runs/39441131893)：API / Worker / Web、実 image の build・scan・smoke、ユーザー操作・復旧 E2E、`pr-ready`。 |

これらの CI / fixture の成功は、P4 の固定最終 image と本番コピーによる業務・復旧の合格を代替しない。接続 guard は別の[読み取り専用 CI run](https://github.com/ponta2git/momo-db/actions/runs/39426563850)でも成功した。生の本番観測・dump・role 監査・隔離試験結果は認証付き暗号化 archive と鍵を private storage に保全し、一時 Fly / Neon / Docker 資源は削除済みである。

### P2 で確認した状態と候補変更時の再確認条件

正式な公開経路や実 image の接続不備を長い本番コピー検証へ持ち越さないため、次を確認した。候補変更時もこの契約を維持し、変更の影響がある項目だけを更新する。

1. 3 repository の準備 PR を規約どおりに merge する。momo-result は develop への統合に加え、release PR から master へ取り込む。master 更新前に通常配備の抑止と待機 job の取消しを確認する。
2. merge 後の対象 commit で必要な CI・build・scan・smoke を通し、保護された公開専用 job を実行する。registry から取得できる image と producer run / attempt・platform digest を記録する。公開は本番 Machine の配備・起動を伴わない。
3. 公開した同一 digest の実 image で、接続先・role・maintenance 起動・停止維持・証拠受渡しを隔離環境で確認する。既存の成功結果は変更の影響範囲と照合し、新しい digest に必要な短い試験を通す。
4. source guard、比較器、容量、primary owner / 追加 reader、外部通信の隔離、中断時の後始末が検証済みで、次工程へ証拠を渡せる。P3 の最終証拠が未完成の間は本番 SQL を拒否する。

本番アプリの停止・配備、本番 SQL、通常業務と旧版復旧の全面的な合格は P2 終了に含めない。P4 は、P3 までの変更を反映して最終候補を確定し、本番コピーで業務・データ保全・旧版復旧を一巡する工程とする。

以下は P1・P2 で判明し、P3 以降へ引き継いだ条件である。そこで未実施とした項目の到達点は次節に記録する。

- **候補公開と経路の切替:** momo-result の master release 前に `MOMO_CUTOVER_ACTIVE=true` を設定し、merge 後の `deploy/production-mode.json` が `cutover` であることを確認する。Variable は job の選択、保護された master の marker は実行時の停止判定を担う。待機中の通常 deploy / rollback / 分析保守 job を取消し、保護環境の承認者・branch 制限・credential の期限を確認してから公開する。実行に必要な credential の期限を非公開 runbook で確認し、必要なら更新する。
- **実 image の識別:** OCI index と `linux/amd64` の platform manifest の digest を混同しない。Machine が実際に使用する platform digest と producer run / attempt を固定する。旧 image の設定が tag の場合は、設定の完全一致と provider が解決した digest を別々に照合し、停止後に `sourceImage` の immutable digest へ固定する。tag をそのまま復旧候補にしない。この停止・旧版復元と、digest 不一致の拒否は隔離 Fly で確認した。
- **停止確認の限界:** 新 image は各 process 自身が maintenance mode の DB identity・role・ledger・image・boot を報告し、pool 解放と保存値不変を確認した。再開の成功試験には安全な fixture の readiness も含む。古い readiness の拒否や失敗後の停止維持、旧 image の停止状態への復元が成功しても、実 consumer の通常業務・旧版の業務起動は P4 で別に通す。
- **role と観測の鮮度:** primary owner だけで Worker の分析・LISTEN 接続を代用しない。追加 reader の SELECT、default privilege、LISTEN と書込み拒否は実 copy で確認済みで、P4 の対応接続へ渡す。旧 image の helper は実プロセスの自己報告として扱わず、設定・socket・同一 instance の関連付けを保存する。新 image の自己報告は5分、旧 image の関連付け観測は30分の鮮度条件で採り直す。今回の監査を後日の fresh な観測として流用しない。
- **容量・所要時間・中断:** PostgreSQL 18 の locale・`nc`・CA、複数 copy に必要な容量を確認した。source inventory / dump の実測、timeout 履歴、割当資源は非公開 runbook に記録する。中断時に所有 container・子 process を回収する経路を検証した。準備試験の時間を停止時間の上限にせず、全経路の計測から予算を定める。
- **外部依存と最終証拠:** 隔離 consumer runner の外向き通信遮断、OAuth transport、native 子 process、browser 結果の受渡しは個別に検証した。browser fixture 単独を通信遮断の証拠とせず、P4 では実画像 mirror・通知 stub と同じ隔離構成に結び付ける。SQL 入口が要求する `cutover-final-evidence.yml` と最終証拠は P3 で実装・検証し、手作りの成功証拠で代用しない。

## P3・P4 の実施結果と後続への反映

P3 の最終証拠 producer と読み取り分類は [momo-db #29](https://github.com/ponta2git/momo-db/pull/29)、smoke / recovery の追加 reader mapping 修正は [#30](https://github.com/ponta2git/momo-db/pull/30) で統合した。P4 で検証した組は次のとおり。profile は `canonical-identities-retired-slots-v1`、各 producer は attempt `1` である。

| repository | 検証済み commit | 正式な CI / producer |
| --- | --- | --- |
| momo-db | [`8976254`](https://github.com/ponta2git/momo-db/commit/8976254c919fb63d99fa448893a56e3038635528) | [CI 39594325295](https://github.com/ponta2git/momo-db/actions/runs/39594325295)、[最終証拠 rehearsal 39603296645](https://github.com/ponta2git/momo-db/actions/runs/39603296645) |
| Summit | [`c1b699f`](https://github.com/ponta2git/summit/commit/c1b699f553159e45e275ff9247ce193231ee483b) | [image producer 39579188869](https://github.com/ponta2git/summit/actions/runs/39579188869) |
| momo-result | [`ac2278b`](https://github.com/ponta2git/momo-result/commit/ac2278b4f8eb344abd38f4e71d1cae212e651ca1) | [API / Worker image producer 39583474647](https://github.com/ponta2git/momo-result/actions/runs/39583474647) |

新旧 image の完全な platform digest、設定、入力、差分、個別 gate の記録は非公開の証拠保管先に保全し、認証付き復号と digest 一致を確認した。資材の所在・容量・鍵の保管構成は非公開 runbook で管理する。一時検証資源は削除済みであり、P5 では必要な report と実行入力を復元して使う。

全工程 producer の隔離 run、新旧3 consumer の通常業務 gate、連続リハーサルは独立して成功した。DB は復元・fresh reference・canonical 全保存値・schema・ledger・sequence・二回目 no-op・旧 DB 復旧を確認した。consumer は旧 ID / URL・認証・replay、既存 artifact / basis からの操作、Worker の lease / fencing・publication、実画像の native OCR、Summit の保存済み通知・再送、旧3 image の通常起動・読取り・安全な書込みを確認した。

### 実測の範囲

隔離 copy で、旧 consumer の停止から新版の再開、別 recovery DB での旧版起動、元 copy の停止継続・保存値不変の確認までを連続して計測した。段階別の実測と run 識別子は非公開 runbook に保存した。

この計測には本番ネットワーク、承認待ち、実 Fly 配備の遅延を含まない。CI job と内部処理の計測区間も異なるため、単純に足し合わせたり本番停止時間へ置き換えたりしない。P5 では source 取得の変動も含め、C1 開始から再開までの予算を別途決定する。検証器の時間上限・既定の復旧余裕は、利用者へ約束する停止時間ではない。

### P5・本番手順へ引き継ぐ判断

- **全工程経路を使う。** 短縮経路は未採用。P5 で本番の直列工程と復旧余裕が予算内と判断できる限り、短縮実装や広範な業務試験を追加しない。予算に収まらない具体的な根拠が出た場合だけ経路を再検討する。
- **copy の準備順序を固定する。** 新しい smoke copy は `application-role --copy smoke` の正規 CLI で作成・owner mapping し、その後に追加 reader を設定する。最初の連続試行は private harness が DB 作成を省略して失敗した。失敗ケースを修正・確認した後、上記の連続 run を最初から取り直しており、失敗 run の部分結果を合格に加えていない。reader は smoke / recovery 別に検証し、移行で増えた identity sequence への権限も[監査済みの mapping 契約](../migration-rehearsal.md#アプリケーション権限の再現と接続-gate)に限る。追加接続を primary owner で代用しない。
- **通常起動を C5 の読取り確認に使わない。** P4 では通常起動・OAuth に伴う session / capability 登録、heartbeat、期限切れ行の削除も書込みとして事前に列挙し、前後差分を照合した。C5 は maintenance mode のまま確認し、通常起動と認証・分析保守を開く C6 から復旧境界を越えるものとして扱う。
- **試験対象の限界を引き継ぐ。** OCR は保存 metadata と一致する画像 bytes と native 処理を使ったが、参加者対応は copy 内だけで play order により設定したもので、元の人物同一性を証明しない。fresh publication と既存出力を再利用する fencing は共通の所有権 guard を通る別ケースで検証した。最終 source に未検証の値・境界があれば、その入力に関係する操作だけを再確認する。
- **復旧は新規書込み前に限る。** 連続試験の旧版復旧は、同じ backup から作った別の旧 DB で行った。新版の書込みを受けた DB を巻き戻す試験ではない。C6 の開始後、または書込み・配送の有無が不明な場合は現在のデータを保全し、forward fix へ進む。
- **証拠の保管期限と SQL の有効期限を分ける。** CI artifact の保持は workflow が定める期間に限られる。個別 artifact の失効日は非公開 runbook で確認する。private archive の保存で監査記録は残るが、模擬証拠を本番用に変更しない。本番 producer は検証完了から最大15分、かつ停止予算から復旧余裕を引いた期限までの証拠を発行する。承認待ちと SQL 直前の再照合をその範囲へ収める。期限切れなら、SQL 再実行の前に新しい有効な証拠が必要である。

## 工程2：メンテナンス宣言前の実装と合格条件

P1–P4 は上記の候補で完了した。以下は受入条件として残し、候補・設定・入力が変わった場合の影響判定に使う。次の作業は P5 であり、同じ候補の技術検証を一律に繰り返さない。

### P1. 保護された適用・停止・配備経路を作る

実装・隔離試験・PR CI、準備 PR の統合、master 候補の正式公開と producer run / attempt・digest の確定は完了した。以下は候補ごとに満たす受入条件として維持する。

- **DB 適用:** 正規 migrator、protected environment `production-db` の承認、`CI Actions` job の接続 preflight を維持する一時入口を作る。固定 commit / profile、接続先、`0000`–`0072` baseline、停止証拠、最終 source の保存値・sequence を SQL 直前に照合する。結果不明・target ledger・部分適用では盲目的に再実行せず、工程3の状態判定へ送る。GitHub Secret を使う接続 guard を読み取り専用 CI run で先に通す。長い品質 gate は宣言前に終え、本番 SQL job は固定成果物を使う。
- **候補 image の公開:** momo-result は必要な権限のある公開専用 job で build / scan / smoke 済み image を宣言前に registry へ push し、producer run / attempt と digest を固定する。この job は配備・起動しない。Summit と旧版にも出所、digest、設定、再配備入口を確保する。
- **停止中の配備:** 保護された本番 job を component 別の同一 digest 配備、書込み・配送・分析保守を閉じた read-only 確認、明示的な再開に分ける。実 image の boot / readiness 自体が DB 更新、scheduler、worker claim、通知を起こさず、誤設定時は閉じたまま失敗することを証明する。通常 momo-result `deploy` は使用せず、待機中の通常 job の誤承認を防ぐ取消し・排他も検証する。現行の一体 job では失敗 component だけの再試行はできない。
- **停止と復旧:** 3アプリの単一 Machine 停止・起動、自動起動抑止、pool drain、Summit / momo-result の固定 image 配備、旧版再配備、故障後の状態確認を隔離 Fly で試す。未配備、image 更新済みで停止中、read-only 確認失敗、実行結果不明の各状態から、同じ digest と必要な approval で安全に再開できることを確認する。既存の `Runtime rollback` は DB も他 consumer も戻さず、一括復旧の代わりにならない。

### P2. 検証器と環境を短い試験で通す

入口・比較器・容量・role mapping・3 consumer の短い縦断試験と、正式公開した同一 digest の確認は成功した。P4 で最終 image と実コピーを接続し、以下の契約を同じ候補の証拠へ結び付けた。

- **source と容量:** snapshot / 暗号化より前に、承認済み Neon production branch / endpoint、host、DB 名、実接続先、ledger を独立した読み取り専用 preflight で照合する。rehearsal CLI の source URL は direct 形式の確認だけで、branch 同一性を証明しない。PostgreSQL 18 image の locale・`nc`・CA、Docker daemon、source major / locale、暗号化ファイルと結果保存、inventory / dump の timeout、PGDATA 2 GiB / memory 3 GiB の実量適合を確かめる。不足なら容量設計を直して最初から通す。
- **比較器:** 現行の入出力に対応する正常な新規行・publication・期限切れ削除と、列改変・欠落・余分な行・無関係な期限切れを拒否する小さな fixture を先に通す。前回の誤検知を広い除外規則で隠さない。
- **実 instance と consumer:** `capture-role-audit.mjs` で実 instance の role / boot 観測を暗号化監査へ保存し、`consumer-runner.mjs` / `consumer-probe.mjs` で隔離 copy に実 image を継続接続する。CLI の localhost relay は command ごとに閉じるため、長い業務試験の接続先に流用しない。primary owner と追加 reader の mapping を各接続へ適用し、未知の role / 権限構成なら停止する。native 子 process の実引数・終了、browser 結果の保存・受渡し、外部通知・object・OAuth の stub / mirror と外向き通信遮断を個別に確認する。
- **短い縦断試験:** 接続先・role・停止・証拠受渡しを一度つなぎ、各 process 自身が DB identity、login role、ledger、image digest、boot を報告できることを確かめる。入口や比較器の不具合を、本番コピーの長い一巡で初めて発見しない。

### P3. 最終データ判定と停止中の実行経路を作る

既存 CLI の全工程経路で合格した。短縮経路は、本番の直列工程と復旧余裕が許容停止時間に収まらない場合だけ検討する。P3・P4 の合格条件は本節の証拠生成・拒否条件と、P4 の DB 保全・通常業務・旧版復旧・総合リハーサルに固定する。不具合への対応は原因修正、失敗した既存ケース、影響する必須 gate で閉じ、無関係な成功 gate を再開しない。通信等の無変更再試行は原則一回とし、migration の結果不明は回数にかかわらず読み取り分類を先に行う。

P1 の SQL 入口へ渡す最終証拠 producer `.github/workflows/cutover-final-evidence.yml` を実装した。全工程経路から、固定3 ref / profile、停止・backup・検証の時刻と有効期限、復元して読み出した backup、最終 source の全保存値・schema・role・ledger・sequence・locale、3 Machine の停止設定を生成する。`cutover-guard.mjs` の契約と SQL workflow の候補 SHA / producer run / attempt / artifact digest 照合へ接続し、欠落・古い証拠・候補不一致・途中失敗の拒否まで隔離 copy で確認した。適用後全件比較と、結果不明時の読み取り専用分類も検証済み。本番では停止後に `mode: production` で新しい証拠を生成し、`cutover-apply.yml` の `operation: apply` / `classify` を使う。producer 自体は本番 Machine を停止しない。

停止後には新しい backup を復元して読み、その**復元 baseline**と停止中 source の全保存値・schema・ledger・sequence・locale を照合してから、同じ backup の別 copy で全工程を実行する。role・接続先・設定は事前の source 監査・固定設定にも照合する。MVCC snapshot だけでは sequence と停止継続を証明しない。backup 以降の書込みや自動再起動があれば backup と後続証拠を失効させる。事前の業務証拠を再利用する範囲は次の差分判定で決める。

| 最終基準と事前証拠の差 | 本番 SQL 前に必要な判定 |
| --- | --- |
| 保存値・schema・ledger・sequence・locale が一致し、role・接続先・設定も一致 | 同じ固定候補の業務証拠を再利用する。採用した全工程経路は省略せず、新しい backup の復元読取りと全 DB gate を通す。 |
| schema・ledger・locale・role・接続先・設定は一致し、保存行または sequence だけが変化 | 最終 backup の別 copy で全工程と全保存値・schema・ledger・sequence の許容差分比較を通す。変更列・値域・境界を事前に記録した migration の読取列と consumer 入力契約へ照合し、既存証拠にない値の対象操作だけ隔離 copy で確認する。「同じ業務状態名」だけでは再利用しない。 |
| 構造・権限・接続先・設定の予期しない差、分類不能な値、比較不能、実測上限超過 | 本番 SQL を止め、原因と候補・復旧計画を再評価する。 |

旧 image の最終 copy 上での再起動を省けるのは、事前の recovery copy で同じ実 image の接続・業務操作を通し、停止直前まで source 上で同じ digest・role・設定・旧 ledger で健全に動き、最終 copy の復元方式と role mapping が同じで、変更行に旧 consumer の未検証入力がない場合だけ。欠けた条件に関係する旧 image の接続・対象操作を隔離 copy で確かめられなければ、本番 SQL を止める。

全工程には fresh reference・二回目 no-op・旧 DB 復元も含まれる。browser / OCR / 競合・旧版の広範な業務 smoke は、同じ候補の事前成功証拠を用い、最終データに影響された対象だけ再確認する。全工程を省く短縮経路は**現行 CLI にはなく、今回は採用しない**。将来必要になった場合だけ、同一 backup の別 copy で全工程との結果一致、異常・中断時の拒否、所要時間を検証してから採否を決める。

### P4. 候補を固定し、本番コピーで DB・業務・復旧を通す

1. P1・P2 で統合・正式公開した候補を起点に、P3 までの変更を含む DB、Summit、momo-result の対応 commit / ref、比較器、設定、新旧 image の producer run / attempt・digest を最終確定する。追加変更があれば規約どおりに PR / merge / 必要な CI を通し、影響する image を公開専用経路で公開し直す。momo-result は合意した develop の対象変更全体を release 候補とする。registry の platform digest と実 Machine / process の報告を照合し、PR CI の artifact や隔離試験用 registry の image を正式公開の証拠として扱わない。下記の「候補が変わったとき」に従って必要な gate を更新し、候補が同一である確認済み工程は重複実行しない。
2. [DB 手順](../migration-rehearsal.md#db-部分の実行)を clean tree の固定 commit と **`--profile canonical-identities-retired-slots-v1`** で `snapshot → restore → rehearse → recover-rehearsal` まで通す。既定の `preserve-v1` は pending tail を拒否する。`status.checks` と `incomplete`、全暗号化 report を読み、DB 復元・全保存値・schema・ledger・sequence、二回目 no-op、旧 DB の復元を確認する。
3. 実 instance の source role / boot 監査を採り直し、smoke / recovery copy の primary owner と Worker 追加 reader の role mapping を確認する。隔離した**同じ実 image**を copy に接続し、各 process 自身の接続先・role・ledger・boot を証明する。maintenance probe の後、実 consumer の通常起動・readiness と、C5 で使う代表的な業務データの読み取りを用意して通す。smoke copy で旧 ID / URL / 認証・replay、旧 artifact / basis からの次の操作、worker lease / fencing と publication、Summit の保存済み通知・再送を実データの対象で確かめる。OCR 対象には隔離した実画像 mirror を用意し、外部配送は stub に限定する。操作ごとに入力、値域・境界、許容する行・列・時刻・副作用を先に定め、前後の差分を読む。実データに対象がない場合は fixture の結果と区別し、必須 gate を空欄のまま合格にしない。
4. 別の recovery DB に実際の旧 image を接続し、旧 ledger・role・設定で起動、代表的な読取りと安全な書込みを確認する。元 DB への pool が残らないことも証明する。復旧 artifact と配備入口が利用できなければ不合格とする。
5. 採用した全工程経路で、変更行・sequence、writer 再起動、異常・中断の拒否と、適用前後の読み取り分類を確認する。停止・source guard を付けた実 copy の全工程を測り、DB の成功を実 consumer の成功へ読み替えない。
6. 隔離した実 copy で、模擬停止から最終 backup / 復元読取り、最終データ判定、正規 migrator の模擬適用、適用後全件比較、固定 image の配備・読取り、再開および旧組への復旧までを一巡して測る。P5 ではこの技術検証を重複実行せず、候補と前提の鮮度、担当・承認待機・通知・停止予算の最終判断を行う。実測前に停止時間を保証しない。

長い一巡の前に文書・実装を commit し、候補と入力・設定、各操作の期待差分を確定する。失敗を理由に新しい検証工程を自動追加しない。既存の合格条件では判定できない具体的な事実が見つかった場合だけ、必要最小限の追加を明示する。DB 候補 SHA が変わった場合や migrator 実行証拠を失った場合は、新 run が必要であることを前提に、認証済み snapshot の再利用条件を適用する。

### P5. 宣言可否と停止時間を確定する

P5 の成果物は、既存の private runbook にまとめる候補・証拠索引、担当表、段階ごとの期限、復帰手順、通知文と宣言可否の判断である。P3・P4 の同じ技術試験を重複実行する工程にしない。前回中止時の「失敗のたびに検証を追加し続けた」「準備機構の修復とサービス復帰が結び付いた」という教訓から、実行前に再確認範囲を固定し、復帰に必要な入力を先に揃える。

予定日より前に準備を終える場合は、固定資材の準備完了と当日の開始許可を分けて記録する。通知の送信・担当者の待機、実 instance / role / boot、source、待機 job の確認は当日に更新する。前日の観測を当日の fresh な証拠と扱わず、日付変更だけを理由に不変の業務 gate を再実行しない。SQL / 配備 / 旧版通常再開の承認は、対象と条件を具体化した上で対応する直前 gate に残す。

#### 時間・手戻りを増やす箇所と扱い

| 箇所 | 確認できたコスト・懸念 | P5 での最小化策 |
| --- | --- | --- |
| 文書更新による DB 候補の再固定 | DB CI は2分57秒、全工程 producer の CI job は12分6秒だった。文書だけでも master SHA が変わるたびに証拠が必要になる | 本計画を含む変更を先にまとめ、統合後の同じ SHA で必要な CI と producer を一巡する。producer 内の DB 全工程 report を使い、同じ DB 検証を別 run でも重複させない |
| consumer の再 build・公開・再検証 | momo-result は品質確認開始から公開完了まで22分51秒。公開 job 自体は1分3秒で、前段の品質・image・統合確認の方が長い | 文書だけなら consumer image を変更しない。既存 digest・producer・設定が一致する gate を再利用する。必要な consumer 修正があれば関連修正をまとめ、停止前に規約どおりに完了する |
| source 取得・繰返しの全件照合 | source 取得時間には変動と timeout 履歴がある。実測は非公開 runbook に記録し、内部処理と job 全体の区間を区別する | 認証・接続先・容量の問題を停止前に除く。準備試験は認証済み snapshot の再利用条件を使う。本番停止後の新 backup・復元読取り・全件比較・停止継続確認は維持する |
| artifact・秘密情報・証拠の取出し | 大きな archive の展開、artifact の失効、token 更新、private plan の設定不足が後段で判明すると長い工程をやり直す | archive は一度復号認証して必要なファイルだけを展開する。新旧 image と publication artifact、鍵、必要な credential・権限・plan hash の利用可否を最初に確認し、以後は不変の資材を再取得しない |
| 承認・job 起動・排他・証拠の期限 | component 操作は action ごとに保護 job があり、checkout・取得・暗号化・保存も必要。SQL 証拠は検証完了から最大15分 | action と入力、担当・承認者を事前に揃える。各 job 全体と待機を予算化し、同一排他 group への先行投入で短縮できると見込まない。短命な観測は宣言直前に集める |
| 中止後の復帰 | `restore-source` は旧 image の停止状態への復元まで。候補用の `resume` は旧版の通常再開を代替しない | 旧版の通常起動・必要設定の復元・受付再開・readiness までを既存の承認経路に結び付け、入力を停止前に確定する。中止後に controller や workflow の設計を始めない |

上記の CI 実測は、[DB CI](https://github.com/ponta2git/momo-db/actions/runs/39594325295)、[DB producer](https://github.com/ponta2git/momo-db/actions/runs/39603296645)、[momo-result 公開 run](https://github.com/ponta2git/momo-result/actions/runs/39583474647)の attempt `1` の開始・終了時刻による。単発の履歴であり、将来の上限や本番停止時間ではない。特に12分6秒には rehearsal 用の online snapshot 等が含まれ、本番の停止中 producer と同じ区間ではない。

#### P5 を進める順序

1. **既存証拠と差分だけを整理する。** 各必須 gate に「再利用する証拠」「鮮度だけ更新する項目」「変更で再実行する項目」を対応付ける。入力・期待差分・合格条件は既存のものを使い、根拠のない追加 smoke を入れない。復帰資材の欠落や権限不足のように後段全体を止める条件を、長い CI より先に確認する。
2. **実行・復帰の入口を使える状態にする。** 新旧 digest と設定、publication artifact、source の接続先と backup の保管先、復元先・role mapping・接続切替、鍵と token、保護環境の branch 制限、担当者を揃える。既存の `state` 等の読取り経路で候補・plan と実 Machine を照合し、停止操作は行わない。必要な手動観測 helper は対象・用途・削除手順を先に具体化する。旧版の通常再開に未確定の操作が残れば、この時点で解消する。
3. **変更をまとめて候補を確定する。** 文書・必要な修正をまとめて規約どおりに統合し、新 SHA の必須 CI と全工程 producer を通す。同じ producer の DB report が必須項目を満たせば、別の DB 全工程 run を加えない。consumer image・設定・比較対象が不変と照合できる場合は、P4 の業務・browser / OCR・復旧証拠を再利用する。実行時刻や新 run ID の追記だけのために master を再更新しない。
4. **独立した準備を並行し、短命な確認を最後に行う。** 証拠照合・通知文・担当と承認者の調整・credential の確認は、同じ資源を変更しない範囲で CI 待ちに進める。全 writer・pooler・scheduler・batch・手動 / CI 経路、`MOMO_CUTOVER_ACTIVE` と marker、待機 job と先行 push / release 抑止を確認する。実 instance / role / boot と source の鮮度確認は宣言直前へ寄せる。期限切れだけなら当該観測を取り直し、不変の出所・業務 gate は再実行しない。
5. **時間と復帰先を決めて宣言判断を閉じる。** 下記の期限と復帰手順を private runbook に確定する。各判断を既存証拠で裏付け、具体的な未確認項目がなくなった時点で P5 を完了する。「念のため」の試験を続けない。利用者通知と担当者の待機を確認して宣言可否を決める。本番適用は P5 では行わず、SQL / 配備の approval は C1–C6 の対応する直前 gate まで行わない。

#### 失敗しても検証を際限なく増やさない

- まず失敗した step、実際の DB / Machine 状態、入力、期待差分から、製品・migration、検証器・fixture、環境・権限、証拠保存のどこで失敗したかを分類する。job の後段の暗号化・upload 失敗を、そのまま SQL / 配備の失敗とみなさない。結果不明なら現状態を読み、再実行を先に行わない。
- 修正前に、失敗した既存ケースと影響する必須 gate だけを再確認対象として記録する。通過済みの無関係な gate は保持する。連続計測や停止継続が途切れた場合は、その連続区間を取り直すが、独立して成功した全業務 gate まで再開しない。変更のない通信再試行は原則一回とする。
- 新しい確認を追加できるのは、既存 gate で判定できない具体的な入力・状態が判明した場合だけとする。既存証拠で足りない理由、最小の確認、終了条件を同じ実行記録へ書く。原因が未特定のまま広範な試験を追加しない。新しい本番制御機構や受入条件の変更が必要なら、準備の範囲と再検証コストを再判断する。
- 停止後は、P5 で定めた診断・再試行の時間枠と復帰余裕の内側でのみ続行する。同じ不明状態が続く、または残時間を満たさない場合は、事前に決めた状態別の復帰へ移る。停止中に比較器・controller・workflow を新規開発して切替を完遂しようとしない。

#### 停止・復帰時間の決め方

利用者が書けなくなる C1 から利用再開までを一つの時計で測る。停止中は `drain → 最終 backup / 復元読取り → 全工程による最終データ判定 → 承認・本番 SQL → 本番全件比較 → maintenance 配備・最小読取り → 明示的再開` の順に進む。採用した全工程の reference / no-op / 旧 DB 復元、job の setup・証拠転送・承認待ち、実 Fly 操作も予算に含める。build / scan / image 公開、広範な業務 smoke と archive の取出しを停止後へ持ち越さない。

P5 で状態別に、次の段階の所要上限、結果不明時の読取り分類、利用再開までの復帰時間、余裕を定める。各段階へ入る条件は **`現在時刻 + 次段階の所要上限 + その失敗状態からの復帰時間 + 余裕 ≤ 最終再開期限`** とする。SQL 直前は、これに加えて承認・再照合が `expiresAt` より前に終わることを要求する。job の切替や再試行で時計をリセットしない。検証器の120分上限・既定の30分復旧余裕をそのまま本番の保証値にしない。未測定の部分は P1・P4 の対応する実測から根拠を確認し、不足があれば当該操作だけを限定して確認する。

復帰用に、承認済みの旧 digest・設定、利用可能な実行入口、DB の復元先と権限・接続切替、通常起動・受付再開、boot に結び付く readiness と代表的な読取りを先に用意する。`restore-source` の後に旧版用の起動手順が必要なことを省略しない。復帰判定に新候補の CI 完了、広範な browser / OCR、文書・cleanup の完了を要求しない。保存済みデータと実際の稼働状態の確認は維持する。

provider の時点復元を復帰経路に採る場合は、対象 branch / endpoint、保持期間、停止後の復旧点、復元前状態の退避先と接続先の維持・切替を具体化する。未確認の provider 操作だけを所有する一時環境で確認し、既存の旧版業務試験は繰り返さない。本番 SQL 前には停止後の復旧点が利用可能であることを確認する。実際の復元後は最終 backup の基準に対する ledger・schema・全保存値・sequence・role の一致を確認してから旧版を開く。

**サービスの利用再開と、通常 CD の再開は分ける。** 中止時に旧 DB・旧 consumer を再開できても、新 schema 向けの master を通常 deploy できる状態にはしない。必要なら `cutover` の配備抑止を保ったまま利用を再開し、旧 DB と互換な通常配備候補・待機 job・marker / Variable の扱いを確認してから CD を戻す。候補修復や通常 CD の復元を待つためだけに、健全な旧サービスを停止し続けない。

### 候補が変わったときの手戻り範囲

検証器、consumer、配備制御は各 repository の規約に沿って進める。失敗は step・実 image・DB state・入力・期待差分から、製品 / migration、検証器 / fixture、環境 / 権限に分類する。環境修正のためにコード PR を増やさず、失敗ごとに release PR を作り直さない。各 repository の作業 branch / 既存 PR に関連修正をまとめ、ローカルの影響 gate 後に push する。無関係な判断は一つの PR に混ぜない。

momo-result の通常変更は `develop` 向け PR、切替専用の独立 patch / revert は release branch とする。選んだ内容を一つの release branch に固め、`master` 向け release PR を更新する。merge 前に最新 develop / master との**マージ予定結果**を隔離して build・主要操作・復旧経路を確認する。exact master commit の CI と image 証拠は merge 後に必要で、その時点で候補を固定する。momo-db / Summit も各 branch 規約を守る。merge 後の修正は新 commit / image と必要な PR・gate を受け入れ、古い証拠を付け替えない。

| 変更 | 新たに必要な確認 |
| --- | --- |
| 文書・運用手順のみ | 参照先、手順と実装、差分を確認する。rehearsal CLI は **commit SHA 全体**を固定し、producer / SQL workflow も dispatch 時の master SHA を要求する。momo-db の文書更新を master に統合したら、新 SHA の CI と全工程 producer の証拠が必要。producer 内の DB run が必須 gate を満たせば、同じ DB 全工程を別に繰り返さない。認証済み snapshot の import 条件を満たし、DB SQL・比較器・consumer image・設定が不変と確認できれば、無関係な業務・browser / OCR gate は再利用する。古い manifest や artifact を新 SHA に書き換えない。 |
| DB SQL・schema・変換契約・比較器・rehearsal 実装 | 変更点の fixture / build / DB gate の後、新しい clean commit で DB 全件比較する。保存 archive は source 同一性・取得時刻が用途に合う場合だけ新 run へ import できる。移行後 schema・保存値・role の同一性を証明できる場合だけ、無関係な consumer 操作の証拠を再利用する。 |
| Runtime / Worker / Summit のコード・設定・image | 影響 component の build・規約上の CI・変更した契約と業務操作・停止 / 復旧を確認する。DB 候補と復元 copy が同じなら DB 全工程は繰り返さない。digest が変われば実 image の接続・role・boot と影響する統合 smoke を通す。 |
| 停止・配備・証拠 runner のみ | 失敗分岐の fixture、隔離した停止 / 起動 / 再配備、証拠受渡しを通す。SQL / consumer 出力が同じと照合できれば無関係な業務 smoke は不要。momo-db commit が変われば SHA 制約に従う。 |
| 本番 source の保存行・sequence のみ | PR や image rebuild は不要。工程3の最終 backup と事前 baseline の差を分類し、採用した P3 の全工程と、新しい入力に必要な対象操作を確認する。schema・role・接続先の差はこの行に含めない。 |

既存の PR / master CI が定める必須 job は省略しない。事前 run は稼働中 snapshot の検証であり、停止・最終 backup・本番適用・再開の証拠にはならない。旧 snapshot を再利用しても取得時刻と実データの新しさは変わらない。

## 工程3：宣言後の停止切替

工程2の合格記録と private runbook の担当・中止期限を手元に置き、次の順序で進む。各段階の不合格は工程3末尾の状態表に従う。**本番 SQL 前の中止**と**新規書込み・外部送信前の旧組復旧**を区別する。

### C1. 停止・凍結

利用者に案内し、受付、全 writer・scheduler・batch・外部配送を drain して停止する。自動再起動、旧 workflow rerun、手動操作を凍結する。

- **進行条件:** Machine・未完了処理・DB 接続で停止を実証した。
- **中止条件:** 停止できなければ backup へ進まない。後で書込み・再起動があれば backup と以後の証拠を失効させ、C1 から取り直す。

`pg_stat_activity` の他 role の接続が権限によって詳細不明でも、残存接続として扱う。可視範囲だけを数えて drain 完了としない。停止後の producer は残存 client を拒否するが、外部の変更経路を凍結する担当者の確認を代替しない。

### C2. 最終 backup

停止中の source の ID・全保存値・参照・schema・ledger・sequence、role・接続先を最終基準として固定する。新しい backup を取り、復元 copy を実際に読む。

- **進行条件:** 復元 copy と source 基準の全件一致を確認した。旧 image の最終 copy 上での再起動を省く場合は P3 の条件もすべて満たした。
- **中止条件:** 復元不能・不一致・旧版の必要な対象操作を確認できない場合は本番 SQL を止める。

### C3. 最終データ判定

P3 の表で事前の復元 baseline と最終基準を分類する。

- **進行条件:** 採用した P3 の全工程を最終 copy で通した。完全一致なら固定候補の業務証拠を再利用し、保存行 / sequence の変化に未検証入力があれば必要な対象操作も確認した。
- **中止条件:** 構造等の差、分類不能、結果不明、実測上限超過があれば本番 SQL を止める。

### C4. SQL 直前 gate・適用

承認を始める前に、停止継続、復元可能な backup、最終データの移行証拠、固定 commit / profile・3 ref、接続先、`0000`–`0072` ledger、中止期限・復旧余裕を再照合する。承認後も同じ保護 job の中で、停止証拠、接続先、ledger、schema・role、source の最終基準との一致を preflight で確認し、異なれば SQL 前に閉じて止まる。**現状は書込みを技術的に封じる fence がないため、job は SQL 直前に source の全保存値・sequence を再照合する。** 最終基準から SQL まで正規 migrator 以外の書込みを封じ、role / schema の比較契約も保つ検証済みの fence が将来成立した場合だけ、fence 証拠と ledger / sequence / 接続状態の照合へ置き換えられる。

- **進行条件:** 承認前 gate の合格後に `production-db` を承認し、`CI Actions` job 内の preflight・直前再照合・正規 migrator を順に通した。
- **中止条件:** gate 不合格なら承認しない。SQL の失敗・結果不明なら read-only 状態判定を行い、同じ job を盲目的に rerun しない。

本番 producer の同一 run / attempt・artifact digest と `expiresAt` を確認する。P4 の `cutover-rehearsal-evidence` は本番 SQL に渡せない。期限切れの本番証拠は `operation: classify` の読み取り分類にだけ使え、`apply` には新しい有効な証拠が必要である。

### C5. DB 保全・配備

本番の target ledger・schema・全保存値・参照・sequence を最終基準と許容された変換契約で照合する。合格後、Summit、momo-result Runtime / Worker の順に固定 digest を maintenance 状態へ component 別に配備する。

- **進行条件:** 各実 Machine の digest・設定、接続先・login role・target ledger、readiness、既存行の代表的な**読取り**、停止維持を確認した。
- **中止条件:** DB 不合格なら配備しない。配備途中の失敗は component 状態を読んで不足箇所から再開する。入口を開く前の書込み・外部送信は事故として扱う。

通常起動・OAuth ログイン・Worker の capability 登録や期限切れ cleanup を、この段階の読取り確認に混ぜない。P4 で許容差分を確認した処理でも、本番では書込みとして扱う。maintenance mode で可能な確認を完了してから C6 を開始する。

### C6. 再開・監視

DB と全 consumer が同じ組で合格したら、受付、処理、配送と必要な分析保守を明示的に開き、最初の業務結果と監視を確認する。分析保守が DB を更新するなら、その開始も復旧境界である。

- **復旧境界:** 通常起動時の登録・cleanup も含め、新規書込み・外部送信の前と証明できる場合だけ旧組復旧を選ぶ。発生または不明なら現在のデータを守る forward fix へ移る。P4 の別 recovery DB での成功を、新版が受け付けたデータを巻き戻す根拠にしない。

### 中断・再配備時の状態判定

| 観測した状態 | 次の操作と再確認 |
| --- | --- |
| P5 の準備中に中止し、本番の停止・配備・SQL をしていない | 稼働中の旧サービスを維持し、準備中の job と変更経路を整理する。通常 CD の扱いは別途判断し、そのためにアプリを止めたり、製品コードを全面 revert したりしない。 |
| 停止・backup 後、SQL 前に中止 | DB が baseline で最終基準のままか読み、旧 Machine / image と role・接続先を照合して、旧版の通常起動・受付再開を行う。元 DB に変更がなければ backup restore や全 CI を繰り返さない。準備機構の修復や新候補の完成を待たず、既定の旧版再開を優先する。 |
| SQL job が失敗・結果不明 | `operation: classify` で実 ledger・schema・保存値・sequence を読み取り分類する。`baseline-unchanged` なら中止時は上の旧版再開へ進む。続行する場合だけ、有効な最終証拠・直前 gate・残時間を満たして固定候補の保護付き job を実行する。`target-preserved` なら SQL を再実行せず、残時間内に完了できる C5 の不足部分へ進むか、新規書込み前の旧組復旧を判断する。`partial-or-unknown` / `comparison-failed` は停止し、データを保全して事前検証した復旧を判断する。 |
| DB は target・全件保全済み、配備は途中、書込み・配送は閉じていると証明できる | Machine ごとに digest・設定・停止 / 起動状態、DB 接続、失敗 step を読む。完了した component は触らず、未配備なら同じ digest を配備し、配備済みなら不足した read-only 確認から再開する。必要な approval・排他を通し、実 image / role / ledger / readiness / 読取りを確認する。build・全 CI・DB リハーサルは繰り返さない。commit / digest / 設定が変わった、artifact がない、固定 master が先へ進んだ場合は候補を再選定する。 |
| 新規書込み・外部送信の前と証明でき、旧組へ戻す | 最終 backup を復元し、旧 ledger・schema・全保存値・参照・sequence・role を照合する。事前に起動検証した旧 image の digest・設定を再配備し、実接続先・起動・readiness・代表的な読取りを確認してから開く。旧版の全 CI / browser / OCR / 業務 smoke は繰り返さない。 |
| 新規書込み・外部送信が発生、または有無を証明できない | 受付・処理・配送を止め、現在の DB と外部副作用を保全・分類する。最終 backup へ巻き戻さず、新規データを守る forward fix と個別の再開確認を行う。 |

component 別の停止・配備・旧版復元、最終 source を照合する SQL guard、証拠 producer、状態分類・全件比較は P1–P4 で実装・隔離検証済みである。本番では C1–C6 の実状態・有効な証拠・承認を必要とする。停止・source guard と現行 CLI 全工程を採用し、P5 で確定した期限内に進める。

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
- 通常運用の保護、保守起動、比較・復元用 script と tests は保持した。切替専用 credential / 権限の撤去は未実施であり、「全一時資材を撤去済み」とはしない。撤去には現在の依存先と保持要件の確認が必要である。
- backup、暗号化証拠、固定 image の識別情報と当時の実行入力を保持する。過去の有効期限・未実施判定は書き換えない。新規書込みを再開した後の復旧は新規データを保全する forward fix を原則とし、切替前の DB や image を単独で戻さない。

この完了記録の整理では本番への再接続・再試験・配備を追加していない。個別機能の本番受入が未確認の場合は、その機能のチケットで残りを追跡する。

関連チケットの記録も整理した。[MOM-34](https://linear.app/ponta/issue/MOM-34)（仕様）と [MOM-35](https://linear.app/ponta/issue/MOM-35)（DB 保存・移行）は Done。[MOM-33](https://linear.app/ponta/issue/MOM-33) はロール別の本番利用確認を残すため In Progress を維持する。
