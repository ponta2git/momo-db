# `0073`–`0095` 本番停止切替の実行計画

更新日: 2026-10-20。対象: momo-db / momo-result / Summit。

この文書は、メンテナンスの宣言条件、停止中の進行条件、中断時の行き先を定める。実際の担当者・操作時刻・実コマンドは各 consumer の運用 runbook に記録する。DB 変更と承認の規範は [development.md](../development.md) に従い、[2026-10-17 の設計計画](./2026-10-17-db-refactor-and-migration-plan.md)に残る撤去済み P0 制御を実行指示として使わない。

**現時点では切替リハーサルが未完了で、メンテナンスを宣言できない。** 以下の工程2をすべて合格させ、固定した実候補・復旧候補・実測時間を一つの記録に結び付けてから宣言する。宣言後も各段階の進行条件を満たさなければ止める。

## 現在の位置と証拠の扱い

| 項目 | 2026-10-20 時点の事実・残る確認 |
| --- | --- |
| 本番 DB | Neon production の ledger は `0000`–`0072` の73件で、ローカル SQL の hash・timestamp・順序と一致する。`0073`–`0095` は未適用。ledger の一致だけでは schema drift や復旧可能性を証明しない。 |
| writer | 常時稼働として把握したのは momo-result API、analysis Worker、Summit の3アプリ。pooler、外部 batch、scheduler、人手・CI の本番変更経路も停止対象として宣言前に網羅し、停止後に実証する。 |
| 旧版と backup | 旧 image・出所・対応 ref は非公開の運用棚卸しに記録した。停止直後の復元可能な backup、および旧 DB と旧 consumer の復元 copy 上の組合せ検証は未実施。 |
| DB 入口 | 接続 guard はローカルテストと現在の Neon ledger 照合に成功したが、GitHub Secret `DIRECT_URL` を用いた新 guard の CI 実行は未実施。現行 CI は `drizzle/` 差分のない master push で本番 migration job を起動しない。doc-only push や過去 run の rerun で pending tail を適用しない。 |
| リハーサル | [`migration:rehearsal`](../migration-rehearsal.md) は DB copy の移行・比較と旧 DB の復元までを扱う。実 consumer の接続・業務操作、旧版への切替、実環境 role 監査の作成、停止継続を実行する一式はない。`status.checks` が真でも `incomplete` を残す。 |
| 配備 | 現行 momo-result `deploy` は approval 後に image を push し、Runtime / Worker を明示起動して postdeploy smoke と分析保守まで進む。停止中に承認すると writer が再開し得る。停止を保つ専用の公開・配備・確認・再開経路は未実装。 |

合格の単位は、**同じ固定候補に対する独立して成功した gate** である。失敗 run の途中までの結果を継ぎ足して合格にしない。暗号化 DB report の `checks: true` は DB gate の結果であり、consumer と復旧の合格ではない。合格記録には次を結び付け、人が report と実行結果を読む。

- 候補: DB commit / profile、3 repository の ref、実 image の producer run / attempt・digest、設定。
- source / backup: 接続先の識別子、取得時刻・digest。URL や secret の実値は含めない。
- gate ごとの run ID、操作の入力・許容差分・実結果、失敗・未実施、段階別時間。実データをログや公開記録へ出さない。

参考資料 `momo-restart-assets/restart-guide.md` と `postmortem-2026-10-19.md` は当時の経緯であり、現行環境の合格証拠ではない。前回は別のローカル image の成功では実配備 P0 image の DB 接続を証明できず、検証器の失敗も長い試験の後段で判明した。今回は固定した実 image と短い入口試験から確認する。

## 工程1：実施済みの基盤修正・調査

