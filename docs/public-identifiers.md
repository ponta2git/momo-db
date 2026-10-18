# 開催・試合の公開番号

`held_events.public_id` と `matches.public_id` は、それぞれ独立した `bigint GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL` とする。既存の `id`、外部キー、保存済み通知、解析成果物、radar 基準と計算入力はそのまま保持する。

`@momo/db` は `publicId` を JavaScript `bigint` として公開する。JSON の送受信では正の十進文字列を使い、`Number` に変換しない。consumer の新しい公開経路は `/e/:publicId` と `/m/:publicId` とし、従来の ID を扱う経路と区別する。従来の数値文字列 ID も従来どおり同じ対象を指す。既存通知のリンク・payload を書き換えない。

既存行の番号は table ごとに `id COLLATE "C"` の順で 1 から割り当てる。新規行は各 identity sequence から取得する。番号は日時を表さず、削除や失敗した挿入により欠番が生じても詰め直さない。

## Migration の単位

| Migration | 種別 | 変更 |
| --- | --- | --- |
| `0073_add-public-identifiers` | schema 生成 | nullable bigint 列を追加 |
| `0074_backfill-public-identifiers` | custom | 未割当てを確認し、C 順で番号を設定 |
| `0075_constrain-public-identifiers` | schema 生成 | NOT NULL と UNIQUE を追加 |
| `0076_generate-public-identifiers` | schema 生成 | GENERATED ALWAYS AS IDENTITY を追加 |
| `0077_align-public-identifier-sequences` | custom | 各 sequence を既存最大値 + 1、空なら 1 に設定 |

NOT NULL と identity は別の schema migration にする。固定済み Drizzle Kit は nullable 列から identity を一度に宣言すると、既存列に必要な `SET NOT NULL` を生成しないためである。各 snapshot / journal は対応する中間 schema から生成する。

この tail は通常の migrator の一つの transaction で適用する。table の排他 lock は backfill から sequence 整合まで保持され、待機していた旧 writer は commit 後に自動採番を利用する。tail の途中を独立した release として配布しない。sequence 整合には transactional な `RESTART` を使い、後続失敗時には行・DDL・ledger と一緒に戻す。

## Release と検証

列を指定して挿入する既存 consumer は公開番号を省略できる。DB expansion を適用してから、公開番号を十進文字列で扱う consumer を deploy する。public 番号からの lookup も既存の認証・認可の境界を維持する。

`tests/public-identifier-migration.test.mjs` は fresh DB、代表データの dump / restore、全旧行・制約・index・function・trigger の保持、C 順割当て、次回採番、JavaScript 安全整数範囲を超える値、拒否条件、失敗時 rollback、再実行の no-op を確認する。既存の履歴保全テストも新しい二列の期待値だけを明示的に追加する。実データの復元 copy 比較と summit / momo-result の build・型検査・integration は、それぞれ release gate として確認する。
