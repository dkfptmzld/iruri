-- 매일 밤 백업(GAS → 구글 드라이브)용 읽기 전용 함수. service_role(비밀 키)만 부를 수 있음.
--  · sb_backup_tables(): public 의 모든 테이블 + 기본키(새 테이블이 생겨도 자동으로 백업 대상)
--  · sb_backup_extra():  REST로 못 읽는 것 — 로그인 계정(auth), 내부 설정(private.flags), 저장소 파일 목록

create or replace function public.sb_backup_tables()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('table', t.relname, 'pk', t.pk) order by t.relname), '[]'::jsonb)
  from (
    select c.relname,
           (select string_agg(a.attname, ',' order by k.ord)
              from pg_index i
              cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
             where i.indrelid = c.oid and i.indisprimary) as pk
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
  ) t
$$;

create or replace function public.sb_backup_extra()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'auth_users', (select coalesce(jsonb_agg(to_jsonb(u) order by u.created_at), '[]'::jsonb) from (
        select id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
               banned_until, created_at, updated_at, last_sign_in_at, is_anonymous
          from auth.users) u),
    'auth_identities', (select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at), '[]'::jsonb) from (
        select id, user_id, provider, provider_id, identity_data, created_at, updated_at
          from auth.identities) i),
    'private_flags', (select coalesce(jsonb_agg(to_jsonb(f)), '[]'::jsonb) from private.flags f),
    'storage_objects', (select coalesce(jsonb_agg(to_jsonb(o) order by o.bucket_id, o.name), '[]'::jsonb) from (
        select bucket_id, name, metadata->>'size' as size, metadata->>'mimetype' as mimetype, created_at, updated_at
          from storage.objects) o)
  )
$$;

revoke execute on function public.sb_backup_tables() from public, anon, authenticated;
revoke execute on function public.sb_backup_extra()  from public, anon, authenticated;
grant  execute on function public.sb_backup_tables() to service_role;
grant  execute on function public.sb_backup_extra()  to service_role;
