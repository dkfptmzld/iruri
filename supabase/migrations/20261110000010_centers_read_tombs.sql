-- 강사 기기도 '삭제된 센터 목록'(이름·지역)을 받아 캐시에서 지울 수 있게: 삭제 표시된 센터도 읽기 허용
-- (지금 GAS getCenters 도 삭제기록(tombs)을 모든 기기에 내려줌)
drop policy if exists all_read on public.centers;
create policy all_read on public.centers for select to authenticated using (true);
