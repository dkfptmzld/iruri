-- 제출이력에 '정산완료' 칸이 없는 행(빈 값) 때문에 정리가 멈추지 않도록
alter table public.submissions alter column is_finalized drop not null;
alter table public.submissions alter column is_finalized set default false;
