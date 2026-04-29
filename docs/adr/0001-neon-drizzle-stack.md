---
adr: 0001
title: Neon PostgreSQL + Drizzle を共有 DB スタックとして採用
status: accepted
date: 2026-04-29
supersedes: []
superseded-by: null
tags: [db, ops]
---

# ADR-0001: Neon PostgreSQL + Drizzle を共有 DB スタックとして採用

## TL;DR

discord bot プロジェクト群（summit / momo-result）の共有 DB として Neon PostgreSQL 16 を採用し、スキーマ管理・migration ツールに Drizzle ORM + drizzle-kit を使う。

## Context

複数プロジェクトが参照する共有 DB スタックの選定。

Forces:
- アプリは低トラフィックだが、同時ボタン押下などの更新競合が起きるため適切な transaction 制御が必要。
- Serverless PostgreSQL を使う場合、pooled 接続と direct 接続を用途別に分離しないと migration 経路混同や prepared statement キャッシュ衝突が起きる。
- migration は生成 SQL をレビューしてから適用する運用にしたい（`push` による直接反映は避ける）。
- TypeScript 型との親和性が高い ORM を選びたい。

## Decision

### DB

- **Neon PostgreSQL 16**: branching / scale-to-zero / Serverless ドライバを備え、個人プロジェクト規模のコスト・運用負担に適合する。

### ORM / migration

- **Drizzle ORM + postgres.js**: TypeScript ファーストの型推論、SQL に近い記述、drizzle-kit による migration 管理が揃っている。
- アプリ接続は `DATABASE_URL`（Neon pooled / transaction pooling）、`postgres(url, { prepare: false })` を必須指定（pooler 互換）。
- migration 接続は `DIRECT_URL`（Neon direct / unpooled）。`drizzle.config.ts` **のみ**で参照する。

### Migration フロー

固定フロー: `drizzle-kit generate` → `drizzle/` 差分 SQL レビュー → `drizzle-kit migrate`。**`drizzle-kit push` は禁止**（履歴性・再現性が失われるため）。

## Consequences

- スキーマを変更する際は `pnpm db:generate` → SQL レビュー → `pnpm db:migrate` → `pnpm build` の順に進める。
- `DIRECT_URL` を `.env.local` に設定しないと `drizzle-kit` コマンドが失敗する。

## Alternatives considered

- **Supabase Postgres** — Auth 等の周辺機能を使わず、Neon の branching・コスト面が優位。
- **SQLite** — 将来的な戦績集計やマルチプロジェクト共有に不向き。
- **Prisma** — 生成物サイズ・migration 運用の癖が重い。
- **pg（node-postgres）直叩き** — スキーマ型と migration の自前管理コストが高い。
