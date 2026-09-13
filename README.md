# momo-db

Discord Bot プロジェクト群（summit / momo-result）が共有する PostgreSQL スキーマ定義とマイグレーション管理リポジトリ。

エージェント向けの作業入口は [AGENTS.md](./AGENTS.md)。DB 変更前に [正規の開発手順](./docs/development.md) を全文参照する。Discord 通知の保存・競合・consumer 接続は [共有通知契約](./docs/discord-notifications.md)、設計判断の背景は [ADR](./docs/adr/README.md) を参照する。

## CI / CD

master push 時に GitHub Actions が自動実行される。

| ジョブ | 条件 | 内容 |
|---|---|---|
| `Build & Check` | 常に実行 | build、migration 整合性、fresh DB の通知契約、既存 DB の backup / restore・移行検証 |
| `Approve production migration` | `drizzle/` に変更がある場合のみ | protected environment `production-db` で対象 commit の承認を待つ |
| `Migrate Neon` | 承認成功後 | 接続 preflight + `drizzle-kit migrate`（Neon 本番 DB に適用） |

### GitHub Environment の設定

| Environment | 設定するもの |
| --- | --- |
| `CI Actions` | `DIRECT_URL` Secret。Neon production の direct / unpooled 接続を登録する |
| `production-db` | required reviewer と master だけを許可する deployment branch policy |

`DIRECT_URL` が未設定だと CI は失敗する。登録・ローテーションは[接続先更新手順](./docs/ops/neon-production-connection-rotation.md)に従う。Neon 側の project / branch / role を更新しても GitHub Secret は自動更新されない。

workflow の `environment: production-db` だけでは承認待ちは保証されないため、Settings または GitHub API で protection rule の存在を確認する。reviewer の個人情報や環境設定の実値は repository に記録しない。

本番適用と consumer deploy の順序、緊急時の手動適用条件は [development.md 第 6 節](./docs/development.md#6-適用と-release-順序)に従う。

## セットアップ

Node.js 24 と `package.json` 固定の pnpm を使う。

```bash
cp .env.example .env.local
# .env.local の DIRECT_URL を設定する（Neon unpooled 接続文字列）
pnpm install --frozen-lockfile
pnpm build
```

## スクリプト

| コマンド | 説明 |
|---|---|
| `pnpm build` | TypeScript をコンパイルして `dist/` を生成 |
| `pnpm test:prepare` | 名前・host を検査した専用テスト DB に全 migration を適用 |
| `pnpm test:integration` | 通知 ID、DB の一意・参照・形状制約、保存・rollback、旧業務関数・trigger 撤去の検証 |
| `pnpm test:migrations` | 専用 container で旧データの backup / restore と新 tail の保全検証 |
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
> ボリュームは `/var/lib/postgresql` にマウントする。保存対象 DB の復旧・整理は [development.md](./docs/development.md#7-rollback--recovery) に従う。

この compose DB は保存対象である。DB テストには[専用 DB の設定](./docs/discord-notifications.md#専用-db-での検証)を使う。

### summit のセットアップから一括実行する場合

summit の `pnpm setup` が momo-db の全 DB セットアップを自動的に呼び出す（`db:up` → `db:migrate` → summit `db:seed`）。

## スキーマ変更手順

通常の schema migration と custom SQL migration の作り分け、履歴の不変性、検証、rollback は [`docs/development.md`](./docs/development.md) に従う。

変更後は `pnpm build` で `dist/` を再生成し、消費プロジェクトで `pnpm install` を再実行して `@momo/db` の成果物を更新する。

## 環境変数

| 変数 | 用途 |
|---|---|
| `DIRECT_URL` | drizzle-kit 専用の unpooled 接続 URL（migration/generate/check） |
