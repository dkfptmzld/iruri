-- 원본(legacy_sheet_rows / legacy_files) → 정리 테이블 변환
-- 몇 번이든 다시 실행 가능: 정리 테이블을 비우고 원본에서 다시 채운다(원본은 그대로).
-- 규칙은 GAS 조회 함수(getTeachers·getCenters·getHistory·getReceipts·depGetRecords 등)와 같게 맞춤.

-- 한국식 시각 글자 → 시각 ('2026. 4. 28. 오후 8:36:56', '2026. 11. 3 오후 12:33:51', ISO 문자열)
create or replace function private.ko_ts(t text) returns timestamptz
language plpgsql immutable set search_path = '' as $$
declare m text[]; h int;
begin
  if t is null or btrim(t) = '' then return null; end if;
  if t ~ '^\d{4}-\d{2}-\d{2}(T|\s)' then return t::timestamptz; end if;
  m := regexp_match(t, '^\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*(오전|오후)\s*(\d{1,2}):(\d{2}):(\d{2})');
  if m is not null then
    h := m[5]::int % 12; if m[4] = '오후' then h := h + 12; end if;
    return make_timestamptz(m[1]::int, m[2]::int, m[3]::int, h, m[6]::int, m[7]::double precision, 'Asia/Seoul');
  end if;
  m := regexp_match(t, '^\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*$');
  if m is not null then return make_timestamptz(m[1]::int, m[2]::int, m[3]::int, 0, 0, 0, 'Asia/Seoul'); end if;
  return null;
exception when others then return null;
end $$;

create or replace function private.try_jsonb(t text) returns jsonb
language plpgsql immutable set search_path = '' as $$
begin
  if t is null or btrim(t) = '' then return null; end if;
  return t::jsonb;
exception when others then return null;
end $$;

