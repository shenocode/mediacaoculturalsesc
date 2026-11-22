import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TIPOS = new Set([
  "Particular",
  "Escola Estadual",
  "Escola Municipal",
  "ONG",
  "Universidade",
  "Empresa",
  "Sesc / funcionários",
  "Outros",
]);

const OCUPA = new Set(["Agendado", "Confirmado", "Realizado"]);
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const DIA = /^\d{4}-\d{2}-\d{2}$/;

type Ponto = { lat: number; lng: number; endereco: string };
type Embarque = { endereco: string; hora: string };
type Cfg = {
  enderecoSesc: string;
  horarios: string[];
  durPadrao: number;
  durMin: number;
  margem: number;
  lotacao: number;
  grades: Record<string, string[]>;
};
type Visita = {
  id: string;
  data: string;
  hora: string;
  fim: string;
  status: string;
  transporte: string;
  enderecos: string[];
  embarques: Embarque[];
  embOrigem: string;
  embSesc: string;
  busLivreHora: string;
  busLivreEndereco: string;
  logisticaPendente: boolean;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function clamp(v: unknown, min: number, max: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function horaOk(s: string) {
  return HORA.test(s);
}

function toMin(s: string) {
  if (!horaOk(s)) return null;
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

function toHH(mins: number) {
  if (!Number.isFinite(mins)) return "";
  const m = Math.round(mins);
  if (m < 0 || m >= 24 * 60) return "";
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}

function cfgDe(raw: Record<string, unknown> | null): Cfg {
  const lista = Array.isArray(raw?.horarios) ? raw!.horarios.map((h) => String(h || "").trim()).filter(horaOk) : [];
  const grades: Record<string, string[]> = {};
  const g = raw?.grades;
  if (g && typeof g === "object" && !Array.isArray(g)) {
    for (const [dia, horas] of Object.entries(g as Record<string, unknown>)) {
      if (!DIA.test(dia) || !Array.isArray(horas)) continue;
      const hs = horas.map((h) => String(h || "").trim()).filter(horaOk);
      if (hs.length) grades[dia] = hs;
    }
  }
  const durPadrao = clamp(raw?.durPadrao, 20, 240, 60);
  let durMin = clamp(raw?.durMin, 15, 240, 40);
  if (durMin > durPadrao) durMin = durPadrao;
  return {
    enderecoSesc: String(raw?.enderecoSesc || "").trim(),
    horarios: lista.length ? lista : ["09:00", "10:30", "14:00", "15:30"],
    durPadrao,
    durMin,
    margem: clamp(raw?.margem, 0, 60, 10),
    lotacao: clamp(raw?.lotacao, 1, 80, 40),
    grades,
  };
}

function horariosDia(cfg: Cfg, dia: string) {
  return cfg.grades[dia]?.length ? cfg.grades[dia] : cfg.horarios;
}

function texto(v: unknown, max: number) {
  return String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
const REMETENTE = "Mediação Cultural Sesc <onboarding@resend.dev>";

function emailOk(s: string) {
  return EMAIL.test(s) && s.length <= 120;
}

function html(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
}

function lgpdOk(v: unknown) {
  return v === true || v === "true" || v === "sim" || v === "1";
}

async function enviarEmail(key: string, de: string, para: string, assunto: string, corpo: string) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ from: de, to: [para], subject: assunto, html: corpo }),
  });
  if (r.ok) return "";
  let msg = "O envio do e-mail foi recusado.";
  try {
    const j = await r.json();
    const t = typeof j?.message === "string" ? j.message : "";
    if (t) msg = t.slice(0, 180);
  } catch { /* a resposta do Resend veio sem texto */ }
  return msg;
}

