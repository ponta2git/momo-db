# momo-db

Discord Bot プロジェクト群（summit / momo-result）が共有する PostgreSQL スキーマ定義とマイグレーション管理リポジトリ。

設計判断の記録は [`docs/adr/`](./docs/adr/README.md) を参照。

## CI / CD

master push 時に GitHub Actions が自動実行される。

| ジョブ | 条件 | 内容 |
|---|---|---|
| `Build & Check` | 常に実行 | `pnpm build` + `drizzle-kit check` |
| `Migrate Neon` | `drizzle/` に変更がある場合のみ | `drizzle-kit migrate`（Neon 本番 DB に適用） |

### GitHub Secret の設定

`NEON_DIRECT_URL` を GitHub リポジトリの Secret として登録する必要がある。

1. [Neon Console](https://console.neon.tech) を開く
2. 対象プロジェクト → **Connection Details** → **Direct connection**（Unpooled）をコピー
3. GitHub リポジトリ → **Settings → Secrets and variables → Actions → New repository secret**
4. Name: `NEON_DIRECT_URL`、Value: 手順2でコピーした接続文字列を貼り付けて保存

> **重要**: `NEON_DIRECT_URL` が未設定の状態で push すると CI が失敗する。
> 先に Secret を登録してから push すること。

## セットアップ

```bash
cp .env.example .env.local
# .env.local の DIRECT_URL を設定する（Neon unpooled 接続文字列）
pnpm install
pnpm build
```

## スクリプト

| コマンド | 説明 |
|---|---|
| `pnpm build` | TypeScript をコンパイルして `dist/` を生成 |
| `pnpm db:up` | ローカル postgres コンテナを起動（`compose.yaml`） |
| `pnpm db:down` | ローカル postgres コンテナを停止 |
| `pnpm db:generate` | スキーマ変更から新マイグレーション SQL を生成 |
| `pnpm db:migrate` | 未適用のマイグレーションを DB に適用 |
| `pnpm db:check` | マイグレーションの整合性チェック |

## ローカル開発（postgres コンテナ使用）

```bash
# 1. postgres コンテナを起動（初回のみ）
pnpm db:up

# 2. マイグレーションを適用
pnpm db:migrate

# 3. 消費プロジェクト側で seed を実行（例: summit）
cd ../summit && pnpm db:seed
```

> **Note**: `compose.yaml` は postgres 16 コンテナをポート 5433 で公開する。
> ローカルの `.env.local` には `DIRECT_URL=postgres://...@localhost:5433/...` を設定すること。

### summit のセットアップから一括実行する場合

summit の `pnpm setup` が momo-db の全 DB セットアップを自動的に呼び出す（`db:up` → `db:migrate` → summit `db:seed`）。

## スキーマ変更手順

1. `src/schema.ts` を編集
2. `pnpm db:generate` で差分 SQL を生成（`drizzle/` に追記される）
3. 生成された SQL をレビュー
4. `pnpm db:migrate` で適用
5. `pnpm build` で `dist/` を再生成
6. 消費プロジェクトで `pnpm install` を再実行（`@momo/db` の dist/ を更新）

## 本番 migration

migration は master push 時に CI が自動適用する（`drizzle/` に変更がある場合のみ）。
緊急時など手動で実行する場合：

```bash
# DIRECT_URL を本番の unpooled 接続文字列に設定して実行
DIRECT_URL=postgres://... pnpm db:migrate
```

> **重要**: スキーマ変更を伴う消費プロジェクトの deploy 前に必ず適用すること。

## 利用プロジェクト

- **summit**: `"@momo/db": "file:../momo-db"` でローカル依存として参照
- **momo-result**: 同様に `file:../momo-db` で参照（予定）

## 環境変数

| 変数 | 用途 |
|---|---|
| `DIRECT_URL` | drizzle-kit 専用の unpooled 接続 URL（migration/generate/check） |
