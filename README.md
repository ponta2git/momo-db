# momo-db

Discord Bot プロジェクト群（summit / momo-result）が共有する PostgreSQL スキーマ定義とマイグレーション管理リポジトリ。

## セットアップ

```bash
cp .env.example .env.local
# .env.local の DIRECT_URL を設定する
pnpm install
pnpm build
```

## スクリプト

| コマンド | 説明 |
|---|---|
| `pnpm build` | TypeScript をコンパイルして `dist/` を生成 |
| `pnpm db:generate` | スキーマ変更から新マイグレーション SQL を生成 |
| `pnpm db:migrate` | 未適用のマイグレーションを DB に適用 |
| `pnpm db:check` | マイグレーションの整合性チェック |

## スキーマ変更手順

1. `src/schema.ts` を編集
2. `pnpm db:generate` で差分 SQL を生成（`drizzle/` に追記される）
3. 生成された SQL をレビュー
4. `pnpm db:migrate` で適用
5. `pnpm build` で `dist/` を再生成

## 利用プロジェクト

- **summit**: `"@momo/db": "file:../momo-db"` でローカル依存として参照

## 環境変数

| 変数 | 用途 |
|---|---|
| `DIRECT_URL` | drizzle-kit 専用の unpooled 接続 URL（migration/generate/check） |
