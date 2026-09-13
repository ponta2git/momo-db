# AGENTS.md

momo-db は summit / momo-result が共有する PostgreSQL schema と migration、`@momo/db` の公開型を所有する。

## 作業に応じた参照先

| 作業 | 読む文書 |
| --- | --- |
| `src/schema.ts`、`drizzle/`、Drizzle の設定・script、DB の schema / migration state の変更 | 変更前に [`docs/development.md`](./docs/development.md) を最初から最後まで読む |
| 通知の型・ID・payload、保存契約、consumer との更新境界の変更 | [`docs/discord-notifications.md`](./docs/discord-notifications.md) |
| セットアップ、コマンド、CI の確認 | [`README.md`](./README.md) の該当節 |
| 本番接続先・credential の更新 | [`docs/ops/neon-production-connection-rotation.md`](./docs/ops/neon-production-connection-rotation.md) |
| 規約・エージェント向け指示の変更 | [`docs/agent-instructions.md`](./docs/agent-instructions.md) |

複数に該当する変更は、それぞれの文書を参照する。ADR と `docs/plans/` は判断の背景や当時の計画を調べるときに読む。

DB 変更の規範は `docs/development.md` に集約する。README・ADR・実装との矛盾を見つけたら、矛盾に依存する変更・生成・適用を止め、該当箇所と後続の決定を照合する。どちらが正しいか確定できなければ、根拠と必要な判断をユーザーに示す。独立した調査や修正は進めてよい。

## 実行範囲と完了

- 依頼された変更、必要な検証、変更に起因する不具合の修正まで進める。通常の可逆なローカル編集や検証は都度確認せず、依頼と既存の合意から実装方法を判断する。
- 検証は変更の影響に合わせる。文書のみなら参照先・記載内容・差分の確認、TypeScript の変更なら `pnpm build` と影響するテストを行う。DB 変更の必須 gate は `docs/development.md` に従う。通過後は、新しい変更・失敗・未解決の懸念があるときに追加検証する。
- DB テストは[専用 DB の条件](./docs/discord-notifications.md#専用-db-での検証)を満たす場合、準備・実行・修正・再実行・自身の一時資源の後始末まで進めてよい。保存対象の `summit-postgres` や named volume を検証用に初期化しない。
- 本番適用・データ破壊・復旧は `docs/development.md` の判断条件と承認経路に従う。承認が必要な場合も、先に進められる実装・検証・手順の準備を済ませる。
- secret や接続 URL の実値を文書、commit、ログへ出さない。例には placeholder を使う。
- 完了報告は変更結果、実施した検証と結果、残る作業を簡潔に示す。未実施の検証や consumer の確認を成功扱いにしない。

## Linear と PR

- Linear チケットの実装と必要な確認が完了し、PR の merge をもって Done にする場合、PR 本文に `Fixes <issue ID>` を記載する。
- `Refs <issue ID>` は、merge 後も追加作業または受け入れ確認が残る場合だけ使用する。
