-- 2단계(따라 저장): GAS가 원본을 다시 복사한 뒤 정리 테이블을 다시 맞추도록 부르는 통로(서버 키 전용)
create or replace function public.sb_rebuild() returns jsonb
language sql security definer set search_path = '' as $$
  select private.rebuild_from_legacy()
$$;
revoke all on function public.sb_rebuild() from public, anon, authenticated;
grant execute on function public.sb_rebuild() to service_role;
