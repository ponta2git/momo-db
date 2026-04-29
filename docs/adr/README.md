# momo-db ADR Index

`ponta2git/momo-db` の設計判断を記録した ADR 集。

## Index

| ID | Title | Status | Date | Tags |
|---|---|---|---|---|
| [0001](./0001-neon-drizzle-stack.md) | Neon PostgreSQL + Drizzle を共有 DB スタックとして採用 | accepted | 2026-04-29 | db, ops |
| [0002](./0002-extracted-from-summit.md) | DB 管理を summit から momo-db リポジトリに分離 | accepted | 2026-04-29 | db, ops |

## Format

MADR（Markdown Architectural Decision Records）形式。frontmatter に `adr` / `title` / `status` / `date` / `tags` を含める。
