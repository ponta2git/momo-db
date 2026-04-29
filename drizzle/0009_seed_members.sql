-- seed: MVP 固定 4 名のメンバー。requirements/base.md §3.1, §5.1 に従う。
-- ログイン可能なアカウントは以下の 4 名のみ。初期管理者は ぽんた (member_ponta)。
INSERT INTO "members" ("id", "user_id", "display_name") VALUES
  ('member_ponta', '523484457705930752', 'ぽんた'),
  ('member_akane_mami', '716205987073228902', 'あかねまみ'),
  ('member_otaka', '711582748103540828', 'おーたか'),
  ('member_eu', '711560406891757570', 'いーゆー')
ON CONFLICT ("id") DO NOTHING;
