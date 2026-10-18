# 分析ジョブの永続 fencing counter

`series_analysis_jobs.fencing_counter` は job ごとの発行済み fence の上限を保持する `bigint NOT NULL DEFAULT 0 CHECK (fencing_counter >= 0)` である。`@momo/db` の `fencingCounter` は JavaScript `bigint`、Rust consumer は `i64` として扱う。新規 job は 0 から始める。

claim が成功する transaction 内で counter を checked 加算し、同じ値を active lease と attempt に記録する。renew、finish、lease recovery は counter を減らさず、次回 claim で再び加算する。最大値に達した job は新しい lease を発行しない。job・attempt・owner を含む所有権の比較は維持する。

## Expansion と切替

| Migration | 種別 | 役割 |
| --- | --- | --- |
| `0078_lock-analysis-fencing-expansion` | custom | global slot・job・attempt を NOWAIT で lock し、seed 元の境界を検査 |
| `0079_add-analysis-fencing-counter` | schema 生成 | bigint 列・default・NOT NULL・CHECK を追加 |
| `0080_seed-analysis-fencing-counter` | custom | job ごとに `greatest(0, global slot fence, active lease fence, retained attempt max)` を設定 |

tail 全体を通常の migrator の一つの transaction で適用する。global slot の欠落、負の元 fence、加算余地のない最大値、既に使われた新 counter は診断コードで拒否する。lock の競合は変更前に失敗し、writer 停止を確認して再試行する。旧 writer の lock 順序との待合せを避けるため、table lock に `NOWAIT` を使う。

writer 停止の実証は P0 writer inventory / frozen / CI guard で行う。SQL の lock は入力値を固定するもので、process 停止の証明にはしない。process 停止後に残る `running` 行は有効な保存状態であり、active lease、attempt、global slot と他の全旧値を保持する。

**backfill 後は新 consumer 切替完了まで旧 claim writer を再開しない。** 停止切替は [正規手順](development.md#6-適用と-release-順序) に従う。この expansion では `worker_execution_slots` を維持する。global slot を廃止する段階では、切替直前に同じ seed を再計算するか、その前に各 claim が新 counter を global fence 以上へ同一 transaction で更新する consumer を全 writer へ配布する。expansion 時点の seed だけで、旧 global claim が再開した後の安全性を保証しない。

## Shared slot の廃止

P3 の UUID 切替 `0093` までは slot と全保存値を保持する。両 consumer の job ごとの claim / renew / finish / recover、旧 owner 拒否、slot table が無い DB での動作を確認した後、独立した tail で廃止する。

| Migration | 種別 | 役割 |
| --- | --- | --- |
| `0094_reseed-before-worker-slot-retirement` | custom | slot・job・attempt を NOWAIT で lock し、境界を再検査して `greatest(現在の counter, 0, global slot, active lease, retained attempt max)` を再設定 |
| `0095_retire-worker-execution-slots` | schema 生成 | `worker_execution_slots` と公開 export `workerExecutionSlots` を廃止 |

二つを正規 migrator の同じ transaction で適用する。発行済み counter は減らさず、新 consumer が既に使った値も保持する。job、lease、attempt、OCR、通知、凍結 artifact のほかの保存値は変えない。停止後に残る running 行を消す条件は設けない。global slot の欠落、負の元 fence、加算余地のない最大値、lock 競合は変更前に拒否する。

Drizzle Kit が生成する `DROP TABLE ... CASCADE` は、この削除で宣言していない依存先を巻き込まないよう `DROP TABLE` の RESTRICT 動作へ局所補正した。Drizzle schema に drop の cascade 方針を宣言する設定がなく、変更対象をこの table に限定するためである。未知の view・FK 等があれば、reseed と ledger 行の追加も含めて rollback する。journal と snapshot は生成結果を保持する。

slot row は意図した廃止対象であるため、停止直後の復元可能な archive に全列を保全する。最終切替には所有者の廃止判断、writer freeze、固定 consumer の no-slot gate と復旧確認が必要になる。SQL は process 停止の証明を代行しない。旧 consumer を戻すときは slot を含む旧 DB 全体と対応版を復元する。

## 検証と復旧

専用 migration テストは fresh DB、dump / restore した代表履歴、JavaScript 安全整数範囲を超える fence、global・active・retained attempt の各最大値、保存済み running 行、全旧行・DB 機構の保持、拒否時 rollback、writer との lock 競合、通常 migrator の二回目の no-op を検証する。consumer の成功 claim・renew・finish・recover・旧 owner 拒否は consumer の DB integration gate で確認する。実データ copy には同じ source ごとの seed 比較を行う。

retirement gate は `0093` の復元 copy で上記を再検証し、全列の変更が counter の再計算と slot table の廃止だけであることを確認する。`canonical-identities-retired-slots-v1` profile は旧 `0072` source からの全変換、元 slot の全列 fingerprint、残る全列・schema、正確な ledger tail、二回目の無変更と archive からの復旧を検証する。

後段で失敗すると、PostgreSQL の [`nextval`](https://www.postgresql.org/docs/18/functions-sequence.html) が消費した ledger sequence の番号は戻らない。失敗テストはこの既知の一番号消費を明示的に検査し、schema・全保存行・ledger 行・ほかの sequence が戻ることを確認する。rehearsal の厳密な sequence 比較は緩めず、失敗した migration copy には fresh run を使う。

本番で再開する前に戻す場合は停止直後の backup と対応する旧 consumer を復元する。migration ledger だけを削除しない。再開後は新規 attempt と発行済み counter を保護する forward fix を原則とする。
