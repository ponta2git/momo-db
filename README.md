# momo-db

Discord Bot プロジェクト群（summit / momo-result）が共有する PostgreSQL スキーマ定義とマイグレーション管理リポジトリ。

エージェント向けの作業入口は [AGENTS.md](./AGENTS.md)。DB 変更前に [正規の開発手順](./docs/development.md) を全文参照する。Discord 通知の保存・競合・consumer 接続は [共有通知契約](./docs/discord-notifications.md)、設計判断の背景は [ADR](./docs/adr/README.md) を参照する。

## CI / CD

すべての PR と master push 時に GitHub Actions が自動実行される。

| ジョブ | 条件 | 内容 |
|---|---|---|
| `Build & Check` | PR と master push | build、migration 整合性、fresh DB の通知契約、既存 DB の backup / restore・移行検証 |
| `Approve production migration` | master push で `drizzle/` に変更があり、検証が成功した場合 | protected environment `production-db` で対象 commit の承認を待つ |
| `Migrate Neon` | master push の本番 migration 承認成功後 | 接続 preflight + `drizzle-kit migrate`（Neon 本番 DB に適用） |

`Build & Check` は workflow の PostgreSQL サービスと専用テスト DB を使い、本番 Environment や Secret を必要としない。PR では本番承認・適用ジョブを実行しない。

### GitHub Environment の設定

| Environment | 設定するもの |
| --- | --- |
| `CI Actions` | `DIRECT_URL` Secret。Neon production の direct / unpooled 接続を登録する |
| `production-db` | required reviewer と master だけを許可する deployment branch policy |

本番用 `DIRECT_URL` が未設定だと `Migrate Neon` は失敗する。登録・ローテーションは[接続先更新手順](./docs/ops/neon-production-connection-rotation.md)に従う。Neon 側の project / branch / role を更新しても GitHub Secret は自動更新されない。

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

`src/schema.ts` は `@momo/db` と Drizzle Kit の共通入口で、既存の公開名を再 export する。宣言は次の責務ごとに配置する。

| ファイル | 責務 |
| --- | --- |
| [schema/identity.ts](./src/schema/identity.ts) | メンバー、ログインアカウント、ログインセッション、HTTP 再送の処理結果 |
| [schema/catalog.ts](./src/schema/catalog.ts) | 作品・マップ・シーズン・事件のマスター、メンバー別名 |
| [schema/attendance.ts](./src/schema/attendance.ts) | 出欠アンケート・回答、開催・参加者の履歴 |
| [schema/matches.ts](./src/schema/matches.ts) | 試合下書き、確定試合、プレイヤー別結果・事件回数 |
| [schema/ocr.ts](./src/schema/ocr.ts) | 入力画像、入力snapshotを持つOCRジョブ・下書き、読み取り操作 |
| [schema/discord-notifications.ts](./src/schema/discord-notifications.ts) | 通知・設定・対象・配送部分の保存形、状態定数・型 |
| [notifications.ts](./src/notifications.ts) | アプリ間で送受信する通知 payload と ID の契約 |
| [schema/analysis/operations.ts](./src/schema/analysis/operations.ts) | 分析操作の受付、キャンペーンと対象 |
| [schema/analysis/jobs.ts](./src/schema/analysis/jobs.ts) | 分析ジョブ・要求・試行、実行枠、対応能力 |
| [schema/analysis/artifacts.ts](./src/schema/analysis/artifacts.ts) | 分析成果物のヘッダーと集計・詳細データ |
| [schema/analysis/publication.ts](./src/schema/analysis/publication.ts) | 分析の公開状態、作品ごとの入力・通知基準 |
| [schema/analysis/checks.ts](./src/schema/analysis/checks.ts) | 分析テーブル間で共通の CHECK 制約式 |
| [schema/radar.ts](./src/schema/radar.ts) | レーダー基準、候補・プレビュー・適用操作と状態 |
| [schema/types.ts](./src/schema/types.ts) | 内部で共用する PostgreSQL の列型 |

分割によって変更箇所を絞れる一方、ファイル間の参照を追う必要が増える。同じ責務のテーブルと定数・型は一緒に読み、変更できる単位にまとめる。内部では依存先ファイルを直接 import し、公開入口を経由せず循環のない依存関係を保つ。通知の通信契約と保存形も、この境界に沿ってそれぞれのファイルで扱う。

OCR・分析のジョブ行が永続キューの正本となる。OCR の `input_snapshot` は受付時の入力を固定し、入力versionを含む。アプリは保存後に入力を更新せず、実行回数・失敗再試行回数・リース回復回数を別列で管理する。DB は実行対象のversion付きobjectと画像参照を要求し、payload全体の意味・入力照合・実行の判断はconsumerが担う。snapshotなしの旧終端履歴は保持する。

0068–0070 は旧writer停止後にまとめて適用する切替であり、旧OCRの未完了jobを終了し、関係するsubmission・下書き・OCR実行枠を整理して配送outboxを撤去する。分析のjob・要求・実行中リースは保持して新版consumerへ引き継ぐ。適用は既存のowner CIと本番承認を使い、consumerとの対応・停止確認は[正規手順](./docs/development.md#6-適用と-release-順序)に従う。

変更後は `pnpm build` で `dist/` を再生成し、消費プロジェクトで `pnpm install` を再実行して `@momo/db` の成果物を更新する。

## 環境変数

| 変数 | 用途 |
|---|---|
| `DIRECT_URL` | drizzle-kit 専用の unpooled 接続 URL（migration/generate/check） |
