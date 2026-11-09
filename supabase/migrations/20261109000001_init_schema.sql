-- 이루리 정산 시스템 — Supabase 초기 구조 (1단계: 테이블·권한)
-- 원칙
--  · 한 건씩 저장(목록 통째 덮어쓰기 없음)
--  · 강사·센터·월별정산은 version 으로 '옛 기기의 덮어쓰기'를 서버가 거절
--  · 강사·센터는 지우지 않고 deleted_at 표시(복구 가능)
--  · 누가 무엇을 바꿨는지 change_log 에 자동 기록
--  · 모든 테이블 RLS: 강사는 본인 것만, 관리자는 전체

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;

-- ── 사용자(로그인 계정) ──
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null unique,
  role text not null default 'teacher' check (role in ('teacher','admin')),
  caps jsonb not null default '{}'::jsonb,          -- 세부 권한(예: {"admin":true,"deposit":true})
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

-- 권한 확인 함수(정책에서 사용, API로는 노출 안 됨)
create or replace function private.my_name() returns text
language sql stable security definer set search_path = '' as $$
  select p.name from public.profiles p where p.id = (select auth.uid())
$$;
create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p
                 where p.id = (select auth.uid())
                   and (p.role = 'admin' or coalesce((p.caps->>'admin')::boolean, false)))
$$;
create or replace function private.actor() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.name from public.profiles p where p.id = (select auth.uid())),
                  (select auth.jwt()) ->> 'role', current_user)
$$;
grant execute on function private.my_name(), private.is_admin(), private.actor() to anon, authenticated;

-- ── 버전 확인: 앱은 version = (내가 본 version + 1) 로 저장. 서버가 그사이 바뀌었으면 거절 ──
--   서버 키(GAS 따라 저장·데이터 이전)는 확인 없이 자동 +1
create or replace function private.check_version() returns trigger
language plpgsql set search_path = '' as $$
declare r text := coalesce((select auth.jwt()) ->> 'role', 'db');
begin
  if r in ('service_role', 'db') then
    new.version := old.version + 1;
  elsif new.version is distinct from old.version + 1 then
    raise exception 'stale_version: 서버에 더 최신 내용이 있어요 (서버 %, 기기 %)', old.version, new.version - 1
      using errcode = 'P0409', hint = '최신 내용을 다시 불러온 뒤 저장해 주세요';
  end if;
  new.updated_at := now();
  new.updated_by := private.actor();
  return new;
end $$;

-- ── 변경 기록 ──
create table public.change_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  table_name text not null,
  row_key text not null,
  action text not null,           -- insert / update / delete
  actor text,
  old_data jsonb,
  new_data jsonb
);
create index change_log_lookup on public.change_log (table_name, row_key, at desc);

