-- E-mail da solicitação, aceite da LGPD e leitura dos agendamentos só para quem entrou.

create or replace function public.definir_chave_resend(p_chave text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_sup() then
    raise exception 'somente a supervisão' using errcode = '42501';
  end if;
  if p_chave is null or length(trim(p_chave)) < 20 then
    raise exception 'cole a chave completa' using errcode = '22023';
  end if;
  insert into public.painel_secrets (k, v)
  values ('resend_api_key', trim(p_chave))
  on conflict (k) do update set v = excluded.v;
end;
$$;

create or replace function public.chave_resend()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select v from public.painel_secrets where k = 'resend_api_key';
$$;

create or replace function public.definir_aviso_visita(p_email text, p_de text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  email text := lower(left(trim(coalesce(p_email, '')), 120));
  remetente text := left(regexp_replace(coalesce(p_de, ''), '[\r\n]+', ' ', 'g'), 160);
begin
  if not public.is_sup() then
    raise exception 'somente a supervisão' using errcode = '42501';
  end if;
  if email <> '' and email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' then
    raise exception 'informe um e-mail válido' using errcode = '22023';
  end if;
  if trim(remetente) = '' then
    remetente := 'Mediação Cultural Sesc <onboarding@resend.dev>';
  end if;
  if remetente !~ '@' then
    raise exception 'o remetente precisa ter um e-mail' using errcode = '22023';
  end if;
  insert into public.painel_secrets (k, v) values ('visita_email', email)
  on conflict (k) do update set v = excluded.v;
  insert into public.painel_secrets (k, v) values ('visita_de', trim(remetente))
  on conflict (k) do update set v = excluded.v;
end;
$$;

create or replace function public.aviso_visita()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' and not public.is_sup() then
    raise exception 'somente a supervisão' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'email', coalesce((select v from public.painel_secrets where k = 'visita_email'), ''),
    'de', coalesce((select v from public.painel_secrets where k = 'visita_de'), '')
  );
end;
$$;

create or replace function public.solicitar_visita(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  novo text;
  escola text;
  dia text;
  hora text;
  transporte text;
  email text;
  ends jsonb := '[]'::jsonb;
  item text;
  i int;
  body jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'envio inválido' using errcode = '22023';
  end if;
  escola := left(trim(coalesce(p->>'escola', '')), 160);
  dia := trim(coalesce(p->>'data', ''));
  hora := trim(coalesce(p->>'hora', ''));
  email := lower(left(trim(coalesce(p->>'email', '')), 120));
  if length(escola) < 2 then
    raise exception 'Informe a escola ou o grupo' using errcode = '22023';
  end if;
  if dia !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Informe a data' using errcode = '22023';
  end if;
  if hora !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Escolha um horário' using errcode = '22023';
  end if;
  if email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' then
    raise exception 'Informe um e-mail válido' using errcode = '22023';
  end if;
  if coalesce(p->>'lgpd', '') not in ('true', 'sim', '1') then
    raise exception 'Autorize a política de privacidade' using errcode = '22023';
  end if;
  transporte := case when p->>'transporte' = 'Ônibus do Sesc' then 'Ônibus do Sesc' else 'Transporte próprio' end;
  if jsonb_typeof(p->'enderecos') = 'array' then
    for i in 0 .. least(jsonb_array_length(p->'enderecos'), 4) - 1 loop
      item := left(trim(coalesce(p->'enderecos'->>i, '')), 180);
      if item <> '' then
        ends := ends || jsonb_build_array(item);
      end if;
    end loop;
  end if;
  if transporte = 'Ônibus do Sesc' and jsonb_array_length(ends) = 0 then
    raise exception 'Informe o endereço de embarque' using errcode = '22023';
  end if;
  novo := 'sv' || substr(md5(random()::text || clock_timestamp()::text), 1, 14);
  body := jsonb_build_object(
    'escola', escola,
    'data', dia,
    'hora', hora,
    'fim', left(trim(coalesce(p->>'fim', '')), 5),
    'alunos', left(trim(coalesce(p->>'alunos', '')), 6),
    'tipo', left(trim(coalesce(p->>'tipo', '')), 40),
    'serie', left(trim(coalesce(p->>'serie', '')), 80),
    'resp', left(trim(coalesce(p->>'resp', '')), 120),
    'contato', left(trim(coalesce(p->>'contato', '')), 40),
    'email', email,
    'pcd', left(trim(coalesce(p->>'pcd', '')), 200),
    'transporte', transporte,
    'obs', left(trim(coalesce(p->>'obs', '')), 2000),
    'status', 'Solicitado',
    'origem', 'instituicao',
    'ts', (extract(epoch from clock_timestamp()) * 1000)::bigint,
    'lgpdAceite', to_char(clock_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SSOF'),
    'enderecos', case when transporte = 'Ônibus do Sesc' then ends else '[]'::jsonb end,
    'embarques', '[]'::jsonb,
    'embOrigem', '',
    'embSesc', '',
    'busLivreHora', '',
    'busLivreEndereco', '',
    'logisticaPendente', true,
    'logisticaManual', false,
    'logisticaMotivo', left(trim(coalesce(p->>'logisticaMotivo', 'A supervisão confirma o horário de embarque.')), 300)
  );
  insert into public.docs (path, id, data) values ('agendamentos', novo, body);
  return jsonb_build_object('id', novo, 'emailEnviado', false);
end;
$$;

drop policy if exists docs_select on public.docs;
create policy docs_select on public.docs for select
  using (
    public.is_sup()
    or (
      path <> 'notas'
      and not (
        path = 'destaques'
        and coalesce(data->>'oculto', '') like 'Oculto%'
      )
      and not (
        path = 'ideias'
        and coalesce(data->>'status', '') in ('Rascunho', 'Nova')
        and coalesce(data->>'uid', '') <> coalesce(auth.uid()::text, '')
      )
      and not (
        path = 'agendamentos'
        and auth.uid() is null
      )
    )
  );

revoke all on function public.definir_chave_resend(text) from public, anon;
revoke all on function public.chave_resend() from public, anon, authenticated;
revoke all on function public.definir_aviso_visita(text, text) from public, anon;
revoke all on function public.aviso_visita() from public, anon;
revoke all on function public.solicitar_visita(jsonb) from public;
grant execute on function public.definir_chave_resend(text) to authenticated;
grant execute on function public.chave_resend() to service_role;
grant execute on function public.definir_aviso_visita(text, text) to authenticated;
grant execute on function public.aviso_visita() to authenticated, service_role;
grant execute on function public.solicitar_visita(jsonb) to anon, authenticated;
