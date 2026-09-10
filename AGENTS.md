# AGENTS.md

- `src/schema.ts`、`drizzle/`、Drizzle の設定・script、または DB の schema / migration state を変更する前に、[`docs/development.md`](./docs/development.md) を最初から最後まで読む。
- DB 変更の規範は `docs/development.md` に集約する。README や ADR と矛盾する場合は作業を止め、規範文書と実装のどちらが正しいかを確認する。
- secret や接続 URL の実値を文書、commit、ログへ出さない。

## Linear と PR

- Linear チケットの実装と必要な確認が完了し、PR の merge をもって Done にする場合、PR 本文に `Fixes <issue ID>` を記載する。
- `Refs <issue ID>` は、merge 後も追加作業または受け入れ確認が残る場合だけ使用する。
