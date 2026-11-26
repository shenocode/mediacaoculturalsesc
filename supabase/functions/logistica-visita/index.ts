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

const OCUPA = new Set(["Solicitado", "Agendado", "Confirmado", "Realizado", "A conferir"]);
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

/** Aceita 9:00, 9h00, 09:00 etc. */
function normHora(s: unknown) {
  const m = String(s ?? "").trim().match(/^(\d{1,2})\s*[:hH]\s*(\d{2})$/);
  if (!m) return "";
  const h = m[1].padStart(2, "0");
  const mm = m[2];
  const out = h + ":" + mm;
  return horaOk(out) ? out : "";
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

/**
 * Envio automático do ofício ao confirmar a visita.
 * Pausado: confirmar só grava o status. O PDF, o texto e a chave do Resend continuam neste arquivo.
 * Para retomar, troque para true e publique a função.
 */
const OFICIO_ATIVO = false;
const SITE_PUBLICO = "https://mediacaosesc.sherocha.com.br";

function emailOk(s: string) {
  return EMAIL.test(s) && s.length <= 120;
}

function html(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
}


/** Link que abre a ficha no painel. Usa o endereço de quem enviou; se faltar, o site publicado. */
function linkFicha(req: Request, id: string) {
  let origin = SITE_PUBLICO;
  let path = "/";
  const ref = req.headers.get("referer") || "";
  const ori = req.headers.get("origin") || "";
  try {
    const u = new URL(ref || ori || SITE_PUBLICO);
    if (u.protocol === "http:" || u.protocol === "https:") {
      origin = u.origin;
      path = ref && /\.html$/i.test(u.pathname) ? u.pathname : "/";
    }
  } catch { /* fica o site publicado */ }
  return origin + path + "?ficha=" + encodeURIComponent(id) + "#agendamentos";
}


function lgpdOk(v: unknown) {
  return v === true || v === "true" || v === "sim" || v === "1";
}

type Anexo = { filename: string; content: string; contentType?: string };

async function enviarEmail(
  key: string,
  de: string,
  para: string,
  assunto: string,
  corpo: string,
  anexos?: Anexo[],
) {
  const payload: Record<string, unknown> = { from: de, to: [para], subject: assunto, html: corpo };
  if (anexos && anexos.length) {
    payload.attachments = anexos.map((a) => ({
      filename: a.filename,
      content: a.content,
      content_type: a.contentType || "application/pdf",
    }));
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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

function dataBr(dia: string) {
  if (!DIA.test(dia)) return dia;
  return dia.slice(8, 10) + "/" + dia.slice(5, 7) + "/" + dia.slice(0, 4);
}

function bytesB64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function asciiPdf(s: string) {
  return String(s || "")
    .replace(/[ÁÀÂÃÄ]/g, "A").replace(/[áàâãä]/g, "a")
    .replace(/[ÉÈÊË]/g, "E").replace(/[éèêë]/g, "e")
    .replace(/[ÍÌÎÏ]/g, "I").replace(/[íìîï]/g, "i")
    .replace(/[ÓÒÔÕÖ]/g, "O").replace(/[óòôõö]/g, "o")
    .replace(/[ÚÙÛÜ]/g, "U").replace(/[úùûü]/g, "u")
    .replace(/Ç/g, "C").replace(/ç/g, "c").replace(/Ñ/g, "N").replace(/ñ/g, "n")
    .replace(/[—–·•]/g, "-").replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/[^\x20-\x7E]/g, "?");
}

/** PDF simples (Helvetica) com o ofício da confirmação. */
function oficioPdf(ficha: Record<string, unknown>, emailDevolucao: string): Uint8Array {
  const linhas: string[] = [];
  const push = (s: string) => {
    const t = asciiPdf(String(s || "").replace(/[\r\n\t]+/g, " ")).trim();
    if (!t) {
      linhas.push("");
      return;
    }
    const max = 90;
    let rest = t;
    while (rest.length > max) {
      let corte = rest.lastIndexOf(" ", max);
      if (corte < 40) corte = max;
      linhas.push(rest.slice(0, corte).trim());
      rest = rest.slice(corte).trim();
    }
    if (rest) linhas.push(rest);
  };
  const escola = texto(ficha.escola, 160);
  const dia = texto(ficha.data, 10);
  const hora = texto(ficha.hora, 5);
  const fim = texto(ficha.fim, 5);
  const transporte = texto(ficha.transporte, 40);
  const onibus = transporte === "Ônibus do Sesc";
  push("OFICIO - CONFIRMACAO DE AGENDAMENTO DE VISITA");
  push("Mediacao Cultural - Sesc Piracicaba");
  push("");
  push("Instituicao / grupo: " + escola);
  push("Data da visita: " + dataBr(dia));
  push("Horario da visita no Sesc: " + hora + (fim ? " ate " + fim : ""));
  if (texto(ficha.alunos, 6)) push("Numero de pessoas: " + texto(ficha.alunos, 6));
  if (texto(ficha.tipo, 40)) push("Tipo de instituicao: " + texto(ficha.tipo, 40));
  if (texto(ficha.serie, 80)) push("Faixa etaria / serie: " + texto(ficha.serie, 80));
  if (texto(ficha.resp, 120)) push("Responsavel pelo grupo: " + texto(ficha.resp, 120));
  if (texto(ficha.contato, 40)) push("Telefone: " + texto(ficha.contato, 40));
  if (texto(ficha.email, 120)) push("E-mail da instituicao: " + texto(ficha.email, 120));
  if (texto(ficha.pcd, 200)) push("Acessibilidade: " + texto(ficha.pcd, 200));
  push("Transporte: " + (transporte || "Nao informado"));
  if (onibus) {
    const emb = Array.isArray(ficha.embarques) ? ficha.embarques as { endereco?: string; hora?: string }[] : [];
    if (emb.length) {
      emb.forEach((e, i) => {
        push((i === 0 ? "Embarque na origem: " : "Parada de embarque: ") + texto(e.hora, 5) + " - " + texto(e.endereco, 180));
      });
    } else if (texto(ficha.embOrigem, 5)) {
      push("Embarque na origem: " + texto(ficha.embOrigem, 5));
      const ends = Array.isArray(ficha.enderecos) ? ficha.enderecos.map((x) => texto(x, 180)).filter(Boolean) : [];
      if (ends[0]) push("Endereco de embarque: " + ends[0]);
    }
    if (texto(ficha.embSesc, 5)) push("Embarque no destino (volta no Sesc): " + texto(ficha.embSesc, 5));
  }
  if (texto(ficha.obs, 500)) {
    push("");
    push("Observacoes: " + texto(ficha.obs, 500));
  }
  push("");
  push("INSTRUCOES PARA A INSTITUICAO");
  push("1. Imprima este documento no papel timbrado da instituicao.");
  push("2. Assine e carimbe o documento.");
  push("3. Digitalize (foto nitida ou PDF) e envie por e-mail para:");
  push(emailDevolucao || "(e-mail da supervisao a informar)");
  push("4. Guarde o comprovante de envio ate a data da visita.");
  push("");
  push("A visita fica confirmada apos o recebimento do oficio assinado.");

  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const ops: string[] = ["BT", "/F1 11 Tf", "14 TL", "50 800 Td"];
  linhas.forEach((ln, i) => {
    if (i === 0) ops.push("/F1 13 Tf");
    else if (i === 1) ops.push("/F1 10 Tf");
    else if (ln.startsWith("INSTRUCOES")) ops.push("/F1 12 Tf");
    else if (i === 2) ops.push("/F1 11 Tf");
    ops.push("(" + esc(ln || " ") + ") Tj", "T*");
    if (i === 0 || ln.startsWith("INSTRUCOES")) ops.push("/F1 11 Tf");
  });
  ops.push("ET");
  const stream = ops.join("\n");
  const enc = new TextEncoder();
  const streamBytes = enc.encode(stream);
  const pieces = [
    "1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n",
    "2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n",
    "3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj\n",
    "4 0 obj<< /Length " + streamBytes.length + " >>stream\n" + stream + "\nendstream\nendobj\n",
    "5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n",
  ];
  const header = enc.encode("%PDF-1.4\n");
  const parts = [header, ...pieces.map((p) => enc.encode(p))];
  const off = [0];
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) off.push(pos);
    pos += parts[i].length;
  }
  let xref = "xref\n0 " + (pieces.length + 1) + "\n0000000000 65535 f \n";
  for (let i = 1; i < off.length; i++) xref += String(off[i]).padStart(10, "0") + " 00000 n \n";
  const tail = enc.encode(xref + "trailer<< /Size " + (pieces.length + 1) + " /Root 1 0 R >>\nstartxref\n" + pos + "\n%%EOF\n");
  const out = new Uint8Array(pos + tail.length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  out.set(tail, at);
  return out;
}

function visitaDe(id: string, d: Record<string, unknown>): Visita | null {
  const data = texto(d.data, 10);
  const hora = normHora(d.hora) || texto(d.hora, 5);
  if (!DIA.test(data) || !horaOk(hora)) return null;
  const enderecos = Array.isArray(d.enderecos)
    ? d.enderecos.map((x) => texto(x, 180)).filter(Boolean).slice(0, 4)
    : [];
  const embarques = Array.isArray(d.embarques)
    ? d.embarques.map((e) => {
      const o = e && typeof e === "object" ? e as Record<string, unknown> : {};
      return { endereco: texto(o.endereco, 180), hora: normHora(o.hora) || texto(o.hora, 5) };
    }).filter((e) => horaOk(e.hora)).slice(0, 4)
    : [];
  return {
    id,
    data,
    hora,
    fim: normHora(d.fim) || texto(d.fim, 5),
    status: texto(d.status, 40) || "Agendado",
    transporte: texto(d.transporte, 40),
    enderecos,
    embarques,
    embOrigem: normHora(d.embOrigem) || texto(d.embOrigem, 5),
    embSesc: normHora(d.embSesc) || texto(d.embSesc, 5),
    busLivreHora: normHora(d.busLivreHora) || texto(d.busLivreHora, 5),
    busLivreEndereco: texto(d.busLivreEndereco, 180),
    logisticaPendente: d.logisticaPendente === true,
  };
}

function ocupa(v: Visita) {
  return OCUPA.has(v.status);
}

/** Horário da lista já comprometido: mesmo início ou início dentro da visita. */
function ocupaHorario(v: Visita, hora: string, durPadrao: number) {
  if (!ocupa(v)) return false;
  if (v.hora === hora) return true;
  const slot = toMin(hora);
  const ini = toMin(v.hora);
  if (slot == null || ini == null) return false;
  let fim = toMin(v.fim);
  if (fim == null || fim <= ini) fim = ini + Math.max(20, durPadrao || 60);
  return slot >= ini && slot < fim;
}

function onibus(v: Visita) {
  return ocupa(v) && v.transporte === "Ônibus do Sesc" && !v.logisticaPendente;
}

const geoCache = new Map<string, Ponto | null>();
type Trecho = { min: number; estimado: boolean };
type Fonte = { nome: "matrix" | "directions" | "osrm" | "reta"; osrmOff: boolean };
const minCache = new Map<string, Trecho>();

function comPrazo<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

function minutosReta(a: Ponto, b: Ponto) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const la1 = a.lat * rad;
  const la2 = b.lat * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  const km = 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  if (!Number.isFinite(km)) return 20;
  const min = Math.round((km * 1.35) / 28 * 60) + 2;
  return Math.max(5, min);
}

