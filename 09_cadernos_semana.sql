-- Caderno "Estudos da Semana": a supervisão lê o texto de todos os membros no relatório.
-- Cole no Supabase > SQL Editor > Run.

create or replace function public.resumo_cadernos_semana()
returns table (
  owner uuid,
  nome text,
  email text,
  texto text,
  ts bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id as owner,
    coalesce(
      nullif(trim(p.nome), ''),
      nullif(split_part(coalesce(p.email, ''), '@', 1), ''),
      '(sem nome)'
    ) as nome,
    p.email,
    case
      when coalesce(u.data->>'apagado', '') in ('1', 'true') then ''
      else coalesce(u.data->>'texto', '')
    end as texto,
    coalesce(nullif(u.data->>'ts', '')::bigint, 0) as ts
  from public.profiles p
  left join public.user_docs u
    on u.owner::text = p.id::text
   and u.id = 'cad-estudos-semana'
  where public.is_sup()
    and p.role in ('equipe', 'supervisao')
  order by lower(
    coalesce(
      nullif(trim(p.nome), ''),
      nullif(split_part(coalesce(p.email, ''), '@', 1), ''),
      '(sem nome)'
    )
  );
$$;

revoke all on function public.resumo_cadernos_semana() from public, anon;
grant execute on function public.resumo_cadernos_semana() to authenticated;