create or replace function private.rebuild_from_legacy() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare res jsonb := '{}'::jsonb; n int;
begin
  -- 이전 단계라 변경기록·버전 트리거는 잠시 끔(옮기는 것 자체는 '변경'이 아님)
  alter table public.teachers disable trigger user;
  alter table public.centers disable trigger user;
  alter table public.settings disable trigger user;
  alter table public.monthly_settlements disable trigger user;

  truncate public.teacher_accounts, public.teachers, public.centers, public.submissions,
           public.monthly_settlements, public.settlement_history, public.drafts, public.receipts,
           public.signup_requests, public.schedule_requests, public.recruit_applications, public.settings,
           public.push_tokens, public.presence, public.deposit_records, public.deposit_mappings,
           public.deposit_logs, public.deposit_meta restart identity;
  delete from public.change_log where table_name in ('teachers', 'centers', 'settings');

  -- ── 강사(강사DB: 강사명,지역,급여유형,급여액,입사일,인상일,계좌정보,JSON전체) ──
  with src as (
    select row_no, cells c, vals v, private.try_jsonb(vals->>7) j
    from public.legacy_sheet_rows where sheet = '강사DB' and row_no > 1 and coalesce(cells->>0, '') <> ''
  ), obj as (
    select row_no, coalesce(j, jsonb_build_object(
             'name', c->>0, 'region', coalesce(c->>1, ''), 'feeType', coalesce(nullif(c->>2, ''), 'fixed'),
             'feeVal', coalesce(case when v->>3 ~ '^-?\d+(\.\d+)?$' then (v->>3)::numeric end, 0),
             'hireDate', coalesce(c->>4, ''), 'raiseDate', coalesce(c->>5, ''), 'account', coalesce(c->>6, ''))) o,
           c
    from src
  )
  insert into public.teachers(name, region, data)
  select coalesce(o->>'name', c->>0), coalesce(o->>'region', c->>1, ''), o - 'account'
  from obj order by row_no
  on conflict (name) do nothing;
  get diagnostics n = row_count; res := res || jsonb_build_object('teachers', n);

  insert into public.teacher_accounts(teacher_name, account)
  select t.name, coalesce(nullif(private.try_jsonb(r.vals->>7)->>'account', ''), r.cells->>6, '')
  from public.legacy_sheet_rows r join public.teachers t on t.name = coalesce(private.try_jsonb(r.vals->>7)->>'name', r.cells->>0)
  where r.sheet = '강사DB' and r.row_no > 1
  on conflict (teacher_name) do nothing;

  -- ── 센터(센터DB: 14칸, 14번째 JSON전체) ──
  with src as (
    select row_no, cells c, vals v, private.try_jsonb(vals->>13) j
    from public.legacy_sheet_rows where sheet = '센터DB' and row_no > 1 and coalesce(cells->>0, '') <> ''
  ), obj as (
    select row_no, coalesce(j, jsonb_build_object(
             'name', c->>0, 'region', coalesce(c->>1, ''),
             'fee', coalesce(case when v->>2 ~ '^-?\d+(\.\d+)?$' then (v->>2)::numeric end, 0),
             'teachers', (select coalesce(jsonb_agg(x), '[]'::jsonb) from unnest(array[c->>3, c->>4, c->>5, c->>6]) x where btrim(coalesce(x, '')) <> ''),
             'address', coalesce(c->>7, ''), 'source', coalesce(nullif(c->>8, ''), '수동'),
             'schedule', coalesce(private.try_jsonb(c->>9), '[]'::jsonb),
             'phone', coalesce(c->>10, ''), 'email', coalesce(c->>11, ''), 'contactName', coalesce(c->>12, ''))) o
    from src
  )
  insert into public.centers(name, region, data)
  select o->>'name', coalesce(o->>'region', ''), o from obj order by row_no
  on conflict (name, region) do nothing;
  get diagnostics n = row_count; res := res || jsonb_build_object('centers', n);

  -- 센터삭제기록: 지운 센터는 '삭제 표시'로. 센터DB에도 있으면 앱은 숨기므로 똑같이 삭제 표시
  update public.centers c set deleted_at = coalesce(private.ko_ts(r.cells->>2), now())
  from public.legacy_sheet_rows r
  where r.sheet = '센터삭제기록' and r.row_no > 1 and c.name = r.cells->>0 and c.region = coalesce(r.cells->>1, '');
  get diagnostics n = row_count; res := res || jsonb_build_object('centers_tombed_but_in_db', n);
  insert into public.centers(name, region, data, deleted_at)
  select r.cells->>0, coalesce(r.cells->>1, ''), jsonb_build_object('name', r.cells->>0, 'region', coalesce(r.cells->>1, '')),
         coalesce(private.ko_ts(r.cells->>2), now())
  from public.legacy_sheet_rows r
  where r.sheet = '센터삭제기록' and r.row_no > 1 and coalesce(r.cells->>0, '') <> ''
  on conflict (name, region) do nothing;
  get diagnostics n = row_count; res := res || jsonb_build_object('centers_deleted', n);

  -- ── 수업기록표 제출 이력(제출이력: 강사명,연월,제출일시,데이터) + 제출데이터(대기열) ──
  insert into public.submissions(teacher_name, year_month, submitted_at, submitted_at_text, by_admin, data)
  select r.cells->>0, r.cells->>1, private.ko_ts(r.cells->>2), r.cells->>2,
         coalesce((private.try_jsonb(r.vals->>3)->>'byAdmin')::boolean, false),
         coalesce(private.try_jsonb(r.vals->>3), jsonb_build_object('_raw', r.vals->>3))
  from public.legacy_sheet_rows r
  where r.sheet in ('제출이력', '제출데이터') and r.row_no > 1 and coalesce(r.cells->>0, '') <> ''
  order by r.sheet, r.row_no;
  get diagnostics n = row_count; res := res || jsonb_build_object('submissions', n);

  -- ── 월별 정산(정산스냅샷 폴더: YYYY년_M월.json = 현재본, 그 밖의 .bak·.replaced = 이전본) ──
  insert into public.monthly_settlements(year_month, data, saved_at)
  select distinct on (ym) ym, cj->'data', private.ko_ts(cj->>'savedAt')
  from (select f.*, private.try_jsonb(f.content) cj,
               coalesce(private.try_jsonb(f.content)->>'yearMonth', replace(regexp_replace(f.name, '\.json$', ''), '_', ' ')) ym
        from public.legacy_files f
        where f.folder = 'snapshots' and f.name ~ '^\d{4}년_\d{1,2}월\.json$') s
  where cj ? 'data'
  order by ym, modified_at desc;
  get diagnostics n = row_count; res := res || jsonb_build_object('monthly_settlements', n);

  insert into public.settlement_history(year_month, data, saved_at, archived_at, archived_by)
  select coalesce(cj->>'yearMonth', replace(substring(f.name from '^(\d{4}년_\d{1,2}월)'), '_', ' ')),
         coalesce(cj->'data', cj), private.ko_ts(cj->>'savedAt'), f.modified_at, '드라이브 ' || f.name
  from (select f.*, private.try_jsonb(f.content) cj from public.legacy_files f
        where f.folder = 'snapshots' and f.name !~ '^\d{4}년_\d{1,2}월\.json$') f
  where cj is not null;
  get diagnostics n = row_count; res := res || jsonb_build_object('settlement_history', n);

  -- ── 임시저장(teacher, savedTs, savedAt, json1~8) ──
  insert into public.drafts(teacher_name, saved_ts, data)
  select distinct on (r.cells->>0) r.cells->>0,
         case when r.vals->>1 ~ '^\d+$' then (r.vals->>1)::bigint end,
         private.try_jsonb((select string_agg(coalesce(r.cells->>i, ''), '' order by i) from generate_series(3, 10) i))
  from public.legacy_sheet_rows r
  where r.sheet = '임시저장' and r.row_no > 1 and coalesce(r.cells->>0, '') <> ''
    and private.try_jsonb((select string_agg(coalesce(r.cells->>i, ''), '' order by i) from generate_series(3, 10) i)) is not null
  order by r.cells->>0, case when r.vals->>1 ~ '^\d+$' then (r.vals->>1)::bigint end desc nulls last;
  get diagnostics n = row_count; res := res || jsonb_build_object('drafts', n);

  -- ── 영수증(강사명,연월,파일명,Drive링크,업로드일시) + 저장소 경로 연결 ──
  insert into public.receipts(teacher_name, year_month, file_name, storage_path, drive_url, uploaded_at)
  select r.cells->>0, r.cells->>1, r.cells->>2, f.storage_path, r.cells->>3, private.ko_ts(r.cells->>4)
  from public.legacy_sheet_rows r
  left join public.legacy_files f on f.drive_id = substring(r.cells->>3 from '/d/([^/]+)')
  where r.sheet = '영수증' and r.row_no > 1 and coalesce(r.cells->>0, '') <> ''
  order by r.row_no;
  get diagnostics n = row_count; res := res || jsonb_build_object('receipts', n);

  -- ── 가입대기(이름,비번해시,지역,입사일,계좌,과목,신청일,상태,휴대폰,주소) ──
  insert into public.signup_requests(name, pw_hash, region, hire_date, account, subject, requested_at, status, phone, address)
  select c->>0, c->>1, c->>2, c->>3, c->>4, c->>5, coalesce(private.ko_ts(c->>6), now()), coalesce(nullif(c->>7, ''), '대기'), c->>8, c->>9
  from (select cells c from public.legacy_sheet_rows where sheet = '가입대기' and row_no > 1 and coalesce(cells->>0, '') <> '') s;

  -- ── 스케줄 요청 ──
  insert into public.schedule_requests(id, teacher_name, region, changes, message, requested_at, status, resolved_at)
  select c->>0, c->>1, c->>2, private.try_jsonb(c->>3), c->>4, private.ko_ts(c->>5), coalesce(nullif(c->>6, ''), '대기'), private.ko_ts(c->>7)
  from (select cells c from public.legacy_sheet_rows where sheet = '스케줄요청' and row_no > 1 and coalesce(cells->>0, '') <> '') s
  on conflict (id) do nothing;
  get diagnostics n = row_count; res := res || jsonb_build_object('schedule_requests', n);

  -- ── 면접 신청 ──
  insert into public.recruit_applications(interview_date, slot, name, phone, applied_at, status)
  select c->>0, c->>1, c->>2, c->>3, coalesce(private.ko_ts(c->>4), now()), coalesce(nullif(c->>5, ''), '신청')
  from (select row_no, cells c from public.legacy_sheet_rows where sheet = '면접신청' and row_no > 1 and coalesce(cells->>1, '') <> '' order by row_no) s
  on conflict do nothing;
  get diagnostics n = row_count; res := res || jsonb_build_object('recruit_applications', n);

  -- ── 시스템설정(머리글 없음: 키, 값) ──
  insert into public.settings(key, value)
  select r.cells->>0,
         case when jsonb_typeof(r.vals->1) = 'string' then coalesce(private.try_jsonb(r.vals->>1), r.vals->1) else r.vals->1 end
  from public.legacy_sheet_rows r
  where r.sheet = '시스템설정' and coalesce(r.cells->>0, '') <> ''
  order by r.row_no
  on conflict (key) do nothing;
  get diagnostics n = row_count; res := res || jsonb_build_object('settings', n);

  -- ── 알림 토큰 · 접속 현황 ──
  insert into public.push_tokens(token, teacher_name, device, updated_at)
  select c->>2, c->>0, c->>1, coalesce(private.ko_ts(c->>3), now())
  from (select row_no, cells c from public.legacy_sheet_rows where sheet = 'FCM토큰' and row_no > 1 and coalesce(cells->>2, '') <> '' order by row_no desc) s
  on conflict (token) do nothing;
  get diagnostics n = row_count; res := res || jsonb_build_object('push_tokens', n);

  insert into public.presence(teacher_name, last_seen, page)
  select r.cells->>0, coalesce(private.ko_ts(r.vals->>1), private.ko_ts(r.cells->>1), now()), r.cells->>2
  from public.legacy_sheet_rows r
  where r.sheet = '접속현황' and r.row_no > 1 and coalesce(r.cells->>0, '') <> ''
  on conflict (teacher_name) do nothing;
  get diagnostics n = row_count; res := res || jsonb_build_object('presence', n);

  -- ── 계좌매칭: 입금내역(앱 조회와 같게: 회차·처리점 둘 다 비면 건너뜀) ──
  insert into public.deposit_records(period_id, account, date, time, summary, depositor_name, branch_raw, branch_key,
                                     amount, match_status, matched_center_name, region)
  select c->>0, c->>1, c->>2, c->>3, c->>4, c->>5, c->>6, c->>7,
         coalesce(case when v->>8 ~ '^-?\d+(\.\d+)?$' then (v->>8)::numeric end,
                  nullif(regexp_replace(coalesce(c->>8, ''), '[^0-9.-]', '', 'g'), '')::numeric, 0)::bigint,
         coalesce(nullif(c->>9, ''), 'unmatched'), nullif(c->>10, ''), coalesce(c->>11, '')
  from (select row_no, cells c, vals v from public.legacy_sheet_rows
        where sheet = '계좌매칭_입금내역' and row_no > 1 and (coalesce(cells->>0, '') <> '' or coalesce(cells->>7, '') <> '') order by row_no) s;
  get diagnostics n = row_count; res := res || jsonb_build_object('deposit_records', n);

  insert into public.deposit_mappings(map_id, branch_key, branch_raw, center_name, region, gijae_samples, is_excluded, note,
                                      registered_at, last_matched_at, data)
  select c->>0, c->>1, c->>2, c->>3, c->>4,
         array(select x from unnest(string_to_array(coalesce(c->>5, ''), '|')) x where x <> ''),
         lower(coalesce(c->>6, '')) = 'true', c->>7, c->>8, c->>9,
         coalesce(private.try_jsonb(c->>10), jsonb_build_object('mapId', c->>0, 'branchKey', c->>1, 'branchRaw', c->>2,
                  'centerName', c->>3, 'region', c->>4, 'gijaeSamples', to_jsonb(array(select x from unnest(string_to_array(coalesce(c->>5, ''), '|')) x where x <> '')),
                  'isExcluded', lower(coalesce(c->>6, '')) = 'true', 'note', coalesce(c->>7, ''), 'registeredAt', coalesce(c->>8, ''), 'lastMatchedAt', coalesce(c->>9, '')))
  from (select row_no, cells c from public.legacy_sheet_rows where sheet = '계좌매칭_매핑' and row_no > 1 and coalesce(cells->>0, '') <> '' order by row_no) s
  on conflict (map_id) do nothing;
  get diagnostics n = row_count; res := res || jsonb_build_object('deposit_mappings', n);

  insert into public.deposit_logs(id, at, data)
  select c->>0, private.ko_ts(c->>1),
         jsonb_build_object('id', c->>0, 'at', c->>1, 'by', c->>2, 'dev', c->>3, 'kind', c->>4, 'title', c->>5, 'detail', c->>6,
                            'period', c->>7, 'ref', c->>8, 'hasUndo', c->>9,
                            'undo', nullif((select string_agg(coalesce(c->>i, ''), '' order by i) from generate_series(10, 17) i), ''))
  from (select row_no, cells c from public.legacy_sheet_rows where sheet = '계좌매칭_변경이력' and row_no > 1 and coalesce(cells->>0, '') <> '' order by row_no) s
  on conflict (id) do nothing;
  get diagnostics n = row_count; res := res || jsonb_build_object('deposit_logs', n);

  insert into public.deposit_meta(key, value)
  select r.cells->>0, coalesce(private.try_jsonb(r.cells->>1), to_jsonb(r.cells->>1))
  from public.legacy_sheet_rows r
  where r.sheet = '계좌매칭_설정' and coalesce(r.cells->>0, '') <> ''
  on conflict (key) do nothing;
  get diagnostics n = row_count; res := res || jsonb_build_object('deposit_meta', n);

  alter table public.teachers enable trigger user;
  alter table public.centers enable trigger user;
  alter table public.settings enable trigger user;
  alter table public.monthly_settlements enable trigger user;
  return res;
end $$;
revoke all on function private.rebuild_from_legacy() from public, anon, authenticated;
