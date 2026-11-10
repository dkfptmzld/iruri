-- 백업 파일 → Supabase 되살리기(비상용). service_role(비밀 키)만 부를 수 있음. GAS 의 restoreSupabaseFromBackup 이 부름.
--  · sb_restore_table: 한 테이블을 한 번에(한 트랜잭션) 되살림
--      p_replace=false → 백업에 있는 행만 덮어쓰기/추가(지금 있는 다른 행은 그대로)
--      p_replace=true  → 백업에 없는 행은 지움(테이블을 백업 시점과 똑같이)
--    · 백업에 있는 칸만 씀(백업 뒤에 새로 생긴 칸은 건드리지 않음)
--    · 자동 번호(id) 칸도 원래 번호 그대로 넣고, 다음 번호를 맨 끝 번호 뒤로 맞춤
--  · sb_restore_auth: 없어진 로그인 계정만 다시 만듦(있는 계정은 건드리지 않음)

create or replace function public.sb_restore_table(p_table text, p_rows jsonb, p_replace boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  rel regclass; pk_t text; pk_r text; pk_c text; cols text; upd text; n_del bigint := 0; n_up bigint := 0; c record;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'p_rows 는 배열이어야 해요'; end if;
  select c2.oid into rel from pg_class c2 join pg_namespace n on n.oid = c2.relnamespace
   where n.nspname = 'public' and c2.relname = p_table and c2.relkind in ('r', 'p');
  if rel is null then raise exception '없는 테이블: %', p_table; end if;

  select string_agg('t.' || quote_ident(a.attname), ',' order by k.ord),
         string_agg('r.' || quote_ident(a.attname), ',' order by k.ord),
         string_agg(quote_ident(a.attname), ',' order by k.ord)
    into pk_t, pk_r, pk_c
    from pg_index i cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
   where i.indrelid = rel and i.indisprimary;
  if pk_c is null then raise exception '기본키 없는 테이블: %', p_table; end if;

  if p_replace then
    execute format('delete from public.%I t where not exists (select 1 from jsonb_populate_recordset(null::public.%I, $1) r where row(%s) = row(%s))',
                   p_table, p_table, pk_t, pk_r) using p_rows;
    get diagnostics n_del = row_count;
  end if;

  if jsonb_array_length(p_rows) > 0 then
    select string_agg(quote_ident(a.attname), ',' order by a.attnum),
           string_agg(format('%1$I = excluded.%1$I', a.attname), ',' order by a.attnum)
             filter (where a.attname <> all (string_to_array(replace(pk_c, '"', ''), ',')))
      into cols, upd
      from pg_attribute a
     where a.attrelid = rel and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
       and exists (select 1 from jsonb_array_elements(p_rows) e where e ? a.attname);
    execute format('insert into public.%I (%s) overriding system value select %s from jsonb_populate_recordset(null::public.%I, $1) on conflict (%s) do %s',
                   p_table, cols, cols, p_table, pk_c,
                   case when upd is null then 'nothing' else 'update set ' || upd end) using p_rows;
    get diagnostics n_up = row_count;
  end if;

  -- 자동 번호 다음 값 맞추기
  for c in select a.attname from pg_attribute a where a.attrelid = rel and a.attidentity <> '' loop
    execute format('select setval(pg_get_serial_sequence(%L, %L), greatest(coalesce((select max(%I) from public.%I), 0), 1))',
                   'public.' || quote_ident(p_table), c.attname, c.attname, p_table);
  end loop;

  return jsonb_build_object('table', p_table, 'upserted', n_up, 'deleted', n_del);
end $$;

create or replace function public.sb_restore_auth(p_users jsonb, p_identities jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n_u bigint; n_i bigint;
begin
  insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                         raw_app_meta_data, raw_user_meta_data, banned_until, created_at, updated_at,
                         confirmation_token, recovery_token, email_change_token_new, email_change)
  select '00000000-0000-0000-0000-000000000000', (u->>'id')::uuid, 'authenticated', 'authenticated', u->>'email',
         u->>'encrypted_password', (u->>'email_confirmed_at')::timestamptz,
         u->'raw_app_meta_data', u->'raw_user_meta_data', (u->>'banned_until')::timestamptz,
         (u->>'created_at')::timestamptz, (u->>'updated_at')::timestamptz, '', '', '', ''
    from jsonb_array_elements(coalesce(p_users, '[]'::jsonb)) u
   where not exists (select 1 from auth.users x where x.id = (u->>'id')::uuid or x.email = u->>'email');
  get diagnostics n_u = row_count;
  insert into auth.identities(id, user_id, provider_id, identity_data, provider, created_at, updated_at)
  select (i->>'id')::uuid, (i->>'user_id')::uuid, i->>'provider_id', i->'identity_data', i->>'provider',
         (i->>'created_at')::timestamptz, (i->>'updated_at')::timestamptz
    from jsonb_array_elements(coalesce(p_identities, '[]'::jsonb)) i
   where exists (select 1 from auth.users x where x.id = (i->>'user_id')::uuid)
     and not exists (select 1 from auth.identities y where y.id = (i->>'id')::uuid
                        or (y.provider = i->>'provider' and y.provider_id = i->>'provider_id'));
  get diagnostics n_i = row_count;
  return jsonb_build_object('users_added', n_u, 'identities_added', n_i);
end $$;

revoke execute on function public.sb_restore_table(text, jsonb, boolean) from public, anon, authenticated;
revoke execute on function public.sb_restore_auth(jsonb, jsonb)          from public, anon, authenticated;
grant  execute on function public.sb_restore_table(text, jsonb, boolean) to service_role;
grant  execute on function public.sb_restore_auth(jsonb, jsonb)          to service_role;
