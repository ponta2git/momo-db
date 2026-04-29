---
adr: 0003
title: GitHub Actions で CI + Neon migration の自動化
status: accepted
date: 2026-04-29
supersedes: []
superseded-by: null
tags: [ci, ops, db]
---

# ADR-0003: GitHub Actions で CI + Neon migration の自動化

## TL;DR

`origin/master` への push 時に GitHub Actions で TypeScript ビルドと drizzle-kit check を実行し、
`drizzle/` ディレクトリに変更がある場合のみ Neon 本番 DB へ自動 migration する。

## Context

ADR-0001 では「generate → SQL レビュー → migrate」のフローを定義したが、migrate の実行は手動だった。
migration ファイルは PR でレビュー済みであるため、master merge 後に CI が自動適用する運用に変更する。

Forces:
- migration ファイルは PR でレビューされ master に入るため、merge 後に即座に適用してよい。
- `drizzle-kit migrate` は idempotent（適用済み migration は skip）なため冪等性は保たれる。
- ただし DDL は並行実行で競合するため、migration job はシリアライズが必要。
- CI 環境には `.env.local` が存在しないため、既存の `db:migrate` スクリプト（dotenv 経由）は使えない。

## Decision

### ワークフロー構成（`.github/workflows/ci.yml`）

2ジョブ構成とする。

1. **`ci` ジョブ**（常に実行）
   - `pnpm build`: TypeScript コンパイル
   - `pnpm db:check:ci`: migration ファイルの整合性チェック
   - push 範囲全体（`github.event.before` → `github.sha`）で `drizzle/` の変更を検出し、
     次ジョブに `drizzle_changed` output として渡す。

2. **`migrate` ジョブ**（`ci` 成功後、`drizzle/` 変更がある場合のみ）
   - `pnpm db:migrate:ci`: 未適用 migration を Neon に適用
   - `concurrency: group: neon-migrate, cancel-in-progress: false` で migration をシリアライズし、
     並行 DDL による競合を防ぐ。

### CI 用スクリプト追加

dotenv-cli（`.env.local` 参照）を使わない CI 専用スクリプトを `package.json` に追加する。

```json
"db:check:ci": "drizzle-kit check",
"db:migrate:ci": "drizzle-kit migrate"
```

ローカル開発では従来の `db:check` / `db:migrate`（`.env.local` 経由）を使い続ける。

### GitHub Secret

`NEON_DIRECT_URL`（Neon direct / unpooled 接続 URL）を GitHub Secrets に登録する。
ワークフロー内で `DIRECT_URL` 環境変数にマッピングし、`drizzle.config.ts` が参照する。

### 変更検出

`git diff --name-only "$BEFORE" "$AFTER" -- drizzle/` で push 範囲全体を比較する。
`HEAD~1` は multi-commit push で最後の 1 commit しか見ないため使用しない。
`fetch-depth: 0`（full history fetch）で両 SHA を確実に取得する。

## Consequences

- master push 後、`drizzle/` に変更があれば Neon 本番 DB に自動適用される。
  消費プロジェクトの deploy 前に migration が完了している状態を保つ。
- `NEON_DIRECT_URL` が未設定の場合は CI が失敗する（意図した動作）。
- migration を手動で実行する場合は `DIRECT_URL=... pnpm db:migrate` を引き続き使える。
- `drizzle-kit check` は `drizzle.config.ts` ロード時に `DIRECT_URL` が必要なため、
  CI job でも `NEON_DIRECT_URL` secret が必要となる。

## Alternatives considered

- **手動 migration のまま**: レビュー済み migration の適用を忘れるリスクがあり、
  消費プロジェクト deploy 前に不整合が起きうる。
- **PR 時に migration**: マージ前の環境に適用するのは複雑でリスクが高い。
- **Neon branch を使った staging 適用**: より安全だが、個人プロジェクト規模の運用コストに対して重い。
- **`workflow_dispatch` + 手動承認**: migration の即時適用を求めるため不採用。
