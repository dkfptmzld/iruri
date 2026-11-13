-- 로그인 막기 값을 'infinity' 대신 먼 날짜로 — 'infinity'면 Supabase 로그인 서버가 읽지 못해 500 오류가 났음(막힌 계정이 '막힘' 대신 서버 오류)
do $mig$
declare d text;
begin
  select pg_get_functiondef('private.sync_auth_from_legacy()'::regprocedure) into d;
  if position('''infinity''' in d) = 0 then raise notice 'already patched'; return; end if;
  execute replace(d, 'banned_until = ''infinity''', 'banned_until = ''2999-12-31 00:00:00+00''');
end $mig$;
update auth.users set banned_until = '2999-12-31 00:00:00+00' where banned_until = 'infinity';
revoke all on function private.sync_auth_from_legacy() from public, anon, authenticated;
