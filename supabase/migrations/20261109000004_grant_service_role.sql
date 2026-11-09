-- '새 테이블 자동 표시'를 끈 프로젝트라 서버 키(service_role)에도 권한을 직접 줘야 함
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
-- 앞으로 만드는 테이블도 서버 키는 자동으로 사용 가능(앱 사용자 권한은 계속 직접 지정)
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;
-- 저장 때 자동으로 도는 버전 확인·변경 기록 함수(private)도 서버 키가 쓸 수 있게
grant usage on schema private to service_role;
grant execute on all functions in schema private to service_role;