function kmEntre(a: Ponto, b: Ponto) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function cidadeDe(endereco: string) {
  const uf = /^(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO|Brasil)$/i;
  const partes = endereco.split(/[,;]/).map((s) => s
    .replace(/\s*[–—-]\s*[A-Za-z]{2}\b/g, "")
    .replace(/\bCEP\b/ig, "")
    .replace(/\d{5}-?\d{3}/g, "")
    .trim()).filter(Boolean);
  for (let i = partes.length - 1; i >= 0; i--) {
    if (partes[i].length > 2 && !uf.test(partes[i]) && !/^\d+$/.test(partes[i])) return partes[i];
  }
  return "";
}

async function geocode(key: string, endereco: string, perto?: Ponto | null): Promise<Ponto | null> {
  const bias = perto ? `${perto.lat.toFixed(2)},${perto.lng.toFixed(2)}` : "";
  const k = endereco.trim().toLowerCase() + "|" + bias;
  if (geoCache.has(k)) return geoCache.get(k) || null;
  const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  u.searchParams.set("address", endereco);
  u.searchParams.set("region", "br");
  u.searchParams.set("components", "country:BR");
  u.searchParams.set("language", "pt-BR");
  if (perto) {
    const d = 0.35;
    u.searchParams.set("bounds", `${(perto.lat - d).toFixed(4)},${(perto.lng - d).toFixed(4)}|${(perto.lat + d).toFixed(4)},${(perto.lng + d).toFixed(4)}`);
  }
  u.searchParams.set("key", key);
  const r = await fetch(u);
  const j = await r.json().catch(() => null) as { results?: { geometry?: { location?: { lat: number; lng: number } } }[] } | null;
  const loc = j?.results?.[0]?.geometry?.location;
  const p = loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) ? { lat: loc.lat, lng: loc.lng, endereco } : null;
  geoCache.set(k, p);
  return p;
}

