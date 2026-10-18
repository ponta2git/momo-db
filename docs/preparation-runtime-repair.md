# PREPARING 中の Runtime 接続証跡修復

`preparation-runtime-repair` は、旧 schema の準備 release に不足した Runtime の実接続・全 ledger 証跡だけを補う限定操作である。通常 deploy、DB 適用、Worker / Summit 配備、analysis、Release 発行の許可には使えない。通常業務が継続する `PREPARING` のまま実施し、全 writer 停止や新 schema 配備を完了したとは記録しない。

対象 source は[固定 manifest](../scripts/maintenance/preparation-runtime-repair-source.json)の base、10 file の before / after blob、source tree、外部 pin、Worker tree に限定する。source SHA と workflow SHA は別に扱う。実運用の旧 Runtime / Worker / Summit image digest も検証器に固定する。別の修復には、通常のレビューによるコード変更が必要である。

## 前提と証拠

- control は `PREPARING`、`candidates: null`、既存 evidence / permit が空、未 invalidation である。
- 3 app とも machine は各 1 台で、全 identity / config / boot / secret metadata と実 normal process status を取得する。secret はすべて `Deployed` とし、永続 mode と daemon は通常状態である。
- environment 3 件の exact cutover branch、既存承認条件、bypass 禁止、control ref の保護と一人の更新主体、publisher 無効化を維持する。3 repository の全 incomplete run を調べ、実際の修復 execution tuple 以外は存在しない。部分的な API 応答は失敗とする。
- 固定 producer の candidate run / attempt が成功し、未失効 artifact の ID / digest、source、Runtime archive / config / rootfs digest が一致する。candidate と deploy は別 run ID を使う。
- 実 snapshot から作った旧 schema の copy 2 件で、候補 Runtime と実際の旧 Worker / Summit を使う。各 consumer は初回と同じ owned container の実再起動 2 回で、永続 frozen 設定、閉じた通常経路、実接続 target / 全 ledger を検証する。合計は `2 copies × 3 consumers × 3 boots = 18 observations`。通常動作、schema / ledger / 全保存値の保全も別 report で検証する。

`scripts/maintenance/preparation-repair.mjs` が strict field の検証器であり、未知の field を拒否する。公開 receipt には source / workflow SHA、run / attempt、digest、時刻、既存の公開 control record だけを入れる。machine ID、image ref、設定、env、boot ID、secret 名、接続 URL、保存値は非公開元証拠に保持する。

`observePreparationRepair` は全 provider identity、secret metadata、daemon の実 process status を検証して digest に変換する。`identityDigest` は events を含む identity 全体、`configWithoutImageDigest` は image だけを除いた config、`bootDigest` は machine / instance / boot、`secretDigest` は sorted name / digest / status、`normalWritersDigest` は writer 名 / stage / active status を固定する。通常運転中に変わる in-flight 件数は含めない。

| receipt field | 内容 |
| --- | --- |
| `baselineControl` | 許可前の実 head と公開 record。grant commit 自身を含めず、その親 commit で結び付ける |
| `candidate` / `producer` | 固定 source と別の workflow SHA、成功 candidate run / attempt、artifact ID / digest、candidate digest、archive SHA-256、image config digest、rootfs layer 配列の canonical digest |
| `baseline` | 3 role の正規化 identity digest、旧 DB の実 connection proof、GitHub barrier digest |
| `copyProof` | 固定 Runtime candidate、旧 Worker / Summit の実 production image digest、source DB proof、snapshot / source identity / schema / 全 ledger / 全保存値、normal / frozen / restart / preservation の report digest、18 observation の件数と成功 |
| `execution` | bind が現在の GitHub context から付ける repository / workflow / cutover ref / SHA / run / attempt |
| `deadline` | mutation と完了登録の UTC 期限 |

copy の peer image は local tag だけで判断せず、実 archive、image config と producer / build evidence を通じて `baseline.machines.worker.imageDigest` / `summit.imageDigest` に結び付ける。digest だけで元証拠の真偽が証明されるとは扱わず、operator は非公開元証拠を照合する。

