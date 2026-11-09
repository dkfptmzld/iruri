-- 버전 확인을 '접속한 역할' 기준으로: 앱 사용자(authenticated/anon)만 확인, 서버 키·관리 접속은 자동 +1
create or replace function private.check_version() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    if new.version is distinct from old.version + 1 then
      raise exception 'stale_version: 서버에 더 최신 내용이 있어요 (서버 %, 기기 %)', old.version, new.version - 1
        using errcode = 'P0409', hint = '최신 내용을 다시 불러온 뒤 저장해 주세요';
    end if;
  else
    new.version := old.version + 1;
  end if;
  new.updated_at := now();
  new.updated_by := private.actor();
  return new;
end $$;

create or replace function private.actor() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.name from public.profiles p where p.id = (select auth.uid())),
                  (select auth.jwt()) ->> 'role', 'db')
$$;

-- 프로젝트 생성 때 자동으로 생긴 함수: API로 호출할 수 없게
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

-- ── 원본 그대로 보관(빠짐없이 옮기기 위한 안전장치) ──
-- 구글 시트 모든 탭의 모든 행을 칸 그대로
create table public.legacy_sheet_rows (
  sheet text not null,
  row_no integer not null,             -- 시트 행 번호(1 = 머리글)
  cells jsonb not null,                -- ["A칸","B칸",...] 보이는 값 그대로
  imported_at timestamptz not null default now(),
  primary key (sheet, row_no)
);
-- 드라이브 파일(월별 정산 JSON·백업본 등) 원본 그대로
create table public.legacy_files (
  drive_id text primary key,
  name text not null,
  folder text,
  mime_type text,
  modified_at timestamptz,
  size_bytes bigint,
  content text,                         -- 글자 파일은 내용 그대로
  storage_path text,                    -- 사진 등은 저장소 경로
  imported_at timestamptz not null default now()
);
alter table public.legacy_sheet_rows enable row level security;
alter table public.legacy_files enable row level security;
create policy admin_read on public.legacy_sheet_rows for select to authenticated using ((select private.is_admin()));
create policy admin_read on public.legacy_files for select to authenticated using ((select private.is_admin()));
revoke all on public.legacy_sheet_rows, public.legacy_files from anon, authenticated;
grant select on public.legacy_sheet_rows, public.legacy_files to authenticated;
