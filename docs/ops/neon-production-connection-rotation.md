# Neon production 接続先の登録・更新

Neon project、production branch、または DB role を再作成・ローテーションしたときは、
GitHub Environment `CI Actions` の `DIRECT_URL` Secret と `MOMO_DB_EXPECTED_DIRECT_HOST` Variable も同じ作業内で更新する。
Neon 側の変更だけでは GitHub の設定は更新されない。

初回登録にもこの手順を使う。本書は接続情報の運用手順であり、migration の承認条件・release 順序は [development.md 第 6 節](../development.md#6-適用と-release-順序)に従う。Secret の保存先は `CI Actions`、migration の承認先は `production-db` であり、役割が異なる。

## 手順

1. deploy 禁止時間帯でないことを確認する。
2. Neon Console で対象が production project / production branch / `neondb` であることを確認する。
3. **Direct connection** を選ぶ。hostname に `-pooler` が含まれる URL は migration に使わない。
   production branch の read-write direct hostname を承認済み接続先として控える。
4. Secret 値をコマンドライン引数、ログ、issue、PR、またはコミットへ書かない。
5. GitHub Environment Secret を対話入力で更新し、同じ Environment の Variable に承認済み direct hostname だけを登録する。

   ```bash
   gh secret set DIRECT_URL --repo ponta2git/momo-db --env "CI Actions"
   gh variable set MOMO_DB_EXPECTED_DIRECT_HOST --repo ponta2git/momo-db --env "CI Actions" --body "<approved-direct-host>"
   ```

6. 接続 URL の値を表示せず、Secret の更新時刻と Variable の登録を確認する。

   ```bash
   gh secret list --repo ponta2git/momo-db --env "CI Actions" --json name,updatedAt
   gh variable list --repo ponta2git/momo-db --env "CI Actions" --json name --jq '.[].name'
   ```

7. 初回登録では次の対象 run、接続更新では失敗した元の run を確認する。
   migration を再実行する場合は、対象 commit の承認と release 条件を確認してから元の run を rerun し、
   `Verify migration connection` と `Run migration` がともに成功することを確認する。
8. production DB の `drizzle.__drizzle_migrations` を読み取り専用で確認し、
   対象 migration が記録されていることを確認する。

## preflight が失敗した場合

`db:preflight:ci` は URL や接続先 hostname を出力せず、承認済み direct hostname、URL の DB 名、接続後の `current_database()` を照合する。
過去の切替検証用に残す `db:cutover-baseline:ci` は通常の接続更新では実行しない。このコマンドは `drizzle.__drizzle_migrations` が `0000`–`0072` の hash・timestamp と完全一致することを確認する。これは schema 全体の drift 証明や停止後 backup の代わりにはならない。
失敗時は migration を別経路で強行せず、次を確認する。

- `ENOTFOUND` / `ECONNREFUSED`: project・branch・endpoint の再作成や URL の古さ
- `28P01`: DB role の password ローテーション漏れ
- direct endpoint 検証エラー: pooled URL（hostname の `-pooler`）を誤登録していないか
- 承認済み hostname / DB の不一致: Neon の production branch、Environment Variable、Secret の対応を照合する

接続先を直した後は、必ず元の CI run を rerun して migration 履歴まで確認する。