function visitaDe(id: string, d: Record<string, unknown>): Visita | null {
  const data = texto(d.data, 10);
  const hora = texto(d.hora, 5);
  if (!DIA.test(data) || !horaOk(hora)) return null;
  const enderecos = Array.isArray(d.enderecos)
    ? d.enderecos.map((x) => texto(x, 180)).filter(Boolean).slice(0, 4)
    : [];
  const embarques = Array.isArray(d.embarques)
    ? d.embarques.map((e) => {
      const o = e && typeof e === "object" ? e as Record<string, unknown> : {};
      return { endereco: texto(o.endereco, 180), hora: texto(o.hora, 5) };
    }).filter((e) => horaOk(e.hora)).slice(0, 4)
    : [];
  return {
    id,
    data,
    hora,
    fim: texto(d.fim, 5),
    status: texto(d.status, 40) || "Agendado",
    transporte: texto(d.transporte, 40),
    enderecos,
    embarques,
    embOrigem: texto(d.embOrigem, 5),
    embSesc: texto(d.embSesc, 5),
    busLivreHora: texto(d.busLivreHora, 5),
    busLivreEndereco: texto(d.busLivreEndereco, 180),
    logisticaPendente: d.logisticaPendente === true,
  };
}

function ocupa(v: Visita) {
  return OCUPA.has(v.status);
}

function onibus(v: Visita) {
  return ocupa(v) && v.transporte === "Ônibus do Sesc" && !v.logisticaPendente;
}

const geoCache = new Map<string, Ponto | null>();
const minCache = new Map<string, number | null>();

async function geocode(key: string, endereco: string): Promise<Ponto | null> {
  const k = endereco.trim().toLowerCase();
  if (geoCache.has(k)) return geoCache.get(k) || null;
  const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  u.searchParams.set("address", endereco);
  u.searchParams.set("region", "br");
  u.searchParams.set("components", "country:BR");
  u.searchParams.set("language", "pt-BR");
  u.searchParams.set("key", key);
  const r = await fetch(u);
  const j = await r.json().catch(() => null) as { results?: { geometry?: { location?: { lat: number; lng: number } } }[] } | null;
  const loc = j?.results?.[0]?.geometry?.location;
  const p = loc ? { lat: loc.lat, lng: loc.lng, endereco } : null;
  geoCache.set(k, p);
  return p;
}