create or replace function private.log_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare k text; r jsonb;
begin
  r := to_jsonb(coalesce(new, old));
  if tg_table_name = 'centers' then k := (r->>'name') || '|' || coalesce(r->>'region', '');
  elsif tg_table_name = 'settings' then k := r->>'key';
  else k := r->>'name';
  end if;
  insert into public.change_log(table_name, row_key, action, actor, old_data, new_data)
  values (tg_table_name, k, lower(tg_op), private.actor(),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

-- ── 강사 ──
create table public.teachers (
  id bigint generated always as identity primary key,
  name text not null unique,
  region text not null default '',
  data jsonb not null default '{}'::jsonb,         -- 앱의 강사 객체(계좌 제외)
  deleted_at timestamptz,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by text
);
create trigger teachers_version before update on public.teachers for each row execute function private.check_version();
create trigger teachers_log after insert or update or delete on public.teachers for each row execute function private.log_change();

-- 계좌번호는 따로(본인·관리자만)
create table public.teacher_accounts (
  teacher_name text primary key references public.teachers(name) on update cascade on delete cascade,
  account text not null default '',
  updated_at timestamptz not null default now()
);

-- ── 센터 ──
create table public.centers (
  id bigint generated always as identity primary key,
  name text not null,
  region text not null default '',
  data jsonb not null default '{}'::jsonb,         -- 앱의 센터 객체(스케줄·수업료·연락처 등)
  deleted_at timestamptz,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by text,
  unique (name, region)
);
create trigger centers_version before update on public.centers for each row execute function private.check_version();
create trigger centers_log after insert or update or delete on public.centers for each row execute function private.log_change();

-- ── 수업기록표 제출 이력 ──
create table public.submissions (
  id bigint generated always as identity primary key,
  teacher_name text not null,
  year_month text not null,                        -- '2026년 10월'
  submitted_at timestamptz,
  submitted_at_text text,                          -- 원본 표기('2026. 11. 4. 오전 10:03:27')
  by_admin boolean not null default false,
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index submissions_teacher_ym on public.submissions (teacher_name, year_month);
create index submissions_ym on public.submissions (year_month);

-- ── 월별 정산 + 이전본 보관(월별 최근 30개) ──
create table public.monthly_settlements (
  year_month text primary key,
  data jsonb not null,
  saved_at timestamptz,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by text
);
create trigger monthly_settlements_version before update on public.monthly_settlements for each row execute function private.check_version();

create table public.settlement_history (
  id bigint generated always as identity primary key,
  year_month text not null,
  data jsonb not null,
  saved_at timestamptz,
  version integer,
  archived_at timestamptz not null default now(),
  archived_by text
);
create index settlement_history_ym on public.settlement_history (year_month, archived_at desc);

create or replace function private.archive_settlement() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.settlement_history(year_month, data, saved_at, version, archived_by)
  values (old.year_month, old.data, old.saved_at, old.version, private.actor());
  delete from public.settlement_history h
   where h.year_month = old.year_month
     and h.id not in (select id from public.settlement_history
                       where year_month = old.year_month order by archived_at desc limit 30);
  return new;
end $$;
create trigger monthly_settlements_archive after update on public.monthly_settlements for each row
  when (old.data is distinct from new.data) execute function private.archive_settlement();

-- ── 임시저장(강사별 1개) ──
create table public.drafts (
  teacher_name text primary key,
  saved_ts bigint,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- ── 영수증 ──
create table public.receipts (
  id bigint generated always as identity primary key,
  teacher_name text not null,
  year_month text not null,
  file_name text not null,
  storage_path text,                               -- Supabase 저장소 경로(옮긴 뒤)
  drive_url text,                                  -- 예전 드라이브 링크
  uploaded_at timestamptz
);
create index receipts_teacher_ym on public.receipts (teacher_name, year_month);

-- ── 가입 대기 ──
create table public.signup_requests (
  id bigint generated always as identity primary key,
  name text not null,
  pw_hash text,
  region text, hire_date text, account text, subject text, phone text, address text,
  requested_at timestamptz not null default now(),
  status text not null default '대기'
);

-- ── 스케줄 수정 요청 ──
create table public.schedule_requests (
  id text primary key,
  teacher_name text not null,
  region text,
  changes jsonb,
  message text,
  requested_at timestamptz,
  status text not null default '대기',
  resolved_at timestamptz
);

-- ── 관리자 지원 면접 신청 ──
create table public.recruit_applications (
  id bigint generated always as identity primary key,
  interview_date text not null,
  slot text not null,
  name text not null,
  phone text not null,
  applied_at timestamptz not null default now(),
  status text not null default '신청'
);
create unique index recruit_one_per_slot on public.recruit_applications (interview_date, slot)
  where status not like '취소%';

-- 빈 시간 확인용(신청자 이름·연락처는 안 보여 줌)
create or replace function public.recruit_taken_slots(p_date text) returns setof text
language sql stable security definer set search_path = '' as $$
  select slot from public.recruit_applications where interview_date = p_date and status not like '취소%'
$$;

-- ── 시스템 설정(공지·점검·권한·센터메모·스케줄요청 캠페인 등) ──
create table public.settings (
  key text primary key,
  value jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);
create trigger settings_log after insert or update or delete on public.settings for each row execute function private.log_change();

-- ── 알림 토큰 · 접속 현황 ──
create table public.push_tokens (
  token text primary key,
  teacher_name text not null,
  device text,
  updated_at timestamptz not null default now()
);
create index push_tokens_teacher on public.push_tokens (teacher_name);

create table public.presence (
  teacher_name text primary key,
  last_seen timestamptz not null default now(),
  page text
);

-- ── 계좌매칭 ──
create table public.deposit_records (
  id bigint generated always as identity primary key,
  period_id text not null,
  account text, date text, time text, summary text, depositor_name text,
  branch_raw text, branch_key text,
  amount bigint not null default 0,
  match_status text not null default 'unmatched',
  matched_center_name text,
  region text
);
create index deposit_records_period on public.deposit_records (period_id);

create table public.deposit_mappings (
  map_id text primary key,
  branch_key text, branch_raw text, center_name text, region text,
  gijae_samples text[],
  is_excluded boolean not null default false,
  note text, registered_at text, last_matched_at text,
  data jsonb
);

create table public.deposit_logs (
  id text primary key,
  at timestamptz,
  data jsonb not null
);

create table public.deposit_meta (
  key text primary key,
  value jsonb
);

-- ══════════ 권한(RLS) ══════════
-- (프로젝트 설정상 새 테이블은 RLS가 자동으로 켜지지만, 명시적으로도 켠다)
do $$ declare t text;
begin
  foreach t in array array['profiles','change_log','teachers','teacher_accounts','centers','submissions',
    'monthly_settlements','settlement_history','drafts','receipts','signup_requests','schedule_requests',
    'recruit_applications','settings','push_tokens','presence','deposit_records','deposit_mappings',
    'deposit_logs','deposit_meta'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- 관리자 전체 권한(모든 테이블 공통)
do $$ declare t text;
begin
  foreach t in array array['profiles','teachers','teacher_accounts','centers','submissions',
    'monthly_settlements','settlement_history','drafts','receipts','signup_requests','schedule_requests',
    'recruit_applications','settings','push_tokens','presence','deposit_records','deposit_mappings',
    'deposit_logs','deposit_meta'] loop
    execute format('create policy admin_all on public.%I for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()))', t);
  end loop;
end $$;
create policy admin_read on public.change_log for select to authenticated using ((select private.is_admin()));

-- 강사 본인 권한
create policy self_read on public.profiles for select to authenticated using (id = (select auth.uid()));

create policy all_read on public.teachers for select to authenticated using (deleted_at is null);
create policy self_read on public.teacher_accounts for select to authenticated using (teacher_name = (select private.my_name()));
create policy self_write on public.teacher_accounts for update to authenticated
  using (teacher_name = (select private.my_name())) with check (teacher_name = (select private.my_name()));

create policy all_read on public.centers for select to authenticated using (deleted_at is null);

create policy self_read on public.submissions for select to authenticated using (teacher_name = (select private.my_name()));
create policy self_insert on public.submissions for insert to authenticated with check (teacher_name = (select private.my_name()));

create policy self_all on public.drafts for all to authenticated
  using (teacher_name = (select private.my_name())) with check (teacher_name = (select private.my_name()));

create policy self_read on public.receipts for select to authenticated using (teacher_name = (select private.my_name()));
create policy self_insert on public.receipts for insert to authenticated with check (teacher_name = (select private.my_name()));

-- 가입 신청은 로그인 전에도 가능(신청만, 조회 불가)
create policy anyone_insert on public.signup_requests for insert to anon, authenticated with check (status = '대기');

create policy self_read on public.schedule_requests for select to authenticated using (teacher_name = (select private.my_name()));
create policy self_insert on public.schedule_requests for insert to authenticated with check (teacher_name = (select private.my_name()));

create policy anyone_insert on public.recruit_applications for insert to authenticated with check (status = '신청');

-- 공지·점검은 로그인 전에도 읽기, 나머지 설정은 로그인한 사람
create policy public_read on public.settings for select to anon using (key in ('notice', 'maintenance'));
create policy auth_read on public.settings for select to authenticated using (true);
create policy self_sched_done on public.settings for insert to authenticated
  with check (key = 'schedDone|' || (select private.my_name()));
create policy self_sched_done_upd on public.settings for update to authenticated
  using (key = 'schedDone|' || (select private.my_name())) with check (key = 'schedDone|' || (select private.my_name()));

create policy self_all on public.push_tokens for all to authenticated
  using (teacher_name = (select private.my_name())) with check (teacher_name = (select private.my_name()));
create policy self_all on public.presence for all to authenticated
  using (teacher_name = (select private.my_name())) with check (teacher_name = (select private.my_name()));

-- 테이블 접근 허용(행 단위 제한은 위 RLS가 담당)
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on public.settings to anon;
grant insert on public.signup_requests to anon;
revoke all on public.change_log from authenticated;
grant select on public.change_log to authenticated;
grant usage on all sequences in schema public to authenticated, anon;
revoke execute on function public.recruit_taken_slots(text) from public, anon;
grant execute on function public.recruit_taken_slots(text) to authenticated;