1. momo-result の現行 private runbook を[公開 Git 規約](https://github.com/ponta2git/momo-result/blob/develop/docs/dev-rule.md)と一致させた。release branch の独立 patch / revert、対象 gate、候補の再固定、後日の develop PR を認める。private runbook は git 管理外のローカル資料である。
2. momo-db の通常 preflight に、承認済み direct hostname と `neondb` の URL・実接続 DB 照合を追加した。期待 hostname は GitHub `CI Actions` の非 secret Variable に、Neon の現行 production read-write endpoint から登録済み。今回の切替専用 guard は、同じ接続先の ledger が厳密に `0000`–`0072` と一致する場合だけ通す。いずれも読み取り専用で、URL 実値を出さない。CI での確認は工程2に残る。
3. 3アプリの現行 Machine / image、GitHub の本番変更経路、旧版候補を棚卸しした。観測できた範囲と不明点を分け、停止後の実証項目を定めた。

## 工程2：メンテナンス宣言前の実装と合格条件

以下の順に入口・比較器・最終判定経路の安価な失敗を除き、固定候補で本番コピーを一巡する。各 gate の実装・確認が欠けたまま宣言しない。本番アプリで停止・配備を試す段階ではない。

### P1. 保護された適用・停止・配備経路を作る

- **DB 適用:** 正規 migrator、protected environment `production-db` の承認、`CI Actions` job の接続 preflight を維持する一時入口を作る。固定 commit / profile、接続先、`0000`–`0072` baseline、停止証拠、最終 source の保存値・sequence を SQL 直前に照合する。結果不明・target ledger・部分適用では盲目的に再実行せず、工程3の状態判定へ送る。GitHub Secret を使う接続 guard を読み取り専用 CI run で先に通す。長い品質 gate は宣言前に終え、本番 SQL job は固定成果物を使う。
- **候補 image の公開:** momo-result は必要な権限のある公開専用 job で build / scan / smoke 済み image を宣言前に registry へ push し、producer run / attempt と digest を固定する。この job は配備・起動しない。Summit と旧版にも出所、digest、設定、再配備入口を確保する。
- **停止中の配備:** 保護された本番 job を component 別の同一 digest 配備、書込み・配送・分析保守を閉じた read-only 確認、明示的な再開に分ける。実 image の boot / readiness 自体が DB 更新、scheduler、worker claim、通知を起こさず、誤設定時は閉じたまま失敗することを証明する。通常 momo-result `deploy` は使用せず、待機中の通常 job の誤承認を防ぐ取消し・排他も検証する。現行の一体 job では失敗 component だけの再試行はできない。
- **停止と復旧:** 3アプリの単一 Machine 停止・起動、自動起動抑止、pool drain、Summit / momo-result の固定 image 配備、旧版再配備、故障後の状態確認を隔離 Fly で試す。未配備、image 更新済みで停止中、read-only 確認失敗、実行結果不明の各状態から、同じ digest と必要な approval で安全に再開できることを確認する。既存の `Runtime rollback` は DB も他 consumer も戻さず、一括復旧の代わりにならない。

### P2. 検証器と環境を短い試験で通す

- **source と容量:** snapshot / 暗号化より前に、承認済み Neon production branch / endpoint、host、DB 名、実接続先、ledger を独立した読み取り専用 preflight で照合する。rehearsal CLI の source URL は direct 形式の確認だけで、branch 同一性を証明しない。PostgreSQL 18 image の locale・`nc`・CA、Docker daemon、source major / locale、暗号化ファイルと結果保存、inventory / dump の timeout、PGDATA 2 GiB / memory 3 GiB の実量適合を確かめる。不足なら容量設計を直して最初から通す。
- **比較器:** 現行の入出力に対応する正常な新規行・publication・期限切れ削除と、列改変・欠落・余分な行・無関係な期限切れを拒否する小さな fixture を先に通す。前回の誤検知を広い除外規則で隠さない。
- **実 instance と consumer:** `captureApplicationRoleAudit` には運用入口がなく、CLI の localhost relay は command ごとに閉じる。実 instance の role / boot 観測から暗号化監査を作る入口と、隔離 copy に実 image を継続接続する runner を作る。role mapper の単一 owner 等の仮定が実 DB に合わなければ修正する。native 子 process の実引数・終了、browser 結果の保存・受渡し、外部通知・object・OAuth の stub / mirror と外向き通信遮断を個別に確認する。
- **短い縦断試験:** 接続先・role・停止・証拠受渡しを一度つなぎ、各 process 自身が DB identity、login role、ledger、image digest、boot を報告できることを確かめる。入口や比較器の不具合を、本番コピーの長い一巡で初めて発見しない。

### P3. 最終データ判定と停止中の実行経路を作る

停止後に使う判定器として、新しい backup を復元して読み、成功済み rehearsal の**復元 baseline**と source の全保存値・schema・ledger・sequence・locale を比較する経路を作る。宣言前は隔離 copy から模擬最終 backup を作って試す。role・接続先・設定は事前の source 監査・固定設定に照合する。MVCC snapshot だけでは sequence と停止継続を証明しない。実際の停止後に backup 以降の書込みや自動再起動があれば backup と後続証拠を失効させる。

| 最終基準と事前証拠の差 | 本番 SQL 前に必要な判定 |
| --- | --- |
| 保存値・schema・ledger・sequence・locale が一致し、role・接続先・設定も一致 | 同じ固定候補に対する事前の移行・業務証拠を再利用できる。新しい backup 自体の復元読取りと source との全件一致は省略しない。 |
| schema・ledger・locale・role・接続先・設定は一致し、保存行または sequence だけが変化 | 最終 backup の別 copy に固定 migration を**一回**適用し、全保存値・schema・ledger・sequence の許容差分を比較する。変更列・値域・境界を事前に記録した migration の読取列と consumer 入力契約へ照合し、既存証拠にない値の対象操作だけ隔離 copy で確認する。「同じ業務状態名」だけでは再利用しない。 |
| 構造・権限・接続先・設定の予期しない差、分類不能な値、比較不能、実測上限超過 | 本番 SQL を止め、原因と候補・復旧計画を再評価する。 |

旧 image の最終 copy 上での再起動を省けるのは、事前の recovery copy で同じ実 image の接続・業務操作を通し、停止直前まで source 上で同じ digest・role・設定・旧 ledger で健全に動き、最終 copy の復元方式と role mapping が同じで、変更行に旧 consumer の未検証入力がない場合だけ。欠けた条件に関係する旧 image の接続・対象操作を隔離 copy で確かめられなければ、本番 SQL を止める。

この短い経路は**現行 CLI にはない**。採用する場合は P4 の一巡で同一 backup からの別 copy による全工程と結果が一致し、異常・中断時に閉じて止まることと段階別時間を測る。fresh reference、二回目 no-op、browser / OCR / 競合、旧版の広範な smoke は固定候補の事前成功証拠を用い、最終データに影響された対象だけ再確認する。短い経路が完成しない場合は、別途検証済みの停止・source guard を付けて現行 CLI の全工程を停止中に実行する。**P3 の合格は短い経路か、この全工程の代替経路のいずれかを実コピーで通し、停止時間と復旧余裕に収めた場合だけ**とする。

### P4. 候補を固定し、本番コピーで DB・業務・復旧を通す

1. DB、Summit、momo-result の対応 commit / ref、比較器、設定、新旧 image の producer run / attempt・digest を固定する。momo-result は現行 develop の対象変更全体を release 候補とし、許可された事前 master merge と CI を終える。変更後は下記の「候補が変わったとき」に従って gate を更新する。
2. [DB 手順](../migration-rehearsal.md#db-部分の実行)を clean tree の固定 commit と **`--profile canonical-identities-retired-slots-v1`** で `snapshot → restore → rehearse → recover-rehearsal` まで通す。既定の `preserve-v1` は pending tail を拒否する。`status.checks` と `incomplete`、全暗号化 report を読み、DB 復元・全保存値・schema・ledger・sequence、二回目 no-op、旧 DB の復元を確認する。
3. 実 instance の source role / boot 監査を作り、smoke / recovery copy の role mapping を確認する。隔離した**同じ実 image**を copy に接続し、各 process 自身の接続先・role・ledger・boot を証明する。smoke copy で旧 ID / URL / 認証・replay、旧 artifact / basis からの次の操作、worker lease / fencing と publication、Summit の保存済み通知・再送を実データの対象で確かめる。OCR 対象には隔離した実画像 mirror を用意し、外部配送は stub に限定する。操作ごとに入力、値域・境界、許容する行・列・時刻・副作用を先に定め、前後の差分を読む。実データに対象がない場合は fixture の結果と区別し、必須 gate を空欄のまま合格にしない。
4. 別の recovery DB に実際の旧 image を接続し、旧 ledger・role・設定で起動、代表的な読取りと安全な書込みを確認する。元 DB への pool が残らないことも証明する。復旧 artifact と配備入口が利用できなければ不合格とする。
5. 短い経路を採用する場合は、同一 backup から作った別々の実 copy で P3 の短い経路と全工程の判定・結果を照合する。その backup から作った隔離 fixture で変更行・sequence、異常、中断の分岐も試し、段階別時間を記録する。短い経路が合格しない場合は停止・source guard を付けた P3 の代替経路で全工程を測る。

### P5. 宣言可否と停止時間を確定する

- 全 writer・pooler・scheduler・batch・手動 / CI 変更経路と停止・drain 担当を確定し、3 repository の固定 ref が先行 push / release に上書きされないようにする。新旧 image の digest・保持期限・再配備入口、backup の復元先と権限、利用者通知、承認者の待機を確認する。
- 実コピーの隔離環境で、模擬最終 backup の復元読取り、行・sequence が変わった場合の最終データ判定（短い経路なら一回の copy migration、代替経路なら現行 CLI 全工程）、本番と同じ正規 migrator の模擬適用、全件比較、固定 image 配備・read-only 確認、任意の中止点から旧組へ戻る経路を測る。本番 DB への適用はここで行わない。利用者が書けなくなってから再開するまでを停止時間とし、開始期限・各中止期限・復旧余裕を private runbook に置く。実測がない間は短縮分数や再開時刻を宣言しない。
- 停止中の直列工程は `drain → 最終 backup / 復元読取り → 最終データ判定 → 承認・本番 SQL → 本番全件比較 → 固定 image 配備・最小確認 → 再開`。候補 build / scan / CI、registry push、reference / no-op、広範な業務・復旧 smoke は宣言前に終える。停止後も安全な source 比較と復元確認、承認者の待機は並行できる範囲で進める。
- 同じ固定候補について P1・P2・P4 と P3 で選んだ経路、上記の実測が独立して成功し、失敗・未実施が解消した場合だけ宣言する。approval のクリックで SQL または配備が始まる job は、対応する工程3の直前 gate まで承認しない。停止後に初めて調整する手順や復旧余裕不足が残れば宣言しない。

### 候補が変わったときの手戻り範囲

検証器、consumer、配備制御は各 repository の規約に沿って進める。失敗は step・実 image・DB state・入力・期待差分から、製品 / migration、検証器 / fixture、環境 / 権限に分類する。環境修正のためにコード PR を増やさず、失敗ごとに release PR を作り直さない。各 repository の作業 branch / 既存 PR に関連修正をまとめ、ローカルの影響 gate 後に push する。無関係な判断は一つの PR に混ぜない。

momo-result の通常変更は `develop` 向け PR、切替専用の独立 patch / revert は release branch とする。選んだ内容を一つの release branch に固め、`master` 向け release PR を更新する。merge 前に最新 develop / master との**マージ予定結果**を隔離して build・主要操作・復旧経路を確認する。exact master commit の CI と image 証拠は merge 後に必要で、その時点で候補を固定する。momo-db / Summit も各 branch 規約を守る。merge 後の修正は新 commit / image と必要な PR・gate を受け入れ、古い証拠を付け替えない。

| 変更 | 新たに必要な確認 |
| --- | --- |
| 文書・運用手順のみ | 参照先、手順と実装、差分を確認する。実行候補が同一なら consumer smoke は増やさない。ただし rehearsal CLI は **commit SHA 全体**を固定するため、momo-db の文書 commit 後も既存 manifest では続行できず、新 run が必要。運用文書は高価な一巡前に固める。 |
| DB SQL・schema・変換契約・比較器・rehearsal 実装 | 変更点の fixture / build / DB gate の後、新しい clean commit で DB 全件比較する。保存 archive は source 同一性・取得時刻が用途に合う場合だけ新 run へ import できる。移行後 schema・保存値・role の同一性を証明できる場合だけ、無関係な consumer 操作の証拠を再利用する。 |
| Runtime / Worker / Summit のコード・設定・image | 影響 component の build・規約上の CI・変更した契約と業務操作・停止 / 復旧を確認する。DB 候補と復元 copy が同じなら DB 全工程は繰り返さない。digest が変われば実 image の接続・role・boot と影響する統合 smoke を通す。 |
| 停止・配備・証拠 runner のみ | 失敗分岐の fixture、隔離した停止 / 起動 / 再配備、証拠受渡しを通す。SQL / consumer 出力が同じと照合できれば無関係な業務 smoke は不要。momo-db commit が変われば SHA 制約に従う。 |
| 本番 source の保存行・sequence のみ | PR や image rebuild は不要。工程3の最終 backup と事前 baseline の差を分類し、選んだ P3 経路（短い経路なら一回の copy migration、代替なら全工程）と新しい入力に必要な対象操作を確認する。schema・role・接続先の差はこの行に含めない。 |

既存の PR / master CI が定める必須 job は省略しない。事前 run は稼働中 snapshot の検証であり、停止・最終 backup・本番適用・再開の証拠にはならない。旧 snapshot を再利用しても取得時刻と実データの新しさは変わらない。

## 工程3：宣言後の停止切替

工程2の合格記録と private runbook の担当・中止期限を手元に置き、次の順序で進む。各段階の不合格は工程3末尾の状態表に従う。**本番 SQL 前の中止**と**新規書込み・外部送信前の旧組復旧**を区別する。

### C1. 停止・凍結

利用者に案内し、受付、全 writer・scheduler・batch・外部配送を drain して停止する。自動再起動、旧 workflow rerun、手動操作を凍結する。

- **進行条件:** Machine・未完了処理・DB 接続で停止を実証した。
- **中止条件:** 停止できなければ backup へ進まない。後で書込み・再起動があれば backup と以後の証拠を失効させ、C1 から取り直す。

### C2. 最終 backup

停止中の source の ID・全保存値・参照・schema・ledger・sequence、role・接続先を最終基準として固定する。新しい backup を取り、復元 copy を実際に読む。

- **進行条件:** 復元 copy と source 基準の全件一致を確認した。旧 image の最終 copy 上での再起動を省く場合は P3 の条件もすべて満たした。
- **中止条件:** 復元不能・不一致・旧版の必要な対象操作を確認できない場合は本番 SQL を止める。

### C3. 最終データ判定

P3 の表で事前の復元 baseline と最終基準を分類する。

- **進行条件:** 完全一致なら固定候補の証拠を再利用できる。保存行 / sequence のみ変化したなら、選んだ P3 経路で最終 copy の migration・全件比較と必要な対象操作を通した。
- **中止条件:** 構造等の差、分類不能、結果不明、実測上限超過があれば本番 SQL を止める。

### C4. SQL 直前 gate・適用

承認を始める前に、停止継続、復元可能な backup、最終データの移行証拠、固定 commit / profile・3 ref、接続先、`0000`–`0072` ledger、中止期限・復旧余裕を再照合する。承認後も同じ保護 job の中で、停止証拠、接続先、ledger、schema・role、source の最終基準との一致を preflight で確認し、異なれば SQL 前に閉じて止まる。**現状は書込みを技術的に封じる fence がないため、job は SQL 直前に source の全保存値・sequence を再照合する。** 最終基準から SQL まで正規 migrator 以外の書込みを封じ、role / schema の比較契約も保つ検証済みの fence が将来成立した場合だけ、fence 証拠と ledger / sequence / 接続状態の照合へ置き換えられる。

- **進行条件:** 承認前 gate の合格後に `production-db` を承認し、`CI Actions` job 内の preflight・直前再照合・正規 migrator を順に通した。
- **中止条件:** gate 不合格なら承認しない。SQL の失敗・結果不明なら read-only 状態判定を行い、同じ job を盲目的に rerun しない。

### C5. DB 保全・配備

本番の target ledger・schema・全保存値・参照・sequence を最終基準と許容された変換契約で照合する。合格後、Summit、momo-result Runtime / Worker の順に固定 digest を maintenance 状態へ component 別に配備する。

- **進行条件:** 各実 Machine の digest・設定、接続先・login role・target ledger、readiness、既存行の代表的な**読取り**、停止維持を確認した。
- **中止条件:** DB 不合格なら配備しない。配備途中の失敗は component 状態を読んで不足箇所から再開する。入口を開く前の書込み・外部送信は事故として扱う。

### C6. 再開・監視

DB と全 consumer が同じ組で合格したら、受付、処理、配送と必要な分析保守を明示的に開き、最初の業務結果と監視を確認する。分析保守が DB を更新するなら、その開始も復旧境界である。

- **復旧境界:** 新規書込み・外部送信の前と証明できる場合だけ旧組復旧を選ぶ。発生または不明なら現在のデータを守る forward fix へ移る。

### 中断・再配備時の状態判定

| 観測した状態 | 次の操作と再確認 |
| --- | --- |
| 停止・backup 後、SQL 前に中止 | DB が baseline で最終基準のままか読み、旧 Machine / image と role・接続先を照合して再開する。元 DB に変更がなければ backup restore や全 CI を繰り返さない。 |
| SQL job が失敗・結果不明 | read-only で実 ledger・schema・保存値・sequence を分類する。baseline かつ最終基準どおりなら固定候補の保護付き job を実行できる。target かつ全件保全済みなら SQL を再実行せず C5 へ進む。部分適用・不明・比較不合格は停止し、事前検証した復旧を選ぶ。 |
| DB は target・全件保全済み、配備は途中、書込み・配送は閉じていると証明できる | Machine ごとに digest・設定・停止 / 起動状態、DB 接続、失敗 step を読む。完了した component は触らず、未配備なら同じ digest を配備し、配備済みなら不足した read-only 確認から再開する。必要な approval・排他を通し、実 image / role / ledger / readiness / 読取りを確認する。build・全 CI・DB リハーサルは繰り返さない。commit / digest / 設定が変わった、artifact がない、固定 master が先へ進んだ場合は候補を再選定する。 |
| 新規書込み・外部送信の前と証明でき、旧組へ戻す | 最終 backup を復元し、旧 ledger・schema・全保存値・参照・sequence・role を照合する。事前に起動検証した旧 image の digest・設定を再配備し、実接続先・起動・readiness・代表的な読取りを確認してから開く。旧版の全 CI / browser / OCR / 業務 smoke は繰り返さない。 |
| 新規書込み・外部送信が発生、または有無を証明できない | 受付・処理・配送を止め、現在の DB と外部副作用を保全・分類する。最終 backup へ巻き戻さず、新規データを守る forward fix と個別の再開確認を行う。 |

P1 の実装には component 別の停止・配備・停止状態への旧版復元と、最終 source を照合する SQL guard を含める。SQL guard は P3 が作る最終証拠を必須とし、証拠の producer と停止後の状態分類・全件比較はまだ利用可能ではない。P1 の隔離試験だけで本番宣言をせず、P3 の実コピーでの故障試験も通す。DB の短い経路だけが未完成なら、停止・source guard と現行 CLI 全工程を実測・予算化した代替経路を採用する。

## 工程4：完了後

最終 SHA、run / attempt、比較結果、復旧候補、未確認範囲を記録する。release 専用 patch は develop 向け PR に反映し、一時 workflow・配備 script を撤去する。本番 migration、全 consumer の切替、再開と安定確認までを完了条件とし、ローカルテストや事前 merge だけで完了扱いにしない。
