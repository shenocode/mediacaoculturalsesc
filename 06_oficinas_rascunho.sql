-- Rascunho e Nova ficam com quem preencheu e com a supervisão.
-- Para análise, e os demais status, continuam visíveis para a equipe.

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
    )
  );
