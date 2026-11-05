-- Cole TUDO isto no Supabase > SQL Editor > New query.
-- Antes de Run: troque COLE_AQUI_A_SENHA_PROVISORIA pela senha que a equipe já usa.
-- Essa senha não vai para o site; fica só no banco, lida pela função da supervisão.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.painel_secrets (
  k text primary key,
  v text not null
);
alter table public.painel_secrets enable row level security;
revoke all on table public.painel_secrets from public, anon, authenticated;

insert into public.painel_secrets (k, v) values
  ('temp_password', 'COLE_AQUI_A_SENHA_PROVISORIA')
on conflict (k) do update
  set v = excluded.v
  where excluded.v <> 'COLE_AQUI_A_SENHA_PROVISORIA'
     or public.painel_secrets.v = 'COLE_AQUI_A_SENHA_PROVISORIA';

drop policy if exists team_emails_select_sup on public.team_emails;
create policy team_emails_select_sup on public.team_emails
  for select to authenticated
  using ( public.is_sup() );

create or replace function public.listar_acessos()
returns table (email text, nome text, role text)
language sql
stable
security definer
set search_path = public
as $$
  select t.email, t.nome, t.role
  from public.team_emails t
  where public.is_sup();
$$;

create or replace function public.autorizar_membro(
  p_email text,
  p_nome text default null,
  p_role text default 'equipe'
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  em text := lower(trim(coalesce(p_email, '')));
  rl text := case when p_role = 'supervisao' then 'supervisao' else 'equipe' end;
  senha text;
  uid uuid;
  created boolean := false;
begin
  if not public.is_sup() then
    raise exception 'somente a supervisão autoriza' using errcode = '42501';
  end if;
  if em = '' or position('@' in em) = 0 then
    raise exception 'cadastre um e-mail válido nessa pessoa' using errcode = '22023';
  end if;

  select v into senha from public.painel_secrets where k = 'temp_password';
  if senha is null or length(senha) < 8 or senha = 'COLE_AQUI_A_SENHA_PROVISORIA' then
    raise exception 'defina a senha provisória em painel_secrets (temp_password)' using errcode = '22023';
  end if;

  insert into public.team_emails (email, nome, role)
  values (em, nullif(trim(coalesce(p_nome, '')), ''), rl)
  on conflict (email) do update
    set nome = coalesce(excluded.nome, public.team_emails.nome),
        role = excluded.role;

  select id into uid from auth.users where lower(email) = em limit 1;

  if uid is null then
    uid := gen_random_uuid();

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at, last_sign_in_at,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      raw_app_meta_data, raw_user_meta_data
    ) values (
      '00000000-0000-0000-0000-000000000000'::uuid, uid, 'authenticated', 'authenticated', em,
      crypt(senha, gen_salt('bf')),
      now(), now(), now(), now(),
      '', '', '', '',
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('nome', coalesce(nullif(trim(coalesce(p_nome, '')), ''), split_part(em, '@', 1)))
    );

    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), uid,
      jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true),
      'email', uid::text,
      now(), now(), now()
    );
    created := true;
  else
    update auth.users
       set encrypted_password = crypt(senha, gen_salt('bf')),
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           updated_at = now()
     where id = uid;
  end if;

  update public.profiles
     set role = rl,
         nome = coalesce(nullif(trim(coalesce(p_nome, '')), ''), nome),
         email = em
   where id = uid or lower(email) = em;

  insert into public.profiles (id, email, nome, role)
  values (
    uid, em,
    coalesce(nullif(trim(coalesce(p_nome, '')), ''), split_part(em, '@', 1)),
    rl
  )
  on conflict (id) do update
    set role = excluded.role,
        nome = coalesce(excluded.nome, public.profiles.nome),
        email = excluded.email;

  return jsonb_build_object('ok', true, 'created', created, 'email', em, 'role', rl);
end $$;

revoke all on function public.listar_acessos() from public, anon;
revoke all on function public.autorizar_membro(text, text, text) from public, anon;
grant execute on function public.listar_acessos() to authenticated;
grant execute on function public.autorizar_membro(text, text, text) to authenticated;