async function geocodePerto(key: string, endereco: string, sesc: Ponto, cidade: string): Promise<Ponto | null> {
  const direto = await geocode(key, endereco, sesc);
  if (!direto) return null;
  if (!Number.isFinite(kmEntre(direto, sesc)) || kmEntre(direto, sesc) <= 80) return direto;
  if (!cidade || endereco.toLowerCase().includes(cidade.toLowerCase())) return direto;
  const ajustado = await geocode(key, endereco + ", " + cidade, sesc);
  if (ajustado && kmEntre(ajustado, sesc) < kmEntre(direto, sesc)) return { ...ajustado, endereco };
  return direto;
}

async function minutosMatrix(key: string, a: Ponto, b: Ponto): Promise<number | "denied" | null> {
  const u = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  u.searchParams.set("origins", `${a.lat},${a.lng}`);
  u.searchParams.set("destinations", `${b.lat},${b.lng}`);
  u.searchParams.set("mode", "driving");
  u.searchParams.set("language", "pt-BR");
  u.searchParams.set("key", key);
  const r = await fetch(u);
  const j = await r.json().catch(() => null) as { status?: string; rows?: { elements?: { status?: string; duration?: { value?: number } }[] }[] } | null;
  const status = j?.status || "";
  if (status === "REQUEST_DENIED" || status === "OVER_DAILY_LIMIT" || status === "OVER_QUERY_LIMIT") return "denied";
  const el = j?.rows?.[0]?.elements?.[0];
  const seg = el?.duration?.value;
  if (el?.status === "OK" && typeof seg === "number" && seg >= 0) return Math.max(1, Math.round(seg / 60));
  return null;
}

