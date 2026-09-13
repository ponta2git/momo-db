# momo-db ADR Index

`ponta2git/momo-db` の設計判断を記録した ADR 集。

ADR は判断の理由と当時の方式を残す。`accepted` の ADR に含まれる個別手順も後続の決定で変わり得るため、現在の DB 作業には [development.md](../development.md)、通知の責務には [共有通知契約](../discord-notifications.md) を使う。

## Index

| ID | Title | Status | Date | Tags |
|---|---|---|---|---|
| [0001](./0001-neon-drizzle-stack.md) | Neon PostgreSQL + Drizzle を共有 DB スタックとして採用 | accepted | 2026-04-29 | db, ops |
| [0002](./0002-extracted-from-summit.md) | DB 管理を summit から momo-db リポジトリに分離 | accepted | 2026-04-29 | db, ops |
| [0003](./0003-github-actions-ci-neon-migration.md) | GitHub Actions で CI + Neon migration の自動化 | superseded | 2026-04-29 | ci, ops, db |
| [0004](./0004-production-migration-approval.md) | Production migration に human approval を必須化 | accepted | 2026-08-11 | ci, ops, db |

## Format

MADR（Markdown Architectural Decision Records）形式。frontmatter に `adr` / `title` / `status` / `date` / `tags` を含める。

決定を置き換える場合は後継 ADR と `supersedes` / `superseded-by`、この一覧を対応させる。一部の運用だけが変わった場合は、該当 ADR の冒頭に変更範囲と現在の参照先を追記し、当時の理由を消さない。現行の手順は規範文書へ反映する。
