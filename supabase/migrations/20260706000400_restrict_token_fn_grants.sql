-- Close a privilege gap on the M2 Vault token functions.
--
-- 20260706000300 revoked EXECUTE from PUBLIC, but on Supabase the default
-- privileges also grant EXECUTE to the anon and authenticated roles directly
-- (not only via PUBLIC). Revoking from PUBLIC therefore left the browser roles
-- able to call these SECURITY DEFINER functions, which decrypt OAuth tokens
-- from Vault. Revoke from anon and authenticated explicitly so only
-- service_role (the server) can ever execute them. Verified by scripts/rls.test.mjs.

revoke all on function public.set_account_tokens(uuid, text, text, timestamptz)
  from anon, authenticated;
revoke all on function public.get_account_tokens(uuid)
  from anon, authenticated;
revoke all on function public.clear_account_tokens(uuid)
  from anon, authenticated;
