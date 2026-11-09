-- GAS 원본 복사 준비
alter table public.legacy_sheet_rows add column if not exists vals jsonb;   -- 실제 값(날짜는 ISO 문자열)
alter table public.legacy_files add column if not exists drive_url text;

-- 복사 진행 기록(GAS가 남김, 관리자만 읽기)
create table public.legacy_import_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  step text not null,
  detail jsonb
);
alter table public.legacy_import_log enable row level security;
create policy admin_read on public.legacy_import_log for select to authenticated using ((select private.is_admin()));
revoke all on public.legacy_import_log from anon, authenticated;
grant select on public.legacy_import_log to authenticated;

-- 파일 저장소(비공개): 영수증 / 그 밖의 드라이브 원본
insert into storage.buckets (id, name, public, file_size_limit)
values ('receipts', 'receipts', false, 52428800),
       ('legacy',   'legacy',   false, 52428800)
on conflict (id) do nothing;