async function minutos(key: string, a: Ponto, b: Ponto): Promise<number | null> {
  const k = `${a.lat.toFixed(5)},${a.lng.toFixed(5)}|${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;
  if (minCache.has(k)) return minCache.get(k) ?? null;
  const u = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  u.searchParams.set("origins", `${a.lat},${a.lng}`);
  u.searchParams.set("destinations", `${b.lat},${b.lng}`);
  u.searchParams.set("mode", "driving");
  u.searchParams.set("language", "pt-BR");
  u.searchParams.set("key", key);
  const r = await fetch(u);
  const j = await r.json().catch(() => null) as { rows?: { elements?: { status?: string; duration?: { value?: number } }[] }[] } | null;
  const el = j?.rows?.[0]?.elements?.[0];
  const seg = el?.status === "OK" && el.duration?.value ? Math.max(1, Math.round(el.duration.value / 60)) : null;
  minCache.set(k, seg);
  return seg;
}

async function somar(key: string, pontos: Ponto[], margem: number) {
  let total = 0;
  for (let i = 0; i < pontos.length - 1; i++) {
    const m = await minutos(key, pontos[i], pontos[i + 1]);
    if (m == null) return null;
    total += m + margem;
  }
  return total;
}

type Resultado = {
  ok: boolean;
  pendente: boolean;
  motivo: string;
  embarques: Embarque[];
  embOrigem: string;
  embSesc: string;
  fim: string;
  duracao: number;
  busLivreHora: string;
  busLivreEndereco: string;
};

function vazio(parcial: Partial<Resultado>): Resultado {
  return {
    ok: false,
    pendente: false,
    motivo: "",
    embarques: [],
    embOrigem: "",
    embSesc: "",
    fim: "",
    duracao: 0,
    busLivreHora: "",
    busLivreEndereco: "",
    ...parcial,
  };
}

async function calcularUm(
  key: string,
  cfg: Cfg,
  visitas: Visita[],
  dia: string,
  hora: string,
  enderecos: string[],
  alunos: string,
  transporte: string,
  ignoreId: string,
): Promise<Resultado> {
  const H = toMin(hora);
  if (H == null) return vazio({ motivo: "Escolha um horário da lista." });
  const lista = horariosDia(cfg, dia);
  if (!lista.includes(hora)) return vazio({ motivo: "Esse horário não está aberto neste dia." });
  const outras = visitas.filter((v) => v.data === dia && v.id !== ignoreId);
  if (outras.some((v) => ocupa(v) && v.hora === hora)) {
    return vazio({ motivo: "Esse horário já está reservado." });
  }
  if (transporte !== "Ônibus do Sesc") {
    const fim = toHH(H + cfg.durPadrao);
    return vazio({ ok: true, fim, duracao: cfg.durPadrao });
  }
  const n = Number(alunos);
  if (Number.isFinite(n) && n > cfg.lotacao) {
    return vazio({ motivo: `O ônibus do Sesc leva até ${cfg.lotacao} pessoas. Para um grupo maior, use transporte próprio.` });
  }
  if (!enderecos.length) return vazio({ pendente: true, motivo: "Informe o endereço de embarque." });
  if (!cfg.enderecoSesc) {
    return vazio({ pendente: true, motivo: "A supervisão ainda vai confirmar o horário de embarque." });
  }
  if (key.length < 20) {
    return vazio({ pendente: true, motivo: "A supervisão confirma o horário de embarque." });
  }

  const stops: Ponto[] = [];
  for (const end of enderecos) {
    const p = await geocode(key, end);
    if (!p) return vazio({ pendente: true, motivo: `Não localizei o endereço “${end}”. A solicitação pode seguir e a supervisão confirma o embarque.` });
    stops.push(p);
  }
  const sesc = await geocode(key, cfg.enderecoSesc);
  if (!sesc) return vazio({ pendente: true, motivo: "A supervisão confirma o horário de embarque." });

  const ida = await somar(key, [...stops, sesc], cfg.margem);
  if (ida == null) return vazio({ pendente: true, motivo: "Não consegui calcular o trajeto. A solicitação pode seguir e a supervisão confirma o embarque." });

  let t = H - ida;
  const embarques: Embarque[] = [];
  for (let i = 0; i < stops.length; i++) {
    if (i > 0) {
      const trecho = await minutos(key, stops[i - 1], stops[i]);
      if (trecho == null) return vazio({ pendente: true, motivo: "Não consegui calcular o trajeto. A solicitação pode seguir e a supervisão confirma o embarque." });
      t += trecho + cfg.margem;
    }
    const marca = toHH(i === 0 ? H - ida : t);
    if (!marca) return vazio({ motivo: "O embarque ficaria antes do começo do dia." });
    embarques.push({ endereco: stops[i].endereco, hora: marca });
    if (i === 0) t = H - ida;
  }
  const primeiro = toMin(embarques[0].hora);
  if (primeiro == null) return vazio({ motivo: "O embarque ficaria antes do começo do dia." });

  const doDia = outras.filter(onibus).sort((a, b) => a.hora.localeCompare(b.hora));
  const prev = [...doDia].reverse().find((v) => v.hora < hora) || null;
  if (prev) {
    const livreMin = toMin(prev.busLivreHora) ?? toMin(prev.embSesc) ?? toMin(prev.fim) ?? toMin(prev.hora);
    const livreEnd = prev.busLivreEndereco || cfg.enderecoSesc;
    const livreP = livreEnd ? await geocode(key, livreEnd) : null;
    if (livreMin != null && livreP) {
      const ate = await minutos(key, livreP, stops[0]);
      if (ate != null && primeiro < livreMin + ate + cfg.margem) {
        return vazio({ motivo: "O ônibus não chega a tempo neste horário." });
      }
    }
  }

  const voltaPontos = [sesc, ...[...stops].reverse()];
  const volta = await somar(key, voltaPontos, cfg.margem);
  if (volta == null) return vazio({ pendente: true, motivo: "Não consegui calcular a volta. A solicitação pode seguir e a supervisão confirma o embarque." });

  const next = doDia.find((v) => v.hora > hora) || null;
  let retorno = H + cfg.durPadrao;
  if (next) {
    const destHora = next.embarques[0]?.hora || (horaOk(next.embOrigem) ? next.embOrigem : next.hora);
    const destEnd = next.embarques[0]?.endereco || next.enderecos[0] || (destHora === next.hora ? cfg.enderecoSesc : "");
    const dest = destEnd ? await geocode(key, destEnd) : sesc;
    const extra = await minutos(key, stops[0], dest || sesc);
    if (extra == null || toMin(destHora) == null) {
      return vazio({ pendente: true, motivo: "Não consegui calcular a volta. A solicitação pode seguir e a supervisão confirma o embarque." });
    }
    retorno = (toMin(destHora) as number) - volta - extra - cfg.margem;
  }
  const duracao = retorno - H;
  if (duracao < cfg.durMin) return vazio({ motivo: "O ônibus não chega a tempo neste horário." });
  const embSesc = toHH(retorno);
  const busLivreHora = toHH(retorno + volta);
  if (!embSesc || !busLivreHora) return vazio({ motivo: "O horário de volta não cabe neste dia." });
  return {
    ok: true,
    pendente: false,
    motivo: "",
    embarques,
    embOrigem: embarques[0].hora,
    embSesc,
    fim: embSesc,
    duracao,
    busLivreHora,
    busLivreEndereco: stops[0].endereco,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Envie os dados da visita." }, 405);

  const url = Deno.env.get("SUPABASE_URL") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !service) return json({ error: "O agendamento público ainda não está ativo." }, 503);
  const admin = createClient(url, service);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Não foi possível ler o envio." }, 400);
  }
  const acao = texto(body.acao, 20);
  const dia = texto(body.data, 10);
  if (dia && !DIA.test(dia)) return json({ error: "Informe a data." }, 400);

  const { data: cfgRow } = await admin.from("docs").select("data").eq("path", "config").eq("id", "logistica").maybeSingle();
  const cfg = cfgDe((cfgRow?.data || null) as Record<string, unknown> | null);
  const { data: rows } = await admin.from("docs").select("id,data").eq("path", "agendamentos").limit(5000);
  const visitas = (rows || []).map((row) => visitaDe(String(row.id), (row.data || {}) as Record<string, unknown>)).filter((v): v is Visita => !!v);

  let key = "";
  const { data: stored } = await admin.rpc("chave_mapa");
  if (typeof stored === "string") key = stored.trim();

  if (acao === "abrir") {
    const lista = dia ? horariosDia(cfg, dia) : cfg.horarios;
    const doDia = dia ? visitas.filter((v) => v.data === dia) : [];
    return json({
      horarios: lista.map((hora) => ({ hora, ocupado: doDia.some((v) => ocupa(v) && v.hora === hora) })),
      durPadrao: cfg.durPadrao,
      durMin: cfg.durMin,
      margem: cfg.margem,
      lotacao: cfg.lotacao,
      mapa: key.length >= 20 && !!cfg.enderecoSesc,
    });
  }

  if (acao !== "calcular" && acao !== "enviar") return json({ error: "Ação desconhecida." }, 400);

  const hora = texto(body.hora, 5);
  const transporte = body.transporte === "Ônibus do Sesc" ? "Ônibus do Sesc" : "Transporte próprio";
  const enderecos = Array.isArray(body.enderecos) ? body.enderecos.map((x) => texto(x, 180)).filter(Boolean).slice(0, 4) : [];
  const alunos = texto(body.alunos, 6);
  const ignoreId = texto(body.ignoreId, 40);
  if (!DIA.test(dia)) return json({ error: "Informe a data." }, 400);
  if (!horaOk(hora)) return json({ error: "Escolha um horário." }, 400);

  const resultado = await calcularUm(key, cfg, visitas, dia, hora, enderecos, alunos, transporte, ignoreId);
  const alternativas: string[] = [];
  if (transporte === "Ônibus do Sesc" && !resultado.ok && !resultado.pendente) {
    for (const h of horariosDia(cfg, dia)) {
      if (h === hora) continue;
      const alt = await calcularUm(key, cfg, visitas, dia, h, enderecos, alunos, transporte, ignoreId);
      if (alt.ok) alternativas.push(h);
    }
  }

  if (acao === "calcular") {
    return json({ ...resultado, alternativas });
  }

  const escola = texto(body.escola, 160);
  const email = texto(body.email, 120).toLowerCase();
  if (escola.length < 2) return json({ error: "Informe a escola ou o grupo." }, 400);
  if (!emailOk(email)) return json({ error: "Informe um e-mail válido." }, 400);
  if (!lgpdOk(body.lgpd)) return json({ error: "Autorize a política de privacidade para enviar a solicitação." }, 400);
  if (transporte === "Ônibus do Sesc" && !enderecos.length) return json({ error: "Informe o endereço de embarque." }, 400);
  if (!resultado.ok && !resultado.pendente) {
    return json({ error: resultado.motivo || "O ônibus não chega a tempo neste horário.", alternativas }, 409);
  }
  const tipo = TIPOS.has(texto(body.tipo, 40)) ? texto(body.tipo, 40) : "";
  const id = "sv" + crypto.randomUUID().replace(/-/g, "").slice(0, 14);
  const ficha = {
    escola,
    data: dia,
    hora,
    fim: resultado.fim || "",
    alunos,
    tipo,
    serie: texto(body.serie, 80),
    resp: texto(body.resp, 120),
    contato: texto(body.contato, 40),
    email,
    pcd: texto(body.pcd, 200),
    transporte,
    obs: texto(body.obs, 2000),
    status: "Solicitado",
    origem: "instituicao",
    ts: Date.now(),
    lgpdAceite: new Date().toISOString(),
    enderecos: transporte === "Ônibus do Sesc" ? enderecos : [],
    embarques: resultado.embarques,
    embOrigem: resultado.embOrigem,
    embSesc: resultado.embSesc,
    busLivreHora: resultado.busLivreHora,
    busLivreEndereco: resultado.busLivreEndereco,
    logisticaPendente: resultado.pendente,
    logisticaManual: false,
    logisticaMotivo: resultado.pendente ? resultado.motivo : "",
  };
  const { error } = await admin.from("docs").insert({ path: "agendamentos", id, data: ficha });
  if (error) return json({ error: "Não foi possível enviar a solicitação. Tente de novo." }, 500);

  let emailEnviado = false;
  let emailAviso = "A solicitação foi registrada. O e-mail de confirmação não saiu agora.";
  const { data: chaveEmail } = await admin.rpc("chave_resend");
  const resend = typeof chaveEmail === "string" ? chaveEmail.trim() : "";
  const { data: aviso } = await admin.rpc("aviso_visita");
  const caixa = aviso && typeof aviso === "object" ? aviso as { email?: string; de?: string } : {};
  const de = texto(caixa.de, 160) || REMETENTE;
  const inbox = texto(caixa.email, 120).toLowerCase();
  if (resend.length >= 20) {
    const quando = dia.split("-").reverse().join("/") + " às " + hora;
    const falha = await enviarEmail(
      resend,
      de,
      email,
      "Recebemos sua solicitação de agendamento — Sesc Piracicaba",
      "<p>Recebemos a solicitação de agendamento de <b>" + html(escola) + "</b> para " + html(quando) + ".</p><p><b>Aguarde a confirmação da sua visita.</b> Este envio ainda não reserva o horário. A supervisão da mediação cultural analisa o pedido e confirma.</p>",
    );
    emailEnviado = !falha;
    emailAviso = falha
      ? "A solicitação foi registrada. O e-mail de confirmação não saiu: " + falha
      : "Enviamos a confirmação de recebimento para " + email + ". Aguarde a confirmação da visita.";
    if (emailOk(inbox)) {
      await enviarEmail(
        resend,
        de,
        inbox,
        "Nova solicitação de agendamento — " + escola,
        "<p>Chegou uma solicitação com status <b>Solicitado</b>. Ela ainda não está no calendário da equipe.</p><p><b>" + html(escola) + "</b><br>" + html(quando) + "<br>" + html(texto(body.contato, 40)) + "<br>" + html(email) + "<br>" + html(transporte) + "</p>",
      );
    }
  } else {
    emailAviso = "A solicitação foi registrada. O envio de e-mail ainda não está ativo.";
  }
  return json({
    id,
    pendente: resultado.pendente,
    motivo: resultado.motivo,
    embarques: resultado.embarques,
    embOrigem: resultado.embOrigem,
    embSesc: resultado.embSesc,
    fim: resultado.fim,
    duracao: resultado.duracao,
    emailEnviado,
    emailAviso,
  });
});
