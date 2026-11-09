-- 3단계 준비: 저장(쓰기)을 Supabase로 — 규칙은 서버가 지킨다
--  (아직 강사님들은 GAS를 씀. 테스트 스위치(?backend=sb)를 켠 기기만 이 함수들을 씀)

-- ── 전환 표시: 전환 후엔 따라 저장(sb_rebuild)이 Supabase 데이터를 덮어쓰지 않게 ──
create table if not exists private.flags (key text primary key, value text, updated_at timestamptz default now());
create or replace function public.sb_rebuild() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from private.flags where key = 'cutover' and value = 'true') then
    return jsonb_build_object('skipped', 'cutover');   -- 전환 후: 시트로 덮어쓰지 않음
  end if;
  return private.rebuild_from_legacy() || jsonb_build_object('auth', private.sync_auth_from_legacy());
end $$;
revoke all on function public.sb_rebuild() from public, anon, authenticated;
grant execute on function public.sb_rebuild() to service_role;

-- ── 공통: 로그인 계정 만들기/비밀번호 바꾸기 ──
create or replace function private.caps_for(p_name text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare perms jsonb; cp jsonb;
begin
  select s.value into perms from public.settings s where s.key = 'permissions';
  cp := coalesce((select jsonb_object_agg(x, true) from jsonb_array_elements_text(
          case when jsonb_typeof(perms->p_name) = 'array' then perms->p_name else '[]'::jsonb end) x), '{}'::jsonb);
  if p_name = '박기남' then cp := cp || '{"master": true}'::jsonb; end if;
  if cp ? 'master' then cp := cp || '{"admin": true, "cert": true, "emergency": true}'::jsonb; end if;
  return cp;
end $$;

create or replace function private.create_login(p_name text, p_hash text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := gen_random_uuid(); em text := private.login_email(p_name); cp jsonb := private.caps_for(p_name);
begin
  insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                         raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                         confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', em,
          extensions.crypt(p_hash, extensions.gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('name', p_name), now(), now(), '', '', '', '');
  insert into auth.identities(id, user_id, provider_id, identity_data, provider, created_at, updated_at)
  values (gen_random_uuid(), uid, uid::text, jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true), 'email', now(), now());
  insert into public.profiles(id, name, role, caps, pw_fp)
  values (uid, p_name, case when cp ? 'admin' then 'admin' else 'teacher' end, cp, md5(p_hash));
  return uid;
end $$;

create or replace function private.set_login_password(p_name text, p_hash text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  select id into uid from public.profiles where name = p_name;
  if uid is null then return false; end if;
  update auth.users set encrypted_password = extensions.crypt(p_hash, extensions.gen_salt('bf')), updated_at = now(), banned_until = null where id = uid;
  update public.profiles set pw_fp = md5(p_hash) where id = uid;
  return true;
end $$;

create or replace function private.kst_text(t timestamptz) returns text
language sql stable set search_path = '' as $$
  select to_char(t at time zone 'Asia/Seoul', 'YYYY. FMMM. FMDD. ')
         || case when extract(hour from t at time zone 'Asia/Seoul') < 12 then '오전 ' else '오후 ' end
         || to_char(t at time zone 'Asia/Seoul', 'FMHH12:MI:SS')
$$;

-- ── 로그인 전에 쓰는 것(anon) ──
-- 로그인 화면용 강사 이름 목록(계좌번호 등은 안 줌)
create or replace function public.teacher_names() returns table(name text, region text)
language sql stable security definer set search_path = '' as $$
  select t.name, t.region from public.teachers t where t.deleted_at is null order by t.id
$$;
create or replace function public.account_exists(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.name = btrim(p_name))
$$;

-- 시도 제한(비밀번호 찾기)
create table if not exists private.reset_attempts (name text not null, at timestamptz not null default now(), ok boolean not null);

-- 비밀번호 찾기: 이름 + 계좌 끝 4자리(서버가 확인, 틀리면 1시간에 5번까지)
create or replace function public.reset_password(p_name text, p_last4 text, p_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare acc text; n text := btrim(p_name);
begin
  if p_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'message', '잘못된 요청'); end if;
  if (select count(*) from private.reset_attempts where name = n and not ok and at > now() - interval '1 hour') >= 5 then
    return jsonb_build_object('ok', false, 'locked', true, 'message', '확인을 여러 번 틀려서 1시간 동안 잠겼어요. 관리자에게 문의해주세요.');
  end if;
  select a.account into acc from public.teacher_accounts a join public.teachers t on t.name = a.teacher_name
   where a.teacher_name = n and t.deleted_at is null;
  if acc is null or length(regexp_replace(acc, '\D', '', 'g')) < 4 then
    return jsonb_build_object('ok', false, 'noAccount', true, 'message', '등록된 계좌 정보가 없어 본인확인이 어려워요. 관리자에게 문의해주세요.');
  end if;
  if right(regexp_replace(acc, '\D', '', 'g'), 4) <> regexp_replace(coalesce(p_last4, ''), '\D', '', 'g') then
    insert into private.reset_attempts(name, ok) values (n, false);
    return jsonb_build_object('ok', false, 'mismatch', true, 'message', '계좌번호 끝 4자리가 일치하지 않습니다');
  end if;
  insert into private.reset_attempts(name, ok) values (n, true);
  if not private.set_login_password(n, p_hash) then perform private.create_login(n, p_hash); end if;
  return jsonb_build_object('ok', true);
end $$;

-- 가입: 명단에 있는 강사가 처음 가입 → 계정 만들기(이미 계정이 있으면 덮어쓰지 않음)
--       명단에 없으면 → 가입 대기
create or replace function public.signup_request(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n text := btrim(coalesce(p->>'name', '')); h text := coalesce(p->>'hashedPw', '');
begin
  if n = '' or h !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'message', '이름·비밀번호를 확인해주세요'); end if;
  if exists (select 1 from public.profiles where name = n) then
    return jsonb_build_object('ok', false, 'registered', true, 'message', '이미 가입된 계정이 있습니다');
  end if;
  if exists (select 1 from public.teachers where name = n and deleted_at is null) then
    perform private.create_login(n, h);
    return jsonb_build_object('ok', true, 'existing', true, 'message', '기존 강사 비밀번호 설정 완료');
  end if;
  delete from public.signup_requests where name = n and status = '대기';
  insert into public.signup_requests(name, pw_hash, region, hire_date, account, subject, phone, address, status)
  values (n, h, p->>'region', p->>'hireDate', p->>'account', p->>'subject', p->>'phone', p->>'address', '대기');
  return jsonb_build_object('ok', true, 'pending', true, 'message', '가입 신청 완료(관리자 승인 대기)');
end $$;

-- ── 관리자 전용 ──
create or replace function private.require_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception '관리자만 할 수 있어요' using errcode = '42501'; end if;
end $$;

create or replace function public.approve_signup(p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.signup_requests;
begin
  perform private.require_admin();
  select * into r from public.signup_requests where name = btrim(p_name) and status <> '승인' order by requested_at desc limit 1;
  if r.id is null then return jsonb_build_object('ok', false, 'message', '대기 신청 없음'); end if;
  insert into public.teachers(name, region, data)
  values (r.name, coalesce(r.region, ''), jsonb_build_object('name', r.name, 'region', coalesce(r.region, ''), 'feeType', 'pct', 'feeVal', 0,
          'hireDate', coalesce(r.hire_date, ''), 'raiseDate', '', 'subject', coalesce(r.subject, ''), 'phone', coalesce(r.phone, ''), 'address', coalesce(r.address, '')))
  on conflict (name) do update set deleted_at = null;
  insert into public.teacher_accounts(teacher_name, account) values (r.name, coalesce(r.account, ''))
  on conflict (teacher_name) do update set account = excluded.account, updated_at = now();
  if not exists (select 1 from public.profiles where name = r.name) then perform private.create_login(r.name, r.pw_hash);
  else perform private.set_login_password(r.name, r.pw_hash); end if;
  delete from public.signup_requests where id = r.id;
  return jsonb_build_object('ok', true, 'message', r.name || ' 승인 완료');
end $$;

create or replace function public.admin_set_password(p_name text, p_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  if p_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'message', '잘못된 요청'); end if;
  if private.set_login_password(btrim(p_name), p_hash) then return jsonb_build_object('ok', true, 'isChange', true); end if;
  if exists (select 1 from public.teachers where name = btrim(p_name) and deleted_at is null) then
    perform private.create_login(btrim(p_name), p_hash); return jsonb_build_object('ok', true, 'isChange', false);
  end if;
  return jsonb_build_object('ok', false, 'message', '없는 강사');
end $$;

-- 월별 정산 저장: GAS 규칙 그대로(빈 데이터 거부, 더 옛 저장본 거부, 강사 급감 차단) + 이전본 자동 보관
create or replace function public.save_monthly_settlement(p_ym text, p_data jsonb, p_saved_at text, p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cur public.monthly_settlements; new_n int; old_n int; in_ts timestamptz; old_ts timestamptz;
begin
  perform private.require_admin();
  new_n := coalesce(jsonb_array_length(case when jsonb_typeof(p_data->'teachers') = 'array' then p_data->'teachers' end), 0);
  if not p_force and new_n = 0 then
    return jsonb_build_object('ok', false, 'rejected', true, 'message', p_ym || ' 저장 거부: 강사 0명(빈 데이터)');
  end if;
  select * into cur from public.monthly_settlements where year_month = p_ym for update;
  if cur.year_month is not null then
    old_n := coalesce(jsonb_array_length(case when jsonb_typeof(cur.data->'teachers') = 'array' then cur.data->'teachers' end), 0);
    in_ts := private.ko_ts(p_saved_at); old_ts := coalesce(private.ko_ts(cur.saved_at_text), cur.saved_at);
    if not p_force and in_ts is not null and old_ts is not null and in_ts < old_ts then
      return jsonb_build_object('ok', false, 'rejected', true, 'stale', true, 'message', p_ym || ' 저장 거부: 서버가 더 최신');
    end if;
    if not p_force and old_n >= 6 and new_n < old_n and (old_n - new_n) >= greatest(3, ceil(old_n * 0.05)) then
      return jsonb_build_object('ok', false, 'blocked', true, 'reason', 'drop', 'curCount', old_n,
                                'message', p_ym || ' 저장 차단: 서버 ' || old_n || '명 → 요청 ' || new_n || '명 급감');
    end if;
    update public.monthly_settlements set data = p_data, saved_at = coalesce(in_ts, now()),
           saved_at_text = coalesce(nullif(p_saved_at, ''), to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
     where year_month = p_ym;
  else
    insert into public.monthly_settlements(year_month, data, saved_at, saved_at_text)
    values (p_ym, p_data, coalesce(private.ko_ts(p_saved_at), now()),
            coalesce(nullif(p_saved_at, ''), to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  end if;
  return jsonb_build_object('ok', true, 'message', p_ym || ' 정산 데이터 저장 완료');
end $$;

create or replace function public.delete_monthly_settlement(p_ym text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cur public.monthly_settlements;
begin
  perform private.require_admin();
  select * into cur from public.monthly_settlements where year_month = p_ym;
  if cur.year_month is null then return jsonb_build_object('ok', false, 'message', '파일 없음'); end if;
  insert into public.settlement_history(year_month, data, saved_at, version, archived_by)
  values (cur.year_month, cur.data, cur.saved_at, cur.version, '삭제 전 보관: ' || private.actor());
  delete from public.monthly_settlements where year_month = p_ym;
  return jsonb_build_object('ok', true, 'message', '삭제 완료');
end $$;

create or replace function public.finalize_settlement(p_teacher text, p_ym text, p_note text, p_notes_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare sid bigint;
begin
  perform private.require_admin();
  select id into sid from public.submissions where teacher_name = btrim(p_teacher) and year_month = btrim(p_ym)
   order by submitted_at desc nulls last, id desc limit 1;
  if sid is null then return jsonb_build_object('ok', false, 'message', '해당 제출 이력 없음'); end if;
  update public.submissions
     set data = data || case when p_note is not null then jsonb_build_object('note', p_note) else '{}'::jsonb end
                     || case when p_notes_data is not null then jsonb_build_object('notesData', p_notes_data) else '{}'::jsonb end,
         is_finalized = true, finalized_at_text = private.kst_text(now())
   where id = sid;
  return jsonb_build_object('ok', true, 'message', p_teacher || ' ' || p_ym || ' 정산 완료 처리됨',
                            'finalizedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end $$;

-- 계좌매칭: 매핑 전체 교체(한 번에), 회차별 입금내역 교체
create or replace function public.dep_save_mappings(p_mappings jsonb, p_seen jsonb, p_periods jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cur jsonb; n int;
begin
  perform private.require_admin();
  if jsonb_typeof(p_seen) = 'array' then
    select value into cur from public.deposit_meta where key = 'seenCenters';
    insert into public.deposit_meta(key, value)
    values ('seenCenters', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from (
              select jsonb_array_elements_text(coalesce(cur, '[]'::jsonb)) x union select jsonb_array_elements_text(p_seen)) s))
    on conflict (key) do update set value = excluded.value;
  end if;
  if jsonb_typeof(p_periods) = 'array' then
    insert into public.deposit_meta(key, value) values ('periods', p_periods) on conflict (key) do update set value = excluded.value;
  end if;
  delete from public.deposit_mappings where true;   -- 전체 교체(Supabase 안전장치: 조건 필요)
  insert into public.deposit_mappings(map_id, branch_key, branch_raw, center_name, region, gijae_samples, is_excluded, note, registered_at, last_matched_at, data)
  select m->>'mapId', m->>'branchKey', m->>'branchRaw', m->>'centerName', m->>'region',
         array(select jsonb_array_elements_text(case when jsonb_typeof(m->'gijaeSamples') = 'array' then m->'gijaeSamples' else '[]'::jsonb end)),
         coalesce((m->>'isExcluded')::boolean, false), m->>'note', m->>'registeredAt', m->>'lastMatchedAt', m
  from jsonb_array_elements(coalesce(p_mappings, '[]'::jsonb)) m
  where coalesce(m->>'mapId', '') <> ''
  on conflict (map_id) do nothing;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'count', n);
end $$;

create or replace function public.dep_save_records(p_periods jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text; n int := 0; c int;
begin
  perform private.require_admin();
  for k in select jsonb_object_keys(coalesce(p_periods, '{}'::jsonb)) loop
    delete from public.deposit_records where period_id = k;
    insert into public.deposit_records(period_id, account, date, time, summary, depositor_name, branch_raw, branch_key, amount, match_status, matched_center_name, region)
    select k, m->>'account', m->>'date', m->>'time', m->>'summary', m->>'depositorName', m->>'branchRaw', m->>'branchKey',
           coalesce((nullif(regexp_replace(coalesce(m->>'amount', ''), '[^0-9.-]', '', 'g'), ''))::numeric, 0)::bigint,
           coalesce(nullif(m->>'matchStatus', ''), 'unmatched'), nullif(m->>'matchedCenterName', ''), coalesce(m->>'region', '')
    from jsonb_array_elements(case when jsonb_typeof(p_periods->k) = 'array' then p_periods->k else '[]'::jsonb end) m;
    get diagnostics c = row_count; n := n + c;
  end loop;
  return jsonb_build_object('ok', true, 'periods', (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_object_keys(coalesce(p_periods, '{}'::jsonb)) x), 'count', n);
end $$;

-- ── 강사 본인도 쓰는 것 ──
-- 임시저장: 더 최신일 때만(계좌번호는 저장 안 함)
create or replace function public.save_draft(p_teacher text, p_draft jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n text := btrim(p_teacher); ts bigint := coalesce((p_draft->>'savedTs')::bigint, (extract(epoch from now()) * 1000)::bigint);
begin
  if n = '' or not (n = private.my_name() or private.is_admin()) then return jsonb_build_object('ok', false, 'message', '권한 없음'); end if;
  if exists (select 1 from public.drafts where teacher_name = n and coalesce(saved_ts, 0) > ts) then return jsonb_build_object('ok', true, 'skipped', true); end if;
  insert into public.drafts(teacher_name, saved_ts, data) values (n, ts, p_draft - 'account')
  on conflict (teacher_name) do update set saved_ts = excluded.saved_ts, data = excluded.data, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- 강사 정보 한 칸만(매뉴얼 봄 등) — 통째 저장으로 옛 값을 덮어쓰지 않게
create or replace function public.set_teacher_flag(p_name text, p_key text, p_value jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n text := btrim(p_name);
begin
  if p_key not in ('menualSeen') then return jsonb_build_object('ok', false, 'message', '바꿀 수 없는 항목'); end if;
  if not (n = private.my_name() or private.is_admin()) then return jsonb_build_object('ok', false, 'message', '권한 없음'); end if;
  update public.teachers set data = jsonb_set(data, array[p_key], p_value, true) where name = n and data->p_key is distinct from p_value;
  return jsonb_build_object('ok', true);
end $$;

-- 수업기록표 제출: 대기열 + 이력에 함께(본인만, 관리자는 대리 가능)
create or replace function public.submit_record(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n text := btrim(coalesce(p_data->>'name', p_data->>'teacher', '')); ym text := coalesce(p_data->>'yearMonth', ''); at text := private.kst_text(now());
begin
  if n = '' or ym = '' then return jsonb_build_object('ok', false, 'message', '이름·연월 없음'); end if;
  if not (n = private.my_name() or private.is_admin()) then return jsonb_build_object('ok', false, 'message', '권한 없음'); end if;
  insert into public.submission_queue(teacher_name, year_month, submitted_at_text, data, reflected, rev_count) values (n, ym, at, p_data, 'N', 0);
  insert into public.submissions(teacher_name, year_month, submitted_at, submitted_at_text, by_admin, data)
  values (n, ym, now(), at, coalesce((p_data->>'byAdmin')::boolean, false), p_data);
  return jsonb_build_object('ok', true, 'message', '제출 완료', 'isRevision', false, 'revCount', 0);
end $$;

-- 면접 신청(한 시간대 한 명, 1인 1시간) / 취소(이름+연락처 확인)
create or replace function public.recruit_apply(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d text := coalesce(p->>'date', ''); t text := coalesce(p->>'time', ''); n text := btrim(coalesce(p->>'name', ''));
        ph text := btrim(coalesce(p->>'phone', '')); digits text := regexp_replace(coalesce(p->>'phone', ''), '\D', '', 'g'); r record;
begin
  if d = '' or t = '' or n = '' or ph = '' then return jsonb_build_object('ok', false, 'message', '이름·연락처·시간을 확인해주세요'); end if;
  select * into r from public.recruit_applications where interview_date = d and slot = t and status not like '취소%' order by id limit 1;
  if found then
    if r.name = n and regexp_replace(r.phone, '\D', '', 'g') = digits then return jsonb_build_object('ok', true, 'already', true); end if;
    return jsonb_build_object('ok', false, 'taken', true, 'message', '이미 신청된 시간이에요');
  end if;
  select * into r from public.recruit_applications where interview_date = d and name = n and regexp_replace(phone, '\D', '', 'g') = digits and status not like '취소%' limit 1;
  if found then return jsonb_build_object('ok', false, 'dup', true, 'time', r.slot, 'message', '이미 ' || r.slot || '에 신청했어요'); end if;
  insert into public.recruit_applications(interview_date, slot, name, phone, status) values (d, t, n, ph, '신청');
  return jsonb_build_object('ok', true);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'taken', true, 'message', '이미 신청된 시간이에요');
end $$;

create or replace function public.recruit_cancel(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d text := coalesce(p->>'date', ''); t text := coalesce(p->>'time', ''); n text := btrim(coalesce(p->>'name', ''));
        digits text := regexp_replace(coalesce(p->>'phone', ''), '\D', '', 'g'); times jsonb;
begin
  if d = '' or n = '' or digits = '' then return jsonb_build_object('ok', false, 'message', '이름·연락처를 확인해주세요'); end if;
  with u as (
    update public.recruit_applications set status = '취소 ' || to_char(now() at time zone 'Asia/Seoul', 'MM/DD HH24:MI')
     where interview_date = d and name = n and regexp_replace(phone, '\D', '', 'g') = digits and status not like '취소%'
       and (t = '' or slot = t)
    returning slot)
  select coalesce(jsonb_agg(slot), '[]'::jsonb) into times from u;
  if jsonb_array_length(times) = 0 then return jsonb_build_object('ok', false, 'notFound', true, 'message', '이름·연락처가 맞는 신청이 없어요'); end if;
  return jsonb_build_object('ok', true, 'count', jsonb_array_length(times), 'times', times);
end $$;

-- 실행 권한
revoke all on function public.teacher_names(), public.account_exists(text), public.reset_password(text, text, text), public.signup_request(jsonb),
  public.approve_signup(text), public.admin_set_password(text, text), public.save_monthly_settlement(text, jsonb, text, boolean),
  public.delete_monthly_settlement(text), public.finalize_settlement(text, text, text, jsonb), public.dep_save_mappings(jsonb, jsonb, jsonb),
  public.dep_save_records(jsonb), public.save_draft(text, jsonb), public.set_teacher_flag(text, text, jsonb), public.submit_record(jsonb),
  public.recruit_apply(jsonb), public.recruit_cancel(jsonb) from public;
grant execute on function public.teacher_names(), public.account_exists(text), public.reset_password(text, text, text), public.signup_request(jsonb)
  to anon, authenticated;
grant execute on function public.approve_signup(text), public.admin_set_password(text, text), public.save_monthly_settlement(text, jsonb, text, boolean),
  public.delete_monthly_settlement(text), public.finalize_settlement(text, text, text, jsonb), public.dep_save_mappings(jsonb, jsonb, jsonb),
  public.dep_save_records(jsonb), public.save_draft(text, jsonb), public.set_teacher_flag(text, text, jsonb), public.submit_record(jsonb),
  public.recruit_apply(jsonb), public.recruit_cancel(jsonb) to authenticated;
grant execute on all functions in schema private to service_role;

-- ── 영수증 사진(저장소) 권한: 본인 영수증·관리자 ──
create policy receipts_read on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and ((select private.is_admin())
        or name like 'u/' || (select auth.uid())::text || '/%'
        or exists (select 1 from public.receipts r where r.storage_path = 'receipts/' || storage.objects.name and r.teacher_name = (select private.my_name()))));
create policy receipts_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and name like 'u/' || (select auth.uid())::text || '/%');
create policy legacy_admin_read on storage.objects for select to authenticated
  using (bucket_id = 'legacy' and (select private.is_admin()));

-- 관리자는 영수증 사진 지우기 가능(정리용)
create policy receipts_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and (select private.is_admin()));
