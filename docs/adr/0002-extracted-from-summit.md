---
adr: 0002
title: DB 管理を summit から momo-db リポジトリに分離
status: accepted
date: 2026-04-29
supersedes: []
superseded-by: null
tags: [db, ops]
---

# ADR-0002: DB 管理を summit から momo-db リポジトリに分離

## TL;DR

momo-result プロジェクトとの DB 共有に備え、スキーマ定義・migration・drizzle.config.ts を summit リポジトリから本リポジトリ（momo-db）に移設した。summit は `"@momo/db": "file:../momo-db"` でパッケージ参照する。

## Context

もともと summit リポジトリに `src/db/schema.ts` / `drizzle/` / `drizzle.config.ts` を内包していた（summit の ADR-0003）。momo-result プロジェクトが同じ Neon PostgreSQL インスタンスを参照することになり、各プロジェクトが独立して schema 変更・migration を計画できる構造が必要になった。

## Decision

- schema・migration の所有権を本リポジトリ（momo-db）に集約する。
- 消費プロジェクト（summit 等）は `"@momo/db": "file:../momo-db"` でローカル依存として参照し、`import { ... } from "@momo/db"` でスキーマ型を取得する。
- momo-db は `pnpm build`（`tsc`）で `dist/schema.js` + `dist/schema.d.ts` を生成して提供する。
- summit の `src/db/schema.ts` は `export * from "@momo/db"` の 1 行 re-export shim になる（downstream の import パスは変更不要）。
- migration の実行タイミングは momo-db の責務。各消費プロジェクトの deploy と独立して適用する。

## Consequences

- スキーマ変更後は momo-db で `pnpm db:generate` → SQL レビュー → `pnpm db:migrate` → `pnpm build` を実行し、消費プロジェクトで `pnpm install` を再実行する。
- summit の CI integration-db job は momo-db をチェックアウトして `pnpm db:migrate` を実行する。
- summit の Fly deploy には `release_command` がなくなる。本番 migration は deploy 前に momo-db から手動適用すること。

## Alternatives considered

- **モノレポ（pnpm workspace）** — summit / momo-result が別 git リポジトリのため採用しない。
- **npm publish / private registry** — ローカル `file:` リンクで十分。publish 運用コストを避ける。
- **summit にスキーマを残し momo-result がコピー** — 二重管理になり drift が起きやすい。

## Links

- @see summit/docs/adr/0049 (summit 側から見た同じ決定の記録)
