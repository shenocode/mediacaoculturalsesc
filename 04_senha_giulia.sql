-- Cole no Supabase > SQL Editor > Run.
-- Mostra uma linha no final: ou a conta ficou pronta, ou diz o que faltou.

create extension if not exists pgcrypto with schema extensions;

with senha as (
  select v as pw
  from public.painel_secrets
  where k = 'temp_password' and length(v) >= 8
),
existente as (
  select id, email
  from auth.users
  where lower(email) = 'producaogiuliazen@gmail.com'
),
criada as (
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    raw_app_meta_data, raw_user_meta_data
  )
  select
    '00000000-0000-0000-0000-000000000000'::uuid,
    gen_random_uuid(),
    'authenticated', 'authenticated',
    'producaogiuliazen@gmail.com',
    extensions.crypt(s.pw, extensions.gen_salt('bf')),
    now(), now(), now(),
    '', '', '', '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"nome":"Giulia Zen"}'::jsonb
  from senha s
  where not exists (select 1 from existente)
  returning id, email
),
alvo as (
  select id, email from existente
  union all
  select id, email from criada
),
upd as (
  update auth.users u
     set encrypted_password = extensions.crypt(s.pw, extensions.gen_salt('bf')),
         email_confirmed_at = coalesce(u.email_confirmed_at, now()),
         updated_at = now()
    from senha s, alvo a
   where u.id = a.id
  returning u.id, u.email
),
ident as (
  insert into auth.identities (
    id, user_id, identity_data, provider, provider_id, created_at, updated_at
  )
  select gen_random_uuid(), u.id,
         jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
         'email', u.id::text, now(), now()
  from upd u
  where not exists (
    select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email'
  )
  returning user_id
),
perfil as (
  insert into public.profiles (id, email, nome, role)
  select u.id, u.email, 'Giulia Zen', 'equipe'
  from upd u
  on conflict (id) do update
    set role = 'equipe', email = excluded.email, nome = coalesce(public.profiles.nome, excluded.nome)
  returning id
)
select case
         when not exists (select 1 from senha) then 'senha provisória ausente'
         when exists (select 1 from upd) then (select email from upd limit 1) || ' — pode entrar com a senha provisória'
         else 'não foi possível criar a conta'
       end as resultado,
       (select count(*) from ident) as identidades_novas,
       (select count(*) from perfil) as perfil;
