# 本番コピーのローカル移行リハーサル

`pnpm migration:rehearsal` は、本番を読み取り、暗号化した整合 snapshot を所有確認付きのローカル PostgreSQL 18 へ復元する。通常の migration は固定 commit の `pnpm db:migrate:ci` を使う。本番への migration / restore / maintenance 切替はこの入口に実装していない。

## 準備

Node 24、repository 固定 pnpm、Docker 28 以降、取得済みの PostgreSQL 18 image を使う。image 内に `nc` が必要で、`prepare` が検査する。作業 tree は未追跡ファイルを含め clean にし、候補を commit する。CLI は SHA・lockfile・migration 履歴の digest を固定し、以降に変更があれば停止する。

source と locale metadata が一致する image を選ぶ。Alpine は `C.UTF-8` の LC_COLLATE を `C` として初期化する場合があり、その差は許容しない。Debian 版が必要なら、データや接続設定を含まない stdin Dockerfile から中継用 `nc` を追加する。作成後の image ID は `prepare` が固定する。

```sh
docker build --tag momo-db-rehearsal:18 - < scripts/migration/postgres.Dockerfile
```

この場合、後述の `--postgres-image` は `momo-db-rehearsal:18` を指定する。

source は明示した direct 接続だけを使い、`.env.local` を自動読込みしない。接続 URL を shell 引数・履歴へ書かず、承認済みの secret 注入で `MOMO_REHEARSAL_SOURCE_URL` に渡す。以下は環境変数の値を表示せず、repository 外の private directory に鍵と接続設定を作る例である。

```sh
install -d -m 700 /private/tmp/momo-rehearsal-secrets
node --input-type=module <<'JS'
import { createKey, loadKey, writeJson } from './scripts/migration/files.mjs';
const base = '/private/tmp/momo-rehearsal-secrets';
if (!process.env.MOMO_REHEARSAL_SOURCE_URL) throw new Error('Source configuration is required.');
await createKey(`${base}/source.key`);
await writeJson(`${base}/source.json.enc`, { sourceUrl: process.env.MOMO_REHEARSAL_SOURCE_URL }, await loadKey(`${base}/source.key`));
JS
```

鍵は 0600、directory は 0700 とする。共有・commit しない。接続設定、manifest、棚卸し、dump は AES-256-GCM で暗号化する。鍵と暗号化ファイルの両方を紛失すると復元できないため、必要な保持期間は管理された private storage に保管する。CLI の `cleanup` はこれらを消さない。

SQL 棚卸しは検証付き TLS と必要な SCRAM channel binding を使う。dump は同じ接続設定を libpq に安全に注入する。`channel_binding=require` の fallback、未知の URL parameter、pooler URL は拒否する。URL parameter は `sslmode` / `channel_binding` のみ許可する。

## 実行

`prepare` は存在しない run directory を指定する。以後は同じ鍵・manifest を明示する。

```sh
pnpm migration:rehearsal prepare \
  --run-dir /private/tmp/momo-rehearsal-run \
  --key-file /private/tmp/momo-rehearsal-secrets/source.key \
  --source-config /private/tmp/momo-rehearsal-secrets/source.json.enc \
  --postgres-image postgres:18-alpine

pnpm migration:rehearsal snapshot --manifest /private/tmp/momo-rehearsal-run/manifest.json.enc --key-file /private/tmp/momo-rehearsal-secrets/source.key
pnpm migration:rehearsal restore --manifest /private/tmp/momo-rehearsal-run/manifest.json.enc --key-file /private/tmp/momo-rehearsal-secrets/source.key
pnpm migration:rehearsal rehearse --manifest /private/tmp/momo-rehearsal-run/manifest.json.enc --key-file /private/tmp/momo-rehearsal-secrets/source.key
pnpm migration:rehearsal recover-rehearsal --manifest /private/tmp/momo-rehearsal-run/manifest.json.enc --key-file /private/tmp/momo-rehearsal-secrets/source.key
pnpm migration:rehearsal status --manifest /private/tmp/momo-rehearsal-run/manifest.json.enc --key-file /private/tmp/momo-rehearsal-secrets/source.key
pnpm migration:rehearsal cleanup --manifest /private/tmp/momo-rehearsal-run/manifest.json.enc --key-file /private/tmp/momo-rehearsal-secrets/source.key
```

`inspect` は dump を作らず source の棚卸しを保存する任意の入口、`verify` は移行 copy の読取り比較である。未知の ledger、row-level security による不可視行、schema / 保存値差分は成功扱いにしない。dump と移行前監査は同じ exported snapshot を使い、source 接続は読取り専用とする。source 上で migration や修復は行わない。

ローカル PostgreSQL は run 固有 label、固定 image ID、internal / isolated network、tmpfs のみを使い、port を公開しない。各 command の間だけ host の 127.0.0.1 へ一時 TCP relay を開き、所有確認した container 内の `nc` へ接続する。relay の socket・子 process は終了時に回収し、port は manifest へ保存しない。restore と cleanup は実体を毎回再確認する。任意 DB URL、保存対象 `summit-postgres`、named volume、bind mount は対象にできない。上限は container memory 3 GiB / PGDATA 2 GiB なので、複数 copy が収まらない場合は容量設計を改訂して候補を作り直す。

実行中は private run lock を保持する。異常終了した lock は TTL で自動解除しない。残存 process と所有資源を確認してから管理者が解除する。migration 結果が不明なときは ledger を読み取り確認し、盲目的に再適用しない。

## 証拠の範囲

初期 CLI の `checks` は DB のコピー・比較結果を表し、統合計画全体の完了ではない。必ず `incomplete` も確認する。

- 全 user schema の構造、全 table の保存行と件数、migration ledger を比較する。全行を PostgreSQL の JSON 文字列表現から SHA-256 にし、その固定長 digest を並べて table ごとの multiset を hash する。巨大な保存値そのものを sort / 転送せず、重複行と全値を含める。数値を JavaScript の number に変換しない。
- owner / ACL は完全な元棚卸しを private に保持するが、ローカル restore は owner を置換し ACL を省く。構造比較はこれらを除外するため、実アプリ role / SECURITY DEFINER の挙動は別の必須 gate とする。
- locale 名だけでなく provider・rules・記録済み / 実際の collation version を比較する。source の builtin / libc 設定で初期化し、復元前に一致を確認する。version drift、未対応の ICU 等は停止し、名前の正規化だけで同一とみなさない。
- 稼働中の snapshot では sequence は MVCC に従わない。sequence の元 DB と同時点の保全や停止継続は証明しない。二つの復元 copy 間では identity sequence を含め一致を検査する。
- 初期 comparator は schema・アプリ保存値の変更を一切許容せず、pending tail がある場合は適用前に停止する。ID 等の変換には期待 schema・列別 mapping と専用 comparator を追加し、その候補で再リハーサルする。
- 新規の移行 copy では正規 migrator を再実行し、二回目が schema・ledger・保存値・sequence を変えないことまで検証する。途中終了後の既存 copy は読取り比較で分類し、再適用しない。二回目実行の証拠が残っていなければ未確認として fresh run を求める。
- consumer の smoke、別 DB への実接続切替、画像本体、停止直後の最終 snapshot、本番承認・適用・再開は別の証拠が必要である。

手順と受入条件の全体は [統合計画](plans/2026-10-17-db-refactor-and-migration-plan.md)、正規 migration の規範は [開発手順](development.md) に従う。
