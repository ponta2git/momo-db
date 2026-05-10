-- seed: momo-result dev environment users and OCR aliases.
-- The fixed users/accounts are already seeded by 0009_seed_members.sql and 0013_login_accounts.sql;
-- this migration keeps them aligned and adds the non-社長 aliases used by the dev UI.
INSERT INTO "members" ("id", "user_id", "display_name") VALUES
  ('member_ponta', '523484457705930752', 'ぽんた'),
  ('member_akane_mami', '716205987073228902', 'あかねまみ'),
  ('member_otaka', '711582748103540828', 'おーたか'),
  ('member_eu', '711560406891757570', 'いーゆー')
ON CONFLICT ("id") DO UPDATE
SET
  "user_id" = EXCLUDED."user_id",
  "display_name" = EXCLUDED."display_name";
--> statement-breakpoint
INSERT INTO "momo_login_accounts" (
  "id",
  "discord_user_id",
  "display_name",
  "player_member_id",
  "login_enabled",
  "is_admin"
) VALUES
  ('account_ponta', '523484457705930752', 'ぽんた', 'member_ponta', true, true),
  ('account_akane_mami', '716205987073228902', 'あかねまみ', 'member_akane_mami', true, false),
  ('account_otaka', '711582748103540828', 'おーたか', 'member_otaka', true, false),
  ('account_eu', '711560406891757570', 'いーゆー', 'member_eu', true, false)
ON CONFLICT ("id") DO UPDATE
SET
  "discord_user_id" = EXCLUDED."discord_user_id",
  "display_name" = EXCLUDED."display_name",
  "player_member_id" = EXCLUDED."player_member_id",
  "login_enabled" = EXCLUDED."login_enabled",
  "is_admin" = EXCLUDED."is_admin",
  "updated_at" = now();
--> statement-breakpoint
INSERT INTO "member_aliases" ("id", "member_id", "alias") VALUES
  ('alias-ponta-display-name', 'member_ponta', 'ぽんた'),
  ('alias-akane-mami-display-name', 'member_akane_mami', 'あかねまみ'),
  ('alias-akane-mami-no11', 'member_akane_mami', 'NO11'),
  ('alias-otaka-display-name', 'member_otaka', 'おーたか'),
  ('alias-otaka-katakana', 'member_otaka', 'オータカ'),
  ('alias-eu-display-name', 'member_eu', 'いーゆー')
ON CONFLICT ("id") DO UPDATE
SET
  "member_id" = EXCLUDED."member_id",
  "alias" = EXCLUDED."alias";
