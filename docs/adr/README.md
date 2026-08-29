# momo-db ADR Index

`ponta2git/momo-db` の設計判断を記録した ADR 集。

## Index

| ID | Title | Status | Date | Tags |
|---|---|---|---|---|
| [0001](./0001-neon-drizzle-stack.md) | Neon PostgreSQL + Drizzle を共有 DB スタックとして採用 | accepted | 2026-04-29 | db, ops |
| [0002](./0002-extracted-from-summit.md) | DB 管理を summit から momo-db リポジトリに分離 | accepted | 2026-04-29 | db, ops |
| [0003](./0003-github-actions-ci-neon-migration.md) | GitHub Actions で CI + Neon migration の自動化 | superseded | 2026-04-29 | ci, ops, db |
| [0004](./0004-production-migration-approval.md) | Production migration に human approval を必須化 | accepted | 2026-08-11 | ci, ops, db |

## Format

MADR（Markdown Architectural Decision Records）形式。frontmatter に `adr` / `title` / `status` / `date` / `tags` を含める。
