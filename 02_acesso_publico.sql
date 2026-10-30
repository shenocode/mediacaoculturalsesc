-- Consulta livre do painel. Notas, destaques e a playlist ficam só com a supervisão.
-- A equipe logada altera as outras áreas. Gestão (estudos, domingos, trocas, notas) fica com a supervisão.

grant select on table public.docs to anon;

create or replace function public.team_writable(p text) returns boolean
language sql immutable as $$
  select p in (
    'ideias','anotobras','extras','galeria','agendamentos','equipe',
    'obras','videos','materiais','cartas','conteudo'
  )
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
    )
  );

drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert to authenticated
  with check (
    public.is_sup()
    or ( public.is_member() and public.team_writable(path) )
    or ( public.is_member() and path = 'config' and id = 'p-' || auth.uid()::text )
  );

drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated
  using (
    public.is_sup()
    or ( public.is_member() and public.team_writable(path) )
    or ( public.is_member() and path = 'config' and id = 'p-' || auth.uid()::text )
  )
  with check (
    public.is_sup()
    or ( public.is_member() and public.team_writable(path) )
    or ( public.is_member() and path = 'config' and id = 'p-' || auth.uid()::text )
  );

drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated
  using ( public.is_sup() or ( public.is_member() and public.team_writable(path) ) );
