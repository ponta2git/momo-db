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

## 検証と復旧

専用 migration テストは fresh DB、dump / restore した代表履歴、JavaScript 安全整数範囲を超える fence、global・active・retained attempt の各最大値、保存済み running 行、全旧行・DB 機構の保持、拒否時 rollback、writer との lock 競合、通常 migrator の二回目の no-op を検証する。consumer の成功 claim・renew・finish・recover・旧 owner 拒否は consumer の DB integration gate で確認する。実データ copy には同じ source ごとの seed 比較を行う。

本番で再開する前に戻す場合は停止直後の backup と対応する旧 consumer を復元する。migration ledger だけを削除しない。再開後は新規 attempt と発行済み counter を保護する forward fix を原則とする。
