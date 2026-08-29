# momo-db

Discord Bot プロジェクト群（summit / momo-result）が共有する PostgreSQL スキーマ定義とマイグレーション管理リポジトリ。

DB 変更前に、正規の開発手順 [`docs/development.md`](./docs/development.md) を必ず参照する。
設計判断の記録は [`docs/adr/`](./docs/adr/README.md) を参照。

## CI / CD

master push 時に GitHub Actions が自動実行される。

| ジョブ | 条件 | 内容 |
|---|---|---|
| `Build & Check` | 常に実行 | `pnpm build` + `drizzle-kit check` |
| `Approve production migration` | `drizzle/` に変更がある場合のみ | protected environment `production-db` で対象 commit の承認を待つ |
| `Migrate Neon` | 承認成功後 | 接続 preflight + `drizzle-kit migrate`（Neon 本番 DB に適用） |

### GitHub Environment Secret の設定

`DIRECT_URL` を GitHub Environment `CI Actions` の Secret として登録する必要がある。

1. [Neon Console](https://console.neon.tech) を開く
2. 対象プロジェクト → **Connection Details** → **Direct connection**（Unpooled）をコピー
3. GitHub リポジトリ → **Settings → Environments → CI Actions → Environment secrets**
4. Name: `DIRECT_URL`、Value: 手順2でコピーした接続文字列を貼り付けて保存

> **重要**: `DIRECT_URL` が未設定の状態で push すると CI が失敗する。
> 先に Secret を登録してから push すること。
> Neon project / production branch / DB role を再作成した場合、既存 Secret は自動更新されない。
> [`docs/ops/neon-production-connection-rotation.md`](./docs/ops/neon-production-connection-rotation.md) に従って同時に更新すること。

### Production migration approval の設定

GitHub Environment `production-db` には required reviewer と master だけを許可する deployment branch policy を設定する。workflow の `environment: production-db` だけでは承認待ちは保証されないため、Settings または GitHub API で protection rule の存在を確認する。reviewer の個人情報や環境設定の実値は repository に記録しない。

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
| `pnpm db:generate --custom --name=<purpose>` | Drizzle が表現できない DDL / data transition 用の空 migration を生成 |
| `pnpm db:migrate` | 未適用のマイグレーションを DB に適用 |
| `pnpm db:check` | マイグレーションの整合性チェック |
| `pnpm db:preflight:ci` | CI の migration 用 direct 接続を安全に検証 |

## ローカル開発（postgres コンテナ使用）

```bash
# 1. postgres コンテナを起動（初回のみ）
pnpm db:up

# 2. マイグレーションを適用
pnpm db:migrate

# 3. 消費プロジェクト側で seed を実行（例: summit）
cd ../summit && pnpm db:seed
```

> **Note**: `compose.yaml` は postgres 18 コンテナをポート 5433 で公開する。
> ローカルの `.env.local` には `DIRECT_URL=postgres://...@localhost:5433/...` を設定すること。
> postgres 18 は `momo-db_summit_postgres_data_v18` ボリュームを使う。
> postgres 18 公式イメージの推奨に合わせて、ボリュームは `/var/lib/postgresql` にマウントする。
> 旧 postgres 16 用の `momo-db_summit_postgres_data` が不要になった場合は手動で削除する。

### summit のセットアップから一括実行する場合

summit の `pnpm setup` が momo-db の全 DB セットアップを自動的に呼び出す（`db:up` → `db:migrate` → summit `db:seed`）。

## スキーマ変更手順

通常の schema migration と custom SQL migration の作り分け、履歴の不変性、検証、rollback は [`docs/development.md`](./docs/development.md) に従う。

変更後は `pnpm build` で `dist/` を再生成し、消費プロジェクトで `pnpm install` を再実行して `@momo/db` の成果物を更新する。

## 本番 migration

migration は master push 時の build / check 後、protected environment `production-db` で対象 commit が承認された場合だけ CI が適用する（`drizzle/` に変更がある場合のみ）。
CI 自体を復旧できず、同じ変更内容への明示承認と backup を確認済みの緊急時だけ、`DIRECT_URL` を安全な方法で環境変数へ注入して次を実行する。

```bash
pnpm db:preflight:ci
pnpm db:migrate:ci
```

> **重要**: スキーマ変更を伴う消費プロジェクトの deploy 前に必ず適用すること。

## 環境変数

| 変数 | 用途 |
|---|---|
| `DIRECT_URL` | drizzle-kit 専用の unpooled 接続 URL（migration/generate/check） |
