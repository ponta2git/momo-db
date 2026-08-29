# DB 変更の正規開発手順

この文書は、momo-db の schema と migration を変更する際の単一の規範文書である。momo-result、summit を含む共有 DB の利用側から momo-db を変更する場合も、実装前にこの文書を読む。

## 1. 所有境界

- Drizzle が表現できる table、column、constraint、index などの宣言元は `src/schema.ts` とする。
- `drizzle/` の SQL、`drizzle/meta/_journal.json`、snapshot は、順序を持つ一つの migration 履歴である。
- schema 変更は `drizzle-kit generate`、Drizzle が表現できない DDL や data transition は `drizzle-kit generate --custom` から作る。schema を `psql` 等で直接変更しない。
- SQL migration は Drizzle 管理の正規成果物である。function、trigger、data transition などの独立した手書き SQL も custom migration として履歴・順序・検証の対象にする。
- `drizzle-kit push` は使わない。レビュー可能な migration 履歴を必ず残す。

## 2. 変更前に確認すること

1. Node.js 24 と repository 固定の pnpm を使い、依存を lockfile どおりに導入する。
2. 作業 tree と最新 migration、対象 DB の `drizzle.__drizzle_migrations` を確認する。
3. 対象 migration が、保存対象の local DB、共有 DB、本番 DB のいずれかへ適用済みでないかを確認する。
4. summit と momo-result のどの version が変更前後の schema を読むかを確認し、必要なら expand → consumer deploy → contract に分割する。

適用状況が不明な migration を書き換えてはならない。不明点や consumer 間の互換性矛盾があれば、生成や適用より先に解消する。

## 3. Migration の作り分け

### 3.1 Drizzle schema で表現できる変更

1. `src/schema.ts` を変更する。
2. 意味の分かる名前で schema migration を生成する。

   ```bash
   pnpm db:generate --name=<schema-change>
   ```

3. 生成された SQL と metadata を一緒にレビューする。

生成 SQL が既存データに対して安全でない場合は、まず schema 宣言を直して再生成する。precondition、backfill、段階移行が必要なら、別の custom migration を依存順に置く。生成 DDL への局所補正は、宣言した同じ schema transition を他の方法で正しく表現できない場合に限り、理由を記録する。この例外で function、trigger、data repair などの独立した custom SQL を schema migration へ追加してはならない。

### 3.2 Drizzle schema で表現できない変更

PostgreSQL function、trigger、procedural precondition / backfill、seed などは空の custom migration を生成する。

```bash
pnpm db:generate --custom --name=<purpose>
```

function、trigger、procedural precondition / backfill、seed などの独立した手書き SQL は、このコマンドが新規作成した SQL ファイルだけに記述する。migration file の採番、journal、snapshot を手で作成・更新しない。

schema DDL と custom SQL の両方が必要なら、一つの migration に混ぜず、依存順が明確な別 migration にする。例えば、column を追加する schema migration の次に、その column を参照する function / trigger の custom migration を置く。既存値の整形後に `NOT NULL` 化する場合は、expand schema を生成 → その shape のまま custom precondition / backfill を生成 → `src/schema.ts` を contract shape に変えて contract migration を生成、の順に進める。custom migration も生成時点の snapshot を作るため、後段の schema shape へ先に進めない。

公式仕様は [Drizzle Kit `generate`](https://orm.drizzle.team/docs/drizzle-kit-generate) と [custom migrations](https://orm.drizzle.team/docs/kit-custom-migrations) を参照する。この repository では固定済み `drizzle-kit` の `pnpm db:generate --help` も実際の option の根拠とする。

## 4. 履歴の不変性とデータ保護

- master へ入った migration、または disposable ではない DB に一度でも適用した migration の SQL / metadata は変更しない。修正は新しい forward migration で行う。
- 未 commit でも、保持対象の local DB に適用した後でファイルだけを編集してはならない。file hash と DB state がずれるためである。
- 未適用・未共有だと確認できた最新 migration を作り直す場合だけ、固定済み Drizzle Kit の `drop` で SQL、journal entry、snapshot を一単位として外し、再生成する。metadata の一部だけを手で合わせない。

  ```bash
  pnpm exec dotenv -e .env.local -- drizzle-kit drop
  ```
- DDL を通すためだけに既存 row を黙って `DELETE` または意味の違う値へ書き換えない。変換が一意でなければ、診断可能な precondition で migration を停止する。
- row の削除、column / table の drop、不可逆な型変換には、所有者の明示判断、復元可能な backup、consumer 互換性の確認が必要である。

## 5. 必須の検証

最低限、次を実行する。

```bash
pnpm build
pnpm db:check
```

`db:check` が保証するのは生成 migration 履歴の整合性であり、PostgreSQL 上での実行成功や既存データ保持ではない。`drizzle/` を変更した場合は、さらに次を確認する。

1. 空の disposable DB に全 migration を適用できる。
2. 代表的な既存 DB の復元 copy に新しい tail migration を適用できる。
3. 前後の row count、対象 domain invariant、constraint、index、function、trigger が意図どおりである。
4. lock、長時間 transaction、identifier の切り詰め、function の `search_path`、trigger の競合を SQL review する。
5. 影響する summit / momo-result の build、型検査、DB integration test を通す。

保存対象の `summit-postgres` や named volume を fresh-DB 検証に流用しない。fresh 検証には削除可能な一時 DB を使う。

## 6. 適用と release 順序

local 適用は、接続先と backup 要否を確認してから実行する。

```bash
pnpm db:migrate
```

共有 DB では、互換な DB expansion を先に適用し、全 consumer を deploy してから、旧 shape を消す contract migration を別 release で行う。

master push では CI が build と `drizzle-kit check` を行う。`drizzle/` に変更がある場合は protected environment `production-db` で対象 commit の承認を待ち、承認後に接続 preflight と migration を直列実行する。通常運用で承認や preflight を迂回しない。CI 自体を復旧できない緊急時は、同じ変更内容への明示承認、backup、接続 preflight を揃えた場合だけ README の手動手順を使う。

## 7. Rollback / recovery

Drizzle Kit にこの repository 用の down migration はない。共有済み・適用済み migration の通常の修復方法は、新しい forward migration である。

保持対象 DB を例外的に戻す必要がある場合は、データ保護を先に行う。

1. API、worker、batch など全 writer を停止する。
2. custom-format dump または provider snapshot を取得する。dump は disposable DB へ restore し、provider snapshot は branch / clone 等の復元 copy を作って読み出せることまで確認する。
3. 対象 migration の ID、timestamp、hash と、削除予定 column / table の実データを読み取り確認する。
4. 期待した履歴・schema でなければ停止する guard を置き、一つの transaction で対象だけを逆操作する。
5. migration 履歴だけを削除しない。schema object と履歴を同じ transaction で整合させる。
6. 前後の row count と domain invariant を比較し、consumer の起動確認後も backup を保持する。

通常の rollback に `docker compose down -v` や volume 削除を使わない。

## 8. 完了条件

- schema change と custom SQL が正しい migration に分離されている。
- migration SQL と metadata が対応し、適用済み履歴を改変していない。
- fresh DB と代表的 existing DB の両方で適用を確認した。
- データ保持、失敗時の停止条件、consumer 互換性を確認した。
- 必須 gate と影響する consumer gate が通った。
- DB commit、migration 適用、consumer deploy、contract の順序が明示されている。
