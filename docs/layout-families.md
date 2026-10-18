# Layout family の保存契約

`game_titles.layout_family`、`match_drafts.layout_family`、`matches.layout_family` に保存する値は `momotetsu_2`、`world`、`reiwa` の三つとする。未選択の下書きだけは `NULL` を保持する。`profile_id` は個別 OCR profile の opaque ID であり、この三値には変換しない。

既知の旧表記は、読み取り境界と入力検証で次の正式値へ解決する。edge の space・HT・LF・VT・FF・CR だけを取り除き、ASCII 大文字を小文字へ変換する。Unicode whitespace や Unicode 互換正規化は行わない。

| 正式値 | 受け入れる旧別名 |
| --- | --- |
| `momotetsu_2` | `momotetsu2`, `2` |
| `world` | `momotetsu_world`, `default` |
| `reiwa` | `momotetsu_reiwa` |

hint の欠落または `NULL` は自動選択を意味する。文字列 `auto`、空文字、未知の値は新規入力として拒否する。`default` は `world` を意味し、自動選択にはしない。新しい consumer は入力を検証して正式値だけを書き込む。

## Migration と保存済み入力

`0081_normalize-layout-families` は三つの mutable scalar table を lock し、全ての値が既知の対応表に含まれることを確認してから別名を変換する。未知の値があれば `LAYOUT_FAMILY_UNMAPPED_SOURCE` で tail 全体を停止する。`0082_constrain-layout-families` は Drizzle 生成の CHECK を追加する。通常 migrator の一つの transaction として適用し、writer は正式値を保存する consumer への切替完了まで停止する。

保存済み OCR input snapshot、hint、profile ID、通知、analysis / radar payload は元の値を保持する。読み取り側の別名解決は維持し、旧 request の再送では元 key と元 request hash による照合を先に行う。CHECK を通すために保存 payload を再生成しない。

`tests/fixtures/layout-families-v1.json` は momo-result の `docs/schemas/fixtures/ocr-worker/layout-families-v1.json` と同一の共有 fixture である。migration テストはこの対応表で fresh CHECK、dump / restore 後の scalar 変換、他の全旧値・機構の保持、未知値の拒否、失敗時 rollback、通常 migrator の no-op を確認する。API / Rust / Python の別名読取・新規入力拒否・旧再送、および実データ copy の比較は独立した consumer / release gate とする。
