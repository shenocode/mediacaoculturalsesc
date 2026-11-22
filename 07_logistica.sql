-- Chave do mapa e envio público da solicitação de visita.
-- A chave não volta para o navegador. A solicitação nasce como Solicitado.

create or replace function public.definir_chave_mapa(p_chave text)
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
  values ('maps_api_key', trim(p_chave))
  on conflict (k) do update set v = excluded.v;
end;
$$;

create or replace function public.chave_mapa()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select v from public.painel_secrets where k = 'maps_api_key';
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
  if length(escola) < 2 then
    raise exception 'Informe a escola ou o grupo' using errcode = '22023';
  end if;
  if dia !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Informe a data' using errcode = '22023';
  end if;
  if hora !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Escolha um horário' using errcode = '22023';
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
    'pcd', left(trim(coalesce(p->>'pcd', '')), 200),
    'transporte', transporte,
    'obs', left(trim(coalesce(p->>'obs', '')), 2000),
    'status', 'Solicitado',
    'origem', 'instituicao',
    'ts', (extract(epoch from clock_timestamp()) * 1000)::bigint,
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
  return jsonb_build_object('id', novo);
end;
$$;

revoke all on function public.definir_chave_mapa(text) from public, anon;
revoke all on function public.chave_mapa() from public, anon, authenticated;
revoke all on function public.solicitar_visita(jsonb) from public;
grant execute on function public.definir_chave_mapa(text) to authenticated;
grant execute on function public.chave_mapa() to service_role;
grant execute on function public.solicitar_visita(jsonb) to anon, authenticated;