async function minutosDirections(key: string, a: Ponto, b: Ponto): Promise<number | "denied" | null> {
  const u = new URL("https://maps.googleapis.com/maps/api/directions/json");
  u.searchParams.set("origin", `${a.lat},${a.lng}`);
  u.searchParams.set("destination", `${b.lat},${b.lng}`);
  u.searchParams.set("mode", "driving");
  u.searchParams.set("language", "pt-BR");
  u.searchParams.set("key", key);
  const r = await fetch(u);
  const j = await r.json().catch(() => null) as { status?: string; routes?: { legs?: { duration?: { value?: number } }[] }[] } | null;
  const status = j?.status || "";
  if (status === "REQUEST_DENIED" || status === "OVER_DAILY_LIMIT" || status === "OVER_QUERY_LIMIT") return "denied";
  const seg = j?.routes?.[0]?.legs?.[0]?.duration?.value;
  if (status === "OK" && typeof seg === "number" && seg >= 0) return Math.max(1, Math.round(seg / 60));
  return null;
}

async function minutosOsrm(a: Ponto, b: Ponto): Promise<number | null> {
  const u = "https://router.project-osrm.org/route/v1/driving/" + a.lng + "," + a.lat + ";" + b.lng + "," + b.lat + "?overview=false";
  const r = await fetch(u);
  const j = await r.json().catch(() => null) as { code?: string; routes?: { duration?: number }[] } | null;
  const seg = j?.routes?.[0]?.duration;
  if (j?.code === "Ok" && typeof seg === "number" && seg > 0) return Math.max(1, Math.round(seg / 60));
  return null;
}

