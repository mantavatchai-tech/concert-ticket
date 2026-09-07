-- Run in Supabase SQL Editor AFTER security-upgrade.sql.
-- Replace the placeholder locally; never commit a file containing your password.
do $$
declare chosen_password text := 'REPLACE_WITH_YOUR_OWN_PASSWORD';
begin
  if chosen_password='REPLACE_WITH_YOUR_OWN_PASSWORD' or octet_length(chosen_password) not between 12 and 72 then
    raise exception 'Replace the placeholder with your own 12–72 byte password first';
  end if;
  insert into public.admin_users(username,display_name,role,active,password_hash)
  values('admin','Administrator','admin',true,extensions.crypt(chosen_password,extensions.gen_salt('bf',10)))
  on conflict(username) do update set role='admin',active=true,password_hash=excluded.password_hash,failed_attempts=0,locked_until=null;
  delete from public.admin_sessions where user_id in(select id from public.admin_users where username='admin');
end $$;
