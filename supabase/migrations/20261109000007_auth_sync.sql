-- 로그인 계정: 강사계정 시트(이름, SHA-256 비밀번호 지문) → Supabase 로그인 계정
--  · 로그인 주소는 이름에서 자동으로 만듦(내부용): 'n' + 이름(UTF-8 16진수) + '@member.erurisilver.com'
--  · 비밀번호 = 앱이 지금 계산하는 SHA-256 지문 그대로 → 강사님은 기존 비밀번호로 로그인
--  · 권한: 시스템설정 permissions(이름→["admin","cert",...]) 그대로, 박기남은 항상 마스터
--  · 따라 저장(sb_rebuild) 때마다 함께 맞춤(비밀번호 바뀜·권한 바뀜·계정 없어짐)
alter table public.profiles add column if not exists pw_fp text;   -- 비밀번호 지문의 지문(바뀐 것만 다시 암호화)

create or replace function private.login_email(p_name text) returns text
language sql immutable set search_path = '' as $$
  select 'n' || encode(convert_to(btrim(p_name), 'UTF8'), 'hex') || '@member.erurisilver.com'
$$;

create or replace function private.sync_auth_from_legacy() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r record; uid uuid; em text; fp text; perms jsonb; cp jsonb; rl text;
  n_new int := 0; n_pw int := 0; n_skip int := 0; n_ban int := 0; skipped text[] := '{}';
begin
  select s.value into perms from public.settings s where s.key = 'permissions';
  perms := coalesce(perms, '{}'::jsonb);
  for r in
    select btrim(cells->>0) as name, btrim(cells->>1) as hash
    from public.legacy_sheet_rows
    where sheet = '강사계정' and row_no > 1 and coalesce(btrim(cells->>0), '') <> ''
    order by row_no
  loop
    cp := coalesce((select jsonb_object_agg(x, true) from jsonb_array_elements_text(
            case when jsonb_typeof(perms->r.name) = 'array' then perms->r.name else '[]'::jsonb end) x), '{}'::jsonb);
    if r.name = '박기남' then cp := cp || '{"master": true}'::jsonb; end if;
    if cp ? 'master' then cp := cp || '{"admin": true, "cert": true, "emergency": true}'::jsonb; end if;
    rl := case when cp ? 'admin' then 'admin' else 'teacher' end;
    if r.hash !~ '^[0-9a-fA-F]{64}$' then n_skip := n_skip + 1; skipped := skipped || r.name; continue; end if;
    em := private.login_email(r.name);
    fp := md5(r.hash);
    select p.id into uid from public.profiles p where p.name = r.name;
    if uid is null then
      uid := gen_random_uuid();
      insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                             raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                             confirmation_token, recovery_token, email_change_token_new, email_change)
      values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', em,
              extensions.crypt(r.hash, extensions.gen_salt('bf')), now(),
              '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('name', r.name), now(), now(),
              '', '', '', '');
      insert into auth.identities(id, user_id, provider_id, identity_data, provider, created_at, updated_at)
      values (gen_random_uuid(), uid, uid::text,
              jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true), 'email', now(), now());
      insert into public.profiles(id, name, role, caps, pw_fp) values (uid, r.name, rl, cp, fp);
      n_new := n_new + 1;
    else
      if (select p.pw_fp from public.profiles p where p.id = uid) is distinct from fp then
        update auth.users set encrypted_password = extensions.crypt(r.hash, extensions.gen_salt('bf')), updated_at = now() where id = uid;
        n_pw := n_pw + 1;
      end if;
      update public.profiles set role = rl, caps = cp, pw_fp = fp where id = uid;
      update auth.users set banned_until = null where id = uid and banned_until is not null;
    end if;
  end loop;

  -- 강사계정 시트에서 없어진 계정은 로그인 막기(지우지는 않음)
  update auth.users u set banned_until = 'infinity'
  from public.profiles p
  where p.id = u.id and u.banned_until is null
    and not exists (select 1 from public.legacy_sheet_rows l
                    where l.sheet = '강사계정' and l.row_no > 1 and btrim(l.cells->>0) = p.name);
  get diagnostics n_ban = row_count;

  return jsonb_build_object('created', n_new, 'password_changed', n_pw, 'skipped_old_hash', n_skip,
                            'skipped_names', to_jsonb(skipped), 'blocked', n_ban,
                            'profiles', (select count(*) from public.profiles),
                            'admins', (select count(*) from public.profiles where role = 'admin'));
end $$;
revoke all on function private.sync_auth_from_legacy() from public, anon, authenticated;

-- 따라 저장 때 로그인 계정도 함께
create or replace function public.sb_rebuild() returns jsonb
language sql security definer set search_path = '' as $$
  select private.rebuild_from_legacy() || jsonb_build_object('auth', private.sync_auth_from_legacy())
$$;
revoke all on function public.sb_rebuild() from public, anon, authenticated;
grant execute on function public.sb_rebuild() to service_role;