async function medir(key: string, a: Ponto, b: Ponto, fonte: Fonte): Promise<Trecho> {
  if (fonte.nome === "matrix" && key.length >= 20) {
    const m = await comPrazo(minutosMatrix(key, a, b), 4000);
    if (typeof m === "number") return { min: m, estimado: false };
    if (m === "denied") fonte.nome = "directions";
  }
  if (fonte.nome !== "osrm" && fonte.nome !== "reta" && key.length >= 20) {
    const d = await comPrazo(minutosDirections(key, a, b), 4000);
    if (typeof d === "number") return { min: d, estimado: false };
    if (d === "denied") fonte.nome = "osrm";
  }
  if (!fonte.osrmOff && fonte.nome !== "reta") {
    const o = await comPrazo(minutosOsrm(a, b), 4000);
    if (typeof o === "number") return { min: o, estimado: false };
    fonte.osrmOff = true;
  }
  return { min: minutosReta(a, b), estimado: true };
}

async function minutos(key: string, a: Ponto, b: Ponto, fonte: Fonte): Promise<Trecho> {
  const k = `${a.lat.toFixed(5)},${a.lng.toFixed(5)}|${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;
  const hit = minCache.get(k);
  if (hit) return hit;
  const t = await medir(key, a, b, fonte);
  if (!t.estimado) minCache.set(k, t);
  return t;
}

async function somar(key: string, pontos: Ponto[], margem: number, fonte: Fonte) {
  let total = 0;
  let estimado = false;
  for (let i = 0; i < pontos.length - 1; i++) {
    const m = await minutos(key, pontos[i], pontos[i + 1], fonte);
    total += m.min + margem;
    if (m.estimado) estimado = true;
  }
  return { total, estimado };
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
  estimativa: boolean;
  encurtada: boolean;
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
    estimativa: false,
    encurtada: false,
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
  if (outras.some((v) => ocupaHorario(v, hora, cfg.durPadrao))) {
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

  const sesc = await geocode(key, cfg.enderecoSesc);
  if (!sesc) return vazio({ pendente: true, motivo: "A supervisão confirma o horário de embarque." });
  const cidade = cidadeDe(cfg.enderecoSesc);
  const stops: Ponto[] = [];
  for (const end of enderecos) {
    const p = await geocodePerto(key, end, sesc, cidade);
    if (!p) return vazio({ pendente: true, motivo: `Não localizei o endereço “${end}”. A solicitação pode seguir e a supervisão confirma o embarque.` });
    stops.push(p);
  }

  const fonte: Fonte = { nome: "matrix", osrmOff: false };
  const idaR = await somar(key, [...stops, sesc], cfg.margem, fonte);
  const ida = idaR.total;
  let estimativa = idaR.estimado;

  let t = H - ida;
  const embarques: Embarque[] = [];
  for (let i = 0; i < stops.length; i++) {
    if (i > 0) {
      const trecho = await minutos(key, stops[i - 1], stops[i], fonte);
      if (trecho.estimado) estimativa = true;
      t += trecho.min + cfg.margem;
    }
    const marca = toHH(i === 0 ? H - ida : t);
    if (!marca) return vazio({ motivo: "O embarque ficaria antes do começo do dia.", estimativa });
    embarques.push({ endereco: stops[i].endereco, hora: marca });
    if (i === 0) t = H - ida;
  }
  const primeiro = toMin(embarques[0].hora);
  if (primeiro == null) return vazio({ motivo: "O embarque ficaria antes do começo do dia.", estimativa });

  const doDia = outras.filter(onibus).sort((a, b) => a.hora.localeCompare(b.hora));
  const prev = [...doDia].reverse().find((v) => v.hora < hora) || null;
  if (prev) {
    const livreMin = toMin(prev.busLivreHora) ?? toMin(prev.embSesc) ?? toMin(prev.fim) ?? toMin(prev.hora);
    const livreEnd = prev.busLivreEndereco || cfg.enderecoSesc;
    const livreP = livreEnd ? await geocode(key, livreEnd, sesc) : null;
    if (livreMin != null && livreP) {
      const ate = await minutos(key, livreP, stops[0], fonte);
      if (ate.estimado) estimativa = true;
      if (primeiro < livreMin + ate.min + cfg.margem) {
        return vazio({
          motivo: "O ônibus não chega a tempo neste horário. Ele ainda está na visita anterior.",
          embarques,
          embOrigem: embarques[0].hora,
          estimativa,
        });
      }
    }
  }

  const voltaPontos = [sesc, ...[...stops].reverse()];
  const voltaR = await somar(key, voltaPontos, cfg.margem, fonte);
  const volta = voltaR.total;
  if (voltaR.estimado) estimativa = true;

  const next = doDia.find((v) => v.hora > hora) || null;
  const cheio = H + cfg.durPadrao;
  let retorno = cheio;
  let encurtada = false;
  if (next) {
    const destHora = next.embarques[0]?.hora || (horaOk(next.embOrigem) ? next.embOrigem : next.hora);
    const destMin = toMin(destHora);
    const destEnd = next.embarques[0]?.endereco || next.enderecos[0] || (destHora === next.hora ? cfg.enderecoSesc : "");
    const dest = destEnd ? await geocode(key, destEnd, sesc) : sesc;
    const extra = await minutos(key, stops[0], dest || sesc, fonte);
    if (extra.estimado) estimativa = true;
    if (destMin != null) {
      const limite = destMin - volta - extra.min - cfg.margem;
      if (limite < cheio) {
        retorno = limite;
        encurtada = true;
      }
    }
  }
  const duracao = retorno - H;
  const embSesc = toHH(retorno);
  const busLivreHora = toHH(retorno + volta);
  const base = {
    embarques,
    embOrigem: embarques[0].hora,
    embSesc,
    fim: embSesc,
    duracao: duracao > 0 ? duracao : 0,
    busLivreHora,
    busLivreEndereco: stops[0].endereco,
    estimativa,
    encurtada,
  };
  if (duracao < cfg.durMin || !embSesc || !busLivreHora) {
    const curto = duracao < cfg.durMin
      ? "O ônibus não chega a tempo neste horário. A mediação ficaria com " + Math.max(0, duracao) + " min e o mínimo é " + cfg.durMin + " min" + (encurtada ? ", para ainda buscar a próxima visita." : ".")
      : "O horário de volta não cabe neste dia.";
    return vazio({ motivo: curto, ...base });
  }
  return { ok: true, pendente: false, motivo: "", ...base };
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
      horarios: lista.map((hora) => ({ hora, ocupado: doDia.some((v) => ocupaHorario(v, hora, cfg.durPadrao)) })),
      disponiveis: lista.filter((hora) => !doDia.some((v) => ocupaHorario(v, hora, cfg.durPadrao))),
      durPadrao: cfg.durPadrao,
      durMin: cfg.durMin,
      margem: cfg.margem,
      lotacao: cfg.lotacao,
      mapa: key.length >= 20 && !!cfg.enderecoSesc,
    });
  }

  if (acao === "confirmar") {
    const id = texto(body.id, 40);
    if (!id) return json({ error: "Informe a visita." }, 400);
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt || jwt === (Deno.env.get("SUPABASE_ANON_KEY") || "")) {
      return json({ error: "Entre na conta para confirmar a visita." }, 401);
    }
    const { data: authData, error: authErr } = await admin.auth.getUser(jwt);
    const uid = authData?.user?.id || "";
    if (authErr || !uid) return json({ error: "Entre na conta para confirmar a visita." }, 401);
    const { data: perfil } = await admin.from("profiles").select("role").eq("id", uid).maybeSingle();
    const papel = String(perfil?.role || "");
    if (papel !== "supervisao" && papel !== "equipe") {
      return json({ error: "Somente a equipe pode confirmar a visita." }, 403);
    }
    const { data: row } = await admin.from("docs").select("id,data").eq("path", "agendamentos").eq("id", id).maybeSingle();
    if (!row) return json({ error: "Visita não encontrada." }, 404);
    const ficha = { ...((row.data || {}) as Record<string, unknown>) };
    // Ofício automático pausado. O envio completo continua neste arquivo, atrás de OFICIO_ATIVO.
    if (!OFICIO_ATIVO) {
      if (ficha.status !== "Confirmado") {
        const { error: upErr } = await admin.from("docs").update({
          data: { ...ficha, status: "Confirmado" },
        }).eq("path", "agendamentos").eq("id", id);
        if (upErr) return json({ error: "Não foi possível confirmar a visita." }, 500);
      }
      return json({
        ok: true,
        id,
        status: "Confirmado",
        emailEnviado: false,
        oficioPausado: true,
        emailAviso: "Visita confirmada.",
      });
    }
    const emailInst = texto(ficha.email, 120).toLowerCase();
    if (!emailOk(emailInst)) return json({ error: "A visita não tem e-mail da instituição para enviar o ofício." }, 400);
    if (ficha.oficioEnviado === true && body.forcar !== true && body.forcar !== "true") {
      if (ficha.status !== "Confirmado") {
        await admin.from("docs").update({
          data: { ...ficha, status: "Confirmado" },
        }).eq("path", "agendamentos").eq("id", id);
      }
      return json({ ok: true, jaEnviado: true, emailAviso: "O ofício desta visita já tinha sido enviado." });
    }
    const { data: chaveEmail } = await admin.rpc("chave_resend");
    const resend = typeof chaveEmail === "string" ? chaveEmail.trim() : "";
    if (resend.length < 20) return json({ error: "Ative o envio de e-mail (chave do Resend) antes de confirmar." }, 400);
    const { data: aviso } = await admin.rpc("aviso_visita");
    const caixa = aviso && typeof aviso === "object" ? aviso as { email?: string; de?: string } : {};
    const de = texto(caixa.de, 160) || REMETENTE;
    const inbox = texto(caixa.email, 120).toLowerCase();
    const emailDevolucao = emailOk(inbox) ? inbox : "";
    ficha.status = "Confirmado";
    const pdf = oficioPdf(ficha, emailDevolucao);
    const quando = dataBr(texto(ficha.data, 10)) + " às " + texto(ficha.hora, 5);
    const escola = texto(ficha.escola, 160);
    const corpo =
      "<p>A visita de <b>" + html(escola) + "</b> em " + html(quando) + " foi <b>confirmada</b> pela mediação cultural do Sesc Piracicaba.</p>" +
      "<p>Em anexo está o <b>ofício</b> com os dados do agendamento.</p>" +
      "<p><b>O que fazer agora:</b></p>" +
      "<ol>" +
      "<li>Imprima o ofício no <b>papel timbrado</b> da instituição.</li>" +
      "<li>Assine e carimbe o documento.</li>" +
      "<li>Digitalize (foto nítida ou PDF) e envie por e-mail para <b>" + html(emailDevolucao || "o e-mail informado pela supervisão") + "</b>.</li>" +
      "</ol>" +
      (emailDevolucao ? "<p>E-mail para devolução do ofício assinado: <b>" + html(emailDevolucao) + "</b></p>" : "") +
      "<p>Guarde o comprovante de envio até a data da visita.</p>";
    const falha = await enviarEmail(
      resend,
      de,
      emailInst,
      "Visita confirmada — ofício para assinatura · Sesc Piracicaba",
      corpo,
      [{ filename: "oficio-visita-" + texto(ficha.data, 10) + ".pdf", content: bytesB64(pdf), contentType: "application/pdf" }],
    );
    if (falha) return json({ error: "Não foi possível enviar o ofício: " + falha }, 502);
    const agora = new Date().toISOString();
    const { error: upErr } = await admin.from("docs").update({
      data: { ...ficha, status: "Confirmado", oficioEnviado: true, oficioEnviadoEm: agora },
    }).eq("path", "agendamentos").eq("id", id);
    if (upErr) return json({ error: "O e-mail saiu, mas não deu para marcar a visita como confirmada. Atualize o status manualmente." }, 500);
    if (emailOk(inbox) && inbox !== emailInst) {
      await enviarEmail(
        resend,
        de,
        inbox,
        "Ofício enviado — " + escola,
        "<p>O ofício de confirmação foi enviado para <b>" + html(emailInst) + "</b>.</p><p><b>" + html(escola) + "</b><br>" + html(quando) + "</p><p>A instituição deve devolver o documento assinado e carimbado neste e-mail.</p>",
      );
    }
    return json({
      ok: true,
      id,
      status: "Confirmado",
      emailEnviado: true,
      emailAviso: "Enviamos a confirmação com o ofício para " + emailInst + ".",
      emailDevolucao,
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
    const quando = dataBr(dia) + " às " + hora;
    const trechosBus = transporte === "Ônibus do Sesc" && !resultado.pendente
      ? "<p>Embarque na origem: <b>" + html(resultado.embOrigem || "—") + "</b>" +
        (resultado.embSesc ? "<br>Embarque no destino (volta no Sesc): <b>" + html(resultado.embSesc) + "</b>" : "") +
        (resultado.fim ? "<br>Fim da mediação: <b>" + html(resultado.fim) + "</b>" : "") +
        (resultado.estimativa ? "<br>O tempo de rua é uma estimativa. A supervisão pode ajustar." : "") +
        "</p>"
      : "";
    const falha = await enviarEmail(
      resend,
      de,
      email,
      "Recebemos sua solicitação de agendamento — Sesc Piracicaba",
      "<p>Recebemos a solicitação de agendamento de <b>" + html(escola) + "</b> para " + html(quando) + ".</p>" +
        trechosBus +
        "<p>Sua solicitação <b>reservou o horário</b> e será analisada pela supervisão da mediação cultural. Em breve você recebe informações se a visita está confirmada.</p>",
    );
    emailEnviado = !falha;
    emailAviso = falha
      ? "A solicitação foi registrada e o horário ficou reservado. O e-mail de aviso não saiu: " + falha
      : "Enviamos o aviso de recebimento para " + email + ". A solicitação será analisada e, em breve, você recebe se está confirmada.";
    if (emailOk(inbox)) {
      await enviarEmail(
        resend,
        de,
        inbox,
        "Nova solicitação de agendamento — " + escola,
        "<p>Chegou uma solicitação com status <b>Solicitado</b>. O horário já está reservado. Confira os dados e, se estiver tudo certo, mude o status para <b>Confirmado</b>.</p><p><b>" + html(escola) + "</b><br>" + html(quando) + "<br>" + html(texto(body.contato, 40)) + "<br>" + html(email) + "<br>" + html(transporte) + "</p><p><a href=\"" + html(linkFicha(req, id)) + "\">Abrir a ficha desta solicitação</a></p>",
      );
    }
  } else {
    emailAviso = "A solicitação foi registrada e o horário ficou reservado. O envio de e-mail ainda não está ativo.";
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
    estimativa: resultado.estimativa,
    encurtada: resultado.encurtada,
    emailEnviado,
    emailAviso,
  });
});
