-- Caderno "Estudos da Semana": entradas salvas (sem-*) e rascunho.
-- A supervisão lê no relatório. Cole no Supabase > SQL Editor > Run.

create or replace function public.resumo_cadernos_semana()
returns table (
  owner uuid,
  nome text,
  email text,
  texto text,
  ts bigint,
  criado bigint,
  titulo text,
  entry_id text
)
language sql
stable
security definer
set search_path = public
as $$
  with membros as (
    select
      p.id,
      coalesce(
        nullif(trim(p.nome), ''),
        nullif(split_part(coalesce(p.email, ''), '@', 1), ''),
        '(sem nome)'
      ) as nome,
      p.email
    from public.profiles p
    where public.is_sup()
      and p.role in ('equipe', 'supervisao')
  ),
  entradas as (
    select
      m.id as owner,
      m.nome,
      m.email,
      coalesce(u.data->>'texto', '') as texto,
      coalesce(nullif(u.data->>'ts', '')::bigint, 0) as ts,
      coalesce(
        nullif(u.data->>'criado', '')::bigint,
        nullif(u.data->>'ts', '')::bigint,
        0
      ) as criado,
      coalesce(nullif(trim(u.data->>'titulo'), ''), 'Estudos da Semana') as titulo,
      u.id as entry_id
    from membros m
    join public.user_docs u
      on u.owner::text = m.id::text
     and u.id like 'sem-%'
     and coalesce(u.data->>'apagado', '') not in ('1', 'true')
  ),
  so_rascunho as (
    select
      m.id as owner,
      m.nome,
      m.email,
      case
        when coalesce(u.data->>'apagado', '') in ('1', 'true') then ''
        else coalesce(u.data->>'texto', '')
      end as texto,
      coalesce(nullif(u.data->>'ts', '')::bigint, 0) as ts,
      coalesce(nullif(u.data->>'ts', '')::bigint, 0) as criado,
      'Estudos da Semana' as titulo,
      null::text as entry_id
    from membros m
    left join public.user_docs u
      on u.owner::text = m.id::text
     and u.id = 'cad-estudos-semana'
    where not exists (
      select 1 from entradas e where e.owner = m.id
    )
  )
  select * from entradas
  union all
  select * from so_rascunho
  order by 2, 6 desc, 5 desc;
$$;

revoke all on function public.resumo_cadernos_semana() from public, anon;
grant execute on function public.resumo_cadernos_semana() to authenticated;
