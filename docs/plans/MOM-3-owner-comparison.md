# MOM-3: 既存の分析成果物契約の新世代対応

momo-resultのオーナー別比較に合わせ、既存の分析保存契約だけを更新する。集計・意味検証・promotionの業務判断はmomo-resultが所有する。

## 変更対象と順序

1. `0046`: 既存releaseのadvisory lock、reader/worker registry、作品登録、singletonを生成DDLより先に排他する。通常migratorによるtail全体のtransactionを前提とする。
2. `0047`: `src/schema.ts`から生成。artifact・campaign/target・attempt・request・job・release・titleの既存validation/schema制約へ新pairを追加し、release singletonのdefaultを新tupleにする。旧pair・未検証staging・既存のlegacy契約は維持する。
3. `0048`: 既存の`validate_series_analysis_artifact_pointers`と`guard_series_analysis_artifact_publication`を置換する。旧/新のexact pairを受け入れ、公開済みheader/childの不変性とpointerの世代整合を維持する。新形式の未検証公開は拒否する。
4. `0049`: runtime未接続のbootstrapで、作品・分析処理・reader/worker登録履歴がない場合だけactive tupleを更新する。登録履歴はstale/drainingでも数える。稼働DBは通常のcapability確認付きpromotionへ渡す。

schema、custom SQL、生成metadataは分離し、既存migrationのSQL/hashを変更しない。生成DDLは8表の既存CHECKを再検証するためtable lockとscanを伴う。通常のmigration transactionが失敗すればtailはrollbackする。各functionは固定`search_path`を保持し、既存triggerを重複作成しない。破壊的変更・payloadの書換え・集計用の表や列・通知契約の変更は含めない。

## Consumerと検証

momo-resultの旧reader/writerと新旧対応readerが共存できるDB expansionを先行し、その後の切替はmomo-resultのrelease controllerが行う。Summitは分析成果物の公開やpointer更新を行わず、通知の分析identityは正のschema versionを受け入れる。公開型の構造は変わらない。

`pnpm build`、`pnpm db:check`、`pnpm test:migrations`を実行し、fresh tuple、旧成果物を含むbackup/restore後のtail適用、旧hash/全保存値/pointer保持、新旧公開・交差pair拒否、公開済み変更拒否・参照中削除拒否・cascade cleanup、稼働履歴のある空DBを確認した。既存通知の履歴保持検証も同じsuiteで確認する。

本番適用・consumer配置・新世代promotionは未実施。momo-resultのDB integrationとrelease検証は同repositoryのMOM-3工程で実施する。
