# Neon production 接続先の登録・更新

Neon project、production branch、または DB role を再作成・ローテーションしたときは、
GitHub Environment `CI Actions` の `DIRECT_URL` も同じ作業内で更新する。
Neon 側の変更だけでは GitHub Secret は更新されない。

初回登録にもこの手順を使う。本書は接続情報の運用手順であり、migration の承認条件・release 順序は [development.md 第 6 節](../development.md#6-適用と-release-順序)に従う。Secret の保存先は `CI Actions`、migration の承認先は `production-db` であり、役割が異なる。

## 手順

1. deploy 禁止時間帯でないことを確認する。
2. Neon Console で対象が production project / production branch / `neondb` であることを確認する。
3. **Direct connection** を選ぶ。hostname に `-pooler` が含まれる URL は migration に使わない。
4. Secret 値をコマンドライン引数、ログ、issue、PR、またはコミットへ書かない。
5. GitHub Environment Secret を対話入力で更新する。

   ```bash
   gh secret set DIRECT_URL --repo ponta2git/momo-db --env "CI Actions"
   ```

6. 値を表示せず、更新時刻だけを確認する。

   ```bash
   gh secret list --repo ponta2git/momo-db --env "CI Actions" --json name,updatedAt
   ```

7. 初回登録では次の対象 run、接続更新では失敗した元の run を確認する。
   migration を再実行する場合は、対象 commit の承認と release 条件を確認してから元の run を rerun し、
   `Verify migration connection` と `Run migration` がともに成功することを確認する。
8. production DB の `drizzle.__drizzle_migrations` を読み取り専用で確認し、
   対象 migration が記録されていることを確認する。

## preflight が失敗した場合

`db:preflight:ci` は URL や接続先 hostname を出力せず、分類可能なエラーコードだけを出す。
失敗時は migration を別経路で強行せず、次を確認する。

- `ENOTFOUND` / `ECONNREFUSED`: project・branch・endpoint の再作成や URL の古さ
- `28P01`: DB role の password ローテーション漏れ
- direct endpoint 検証エラー: pooled URL（hostname の `-pooler`）を誤登録していないか

接続先を直した後は、必ず元の CI run を rerun して migration 履歴まで確認する。
