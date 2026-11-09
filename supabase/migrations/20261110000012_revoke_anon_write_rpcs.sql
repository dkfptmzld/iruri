-- 새 함수가 기본으로 로그인 전 사용자(anon)에게 열리는 것을 막음: 관리자·로그인 전용 함수는 anon 실행 불가
revoke execute on function public.approve_signup(text), public.admin_set_password(text, text), public.save_monthly_settlement(text, jsonb, text, boolean),
  public.delete_monthly_settlement(text), public.finalize_settlement(text, text, text, jsonb), public.dep_save_mappings(jsonb, jsonb, jsonb),
  public.dep_save_records(jsonb), public.save_draft(text, jsonb), public.set_teacher_flag(text, text, jsonb), public.submit_record(jsonb),
  public.recruit_apply(jsonb), public.recruit_cancel(jsonb), public.sb_rebuild() from anon;
revoke execute on function public.sb_rebuild() from authenticated;
alter default privileges in schema public revoke execute on functions from anon;
