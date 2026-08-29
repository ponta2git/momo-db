---
adr: 0004
title: Production migration に human approval を必須化
status: accepted
date: 2026-08-11
supersedes: [0003]
superseded-by: null
tags: [ci, ops, db]
---

# ADR-0004: Production migration に human approval を必須化

## TL;DR

`drizzle/` を変更した master push は、build / check の成功だけでは production DB へ適用しない。protected environment `production-db` で対象 commit の human approval を得た後にだけ、接続 preflight と migration を実行する。

## Context

ADR-0003 は、review 済み migration を master push 後に自動適用する方針だった。しかし共有 DB の migration は summit と momo-result の両方へ影響し、merge 時点と安全な適用時点が常に同じとは限らない。backup、consumer compatibility、適用対象 commit を人が最終確認できる境界が必要になった。

## Decision

`.github/workflows/ci.yml` を三段階にする。

1. `Build & Check` が build と migration history check を行う。
2. `drizzle/` に変更がある場合だけ、`Approve production migration` が environment `production-db` の required reviewer approval を待つ。
3. 承認成功後、`Migrate Neon` が direct connection の preflight を通し、直列化した migration を実行する。

approval は対象 Git commit に対して行う。却下、未承認、branch policy 不一致、preflight 失敗のいずれでも migration は実行しない。通常運用で別経路の手動 migration により gate を迂回しない。

## Consequences

- master へ入っただけでは production schema は変わらない。consumer deploy は migration の承認・完了を待つ。
- approver は custom SQL、データ保持、backup、consumer compatibility、対象 commit を確認する。
- CI 自体を復旧できない緊急時だけ、同じ変更内容への明示承認と同等の preflight を揃え、README の手動手順を使う。
- `production-db` environment の required reviewer と branch policy は migration safety の一部であり、workflow YAML だけでは代替できない。

## Alternatives considered

- **master push 後の無承認自動適用** — 適用時点のデータ・consumer 状態を確認できないため廃止。
- **migration の常時手動実行** — 実行経路と履歴が分散するため不採用。
- **approval 後も接続 preflight を省略** — 誤った production branch / role への接続を検出できないため不採用。
