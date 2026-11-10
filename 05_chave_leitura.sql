-- Chave da leitura de fotos. Só a supervisão grava. O site nunca lê o valor de volta.

create or replace function public.definir_chave_leitura(p_chave text)
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
  values ('gemini_api_key', trim(p_chave))
  on conflict (k) do update set v = excluded.v;
end;
$$;

create or replace function public.chave_leitura()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select v from public.painel_secrets where k = 'gemini_api_key';
$$;

revoke all on function public.definir_chave_leitura(text) from public, anon;
revoke all on function public.chave_leitura() from public, anon, authenticated;
grant execute on function public.definir_chave_leitura(text) to authenticated;
grant execute on function public.chave_leitura() to service_role;
