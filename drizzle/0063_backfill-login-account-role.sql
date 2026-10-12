-- Keep this backfill between the role expansion and finalization migrations.
-- Apply all three together so the column-addition lock protects this mapping.
UPDATE public.momo_login_accounts
SET role = CASE WHEN is_admin THEN 'admin' ELSE 'user' END;