## 通常運転中の DB 観測

固定 Worker image の読取り専用子 process から実接続 proof を取得できる。この image の実 command は次のとおりである。

```text
/momo-toolbox/env MOMO_MAINTENANCE_MODE=frozen /usr/local/bin/momo-processing-worker bootstrap -- maintenance-readiness
```

子 process の環境指定は永続 config / secret を変更しない。採用するのは応答の `database` だけであり、その mode や frozen readiness を daemon 停止の証拠へ使わない。前後の全 3 app identity / config / boot / secret、Worker daemon PID と実 normal status を照合する。copy の frozen 再起動試験にはこの環境指定を使わず、永続設定から起動する。

## 承認と実行

Result の専用 `.github/workflows/preparation-runtime-repair.yml` を exact `cutover/<id>` から使う。candidate mode で manifest を検証して archive を作り、その run を成功完了させる。operator は実 archive の copy 試験と元証拠を確認して deploy run の入力を準備する。JSON は mode `0600` とし、raw provider evidence は artifact / log へ出さない。

```text
pnpm maintenance:preparation-repair bind input.json receipt.json
pnpm maintenance:preparation-repair grant receipt.json
pnpm maintenance:preparation-repair guard receipt.json <grant-head> evidence.json registry-push
pnpm maintenance:preparation-repair guard receipt.json <grant-head> evidence.json runtime-update
pnpm maintenance:preparation-repair complete receipt.json <grant-head> completion.json
```

`bind` は実 execution tuple、producer、現在の control / barrier を確認する。workflow は receipt を immutable artifact として承認前に保存する。operator がその artifact と digest を確認して `grant` を実行し、既存 `production` environment の承認を受ける。generic `permit` ではこの操作を許可できない。grant head と、その親が receipt の baseline head であることを固定する。

専用 deploy job は既存の production concurrency を共有し、固定 archive の registry push と、既存 Runtime machine の image のみの更新を行う。各 mutation 直前の `guard` は producer、grant parent、GitHub barrier を再取得した後、mutable control を最後に読む。実 run / attempt、permit、deadline、90 秒以内の全 3 role 観測が一致しなければ停止する。Runtime 更新は同じ machine の lease / current instance と全 config の照合も併用する。

guard の evidence file は `{observation, registryProof}`。push 前の `registryProof` は `null`、更新前は実 registry image を読み返し、承認済み archive / image config / rootfs layers と同一であることを証明する。更新参照は実 immutable registry digest に固定する。

`complete` は operator が、成功 deploy run / attempt と未失効の `preparation-runtime-deployment-<run>-<attempt>` artifact、実 normal smoke、fresh provider 観測を確認して実行する。artifact 自身の ID / digest は循環を避けて本体へ入れず、GitHub で取得した `deploymentArtifact: {id,digest}` と完了直前の `freshObservation` を completion input に付加する。artifact の元 `observation` は保持し、fresh 観測との machine / database / barrier の完全一致を要求する。90 秒窓は fresh 観測に適用する。Runtime の image と boot 以外の設定・secret・machine・writer 集合、Worker / Summit 全体、旧 DB target / ledger と barrier が不変の場合だけ CAS する。

完了後も phase は `PREPARING`、候補は `null` のまま、epoch / stopEpoch を進め、permit を除去し、`preparationRepair` evidence digest を残す。その digest は後続の `pin` / `DRAINING` にも保持する。通常 deploy / publisher は閉じたまま、新 controller SHA と新 epoch で候補・復旧証拠・最終リハーサルを再作成する。未知の operation / evidence を読めない旧 controller は fail closed となるため、旧 controller pin や旧 package を再利用しない。

失敗や結果不明を自動 retry、normal guard の例外、手動 provider 更新、環境保護の解除で解消しない。途中証拠を保存し、実際の image / boot / control を検査する。既に permit または完了 evidence がある状態へ、同じ repair grant を再登録することはできない。
