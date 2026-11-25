import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SHEET_FALLBACK = "1TNRULU_r1wCQIh7D7bUsktIeIF7J68FtGPWLgtqeZc4";
const ABA_REL = "Relatório";
const ABA_DADOS = "Dados";
const ABA_NOTAS = "Anotações da gestão";
const SEM = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
type Dia = { esp: number; espObs: string; grp: number; grpManual: number; grpObs: string };
type Fatia = { label: string; n: number };
type Bloco = { titulo: string; unidade: string; fatias: Fatia[] };
type Linha = (string | number)[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function hex(h: string) {
  const n = parseInt(h.slice(1), 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

const NAVY = hex("#2d2e5f");
const RED = hex("#c4301b");
const GOLD = hex("#ebb819");
const CREAM = hex("#fbf6ea");
const INK = hex("#23243f");
const MUTED = hex("#5c5e78");
const LINE = hex("#e4dcc4");
const WHITE = { red: 1, green: 1, blue: 1 };

function texto(cor: { red: number; green: number; blue: number }, tamanho: number, negrito: boolean) {
  return { foregroundColor: cor, fontFamily: "Arial", fontSize: tamanho, bold: negrito };
}

function borda(style: string, cor = LINE) {
  return { style, color: cor };
}

function caixa(sheetId: number, r1: number, c1: number, r2: number, c2: number) {
  return { sheetId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 };
}

function fmt(sheetId: number, r1: number, c1: number, r2: number, c2: number, format: Record<string, unknown>) {
  return {
    repeatCell: {
      range: caixa(sheetId, r1, c1, r2, c2),
      cell: { userEnteredFormat: format },
      fields: "userEnteredFormat",
    },
  };
}

function b64url(data: Uint8Array | string) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemPkcs8(pem: string) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function jwtPayload(token: string) {
  try {
    const part = token.split(".")[1] || "";
    const pad = part.replace(/-/g, "+").replace(/_/g, "/");
    const jsonText = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
    return JSON.parse(jsonText) as { role?: string };
  } catch {
    return {};
  }
}

function contaGoogle() {
  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") || "";
  if (raw.length < 40) throw new Error("A chave da conta de serviço não está no servidor.");
  const sa = JSON.parse(raw) as { client_email?: string; private_key?: string };
  if (!sa.client_email || !sa.private_key) throw new Error("A chave da conta de serviço está incompleta.");
  return { email: sa.client_email, key: sa.private_key };
}

async function tokenGoogle(email: string, privateKey: string) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const data = head + "." + claim;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemPkcs8(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data)));
  const assertion = data + "." + b64url(sig);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const body = await r.json();
  if (!r.ok || !body.access_token) throw new Error(body.error_description || body.error || "O Google não aceitou a chave.");
  return String(body.access_token);
}

function erroGoogle(msg: string, email: string) {
  const m = msg.toLowerCase();
  if (m.includes("has not been used") || m.includes("is disabled") || m.includes("accessnotconfigured")) {
    return "Ative a Google Sheets API no projeto painel-mediacao do Google Cloud e abra o painel de novo.";
  }
  if (m.includes("permission") || m.includes("forbidden") || m.includes("not found") || m.includes("403")) {
    return "Compartilhe a planilha como Editor com " + email + ".";
  }
  return "A planilha não atualizou. " + msg.slice(0, 220);
}

async function gfetch(url: string, token: string, init: RequestInit = {}) {
  const r = await fetch(url, {
    ...init,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await r.text();
  let body: { error?: { message?: string } } | null = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!r.ok) throw new Error(body?.error?.message || text.slice(0, 300) || ("HTTP " + r.status));
  return body || {};
}

function semana(iso: string) {
  const p = iso.split("-").map(Number);
  if (p.length < 3 || !p[0]) return "";
  const s = SEM[new Date(Date.UTC(p[0], p[1] - 1, p[2], 15)).getUTCDay()] || "";
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

function dataBR(iso: string) {
  const p = iso.split("-");
  return p.length >= 3 ? p[2] + "/" + p[1] + "/" + p[0] : iso;
}

function dataFormula(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return `=DATA(${y};${m};${d})`;
}

function serialDe(v: unknown): number | "" {
  if (typeof v === "number" && v > 20000 && v < 80000) return Math.round(v);
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n > 20000 && n < 80000 ? Math.round(n) : "";
  }
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const y = br ? +br[3] : iso ? +iso[1] : 0;
  const m = br ? +br[2] : iso ? +iso[2] : 0;
  const d = br ? +br[1] : iso ? +iso[3] : 0;
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return "";
  return Math.round(Date.UTC(y, m - 1, d) / 86400000) + 25569;
}

function celula(v: unknown) {
  const t = String(v ?? "").replace(/\r/g, "").replace(/'/g, "’").trim();
  if (!t) return "";
  if (/^[=+\-@]/.test(t)) return "'" + t;
  return t;
}

const DE_DADOS = "SE('Relatório'!$B$8=\"\";DATA(2000;1;1);'Relatório'!$B$8)";
const ATE_DADOS = "SE('Relatório'!$D$8=\"\";DATA(2100;12;31);'Relatório'!$D$8)";
const DE_LOCAL = 'SE($B$8="";DATA(2000;1;1);$B$8)';
const ATE_LOCAL = 'SE($D$8="";DATA(2100;12;31);$D$8)';

function datasQuery(col: string) {
  return `${col} >= date '"&TEXTO(${DE_DADOS};"yyyy-mm-dd")&"' and ${col} <= date '"&TEXTO(${ATE_DADOS};"yyyy-mm-dd")&"'`;
}

function formulaFaixa(col: string) {
  const n = `CONT.SES(Dados!J2:J500;">="&${DE_DADOS};Dados!J2:J500;"<="&${ATE_DADOS};Dados!Q2:Q500;1)`;
  const q = (flag: string) => `"select ${col}, sum(L) where ${datasQuery("J")} and ${flag} = 1 group by ${col} order by sum(L) desc limit 8 label ${col} '', sum(L) ''"`;
  return `=SEERRO(SE(${n}>0;QUERY(Dados!J2:R500;${q("Q")};0);QUERY(Dados!J2:R500;${q("R")};0));{"Sem dados no período"\\0})`;
}

function formulaContagem(col: string, extra: string) {
  return `=SEERRO(QUERY(Dados!J2:R500;"select ${col}, count(${col}) where ${datasQuery("J")} ${extra} group by ${col} order by count(${col}) desc limit 8 label ${col} '', count(${col}) ''";0);{"Sem dados no período"\\0})`;
}

function formulaAcesso() {
  const cont = (pcd: number) => `CONT.SES(Dados!J2:J500;">="&${DE_DADOS};Dados!J2:J500;"<="&${ATE_DADOS};Dados!R2:R500;1;Dados!P2:P500;${pcd})`;
  return `=SE(${cont(1)}=0;{"Sem dados no período"\\0};{"Com registro de pessoas com deficiência"\\${cont(1)};"Sem esse registro"\\${cont(0)}})`;
}

function formulaPublico() {
  return `=SEERRO(QUERY(Dados!T2:U500;"select U, count(U) where ${datasQuery("T")} group by U order by count(U) desc limit 8 label U '', count(U) ''";0);{"Sem dados no período"\\0})`;
}

function formulaTotal(col: string, flag: string) {
  return `=SEERRO(SOMA(FILTER(Dados!${col}2:${col}500;(Dados!A2:A500>=${DE_DADOS})*(Dados!A2:A500<=${ATE_DADOS})*(Dados!${flag}2:${flag}500=1)));0)`;
}

function formulaCorpo() {
  const g = `SEERRO(FILTER({TEXTO(Dados!A2:A500;"dd/mm/yyyy")\\Dados!B2:B500\\Dados!C2:C500\\Dados!D2:D500};(Dados!A2:A500>=${DE_LOCAL})*(Dados!A2:A500<=${ATE_LOCAL})*(Dados!G2:G500=1));{"—"\\"—"\\0\\"Nenhum registro ainda"})`;
  const e = `SEERRO(FILTER({TEXTO(Dados!A2:A500;"dd/mm/yyyy")\\Dados!B2:B500\\Dados!E2:E500\\Dados!F2:F500};(Dados!A2:A500>=${DE_LOCAL})*(Dados!A2:A500<=${ATE_LOCAL})*(Dados!H2:H500=1));{"—"\\"—"\\0\\"Nenhum registro ainda"})`;
  return `={${g};{"Total"\\""\\Dados!Z1\\""};{""\\""\\""\\""};{"Ativações livres do educativo"\\""\\""\\""};{"Data"\\"Dia da semana"\\"Pessoas"\\"Observação"};${e};{"Total"\\""\\Dados!Z2\\""}}`;
}

const GRAFICOS_FIXOS = [
  { titulo: "Faixa etária", formula: () => formulaFaixa("M") },
  { titulo: "Tipo de instituição", formula: () => formulaFaixa("N") },
  { titulo: "Situação dos grupos", formula: () => formulaContagem("K", "and K <> 'Solicitado'") },
  { titulo: "Dia da semana", formula: () => formulaContagem("O", "and R = 1") },
  { titulo: "Acessibilidade", formula: () => formulaAcesso() },
  { titulo: "Público das oficinas", formula: () => formulaPublico() },
];

function agora() {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const p = (t: string) => parts.find((x) => x.type === t)?.value || "";
  return p("day") + "/" + p("month") + "/" + p("year") + " às " + p("hour") + ":" + p("minute");
}

function alunosDe(v: unknown) {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function inteiro(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function naAgenda(status: string) {
  return status !== "Cancelado" && status !== "Solicitado";
}

function fatias(itens: { label: string; n: number }[]) {
  let rows = itens.filter((x) => x.n > 0).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, "pt"));
  if (rows.length > 8) {
    const resto = rows.slice(7).reduce((s, x) => s + x.n, 0);
    rows = rows.slice(0, 7);
    if (resto) rows.push({ label: "Outras", n: resto });
  }
  if (!rows.length) return [];
  if (rows.length === 1 && /^n[aã]o informado$/i.test(rows[0].label)) return [];
  return rows;
}

function somar(list: Record<string, unknown>[], keyOf: (x: Record<string, unknown>) => string, peso: (x: Record<string, unknown>) => number) {
  const m = new Map<string, number>();
  list.forEach((x) => {
    const w = peso(x);
    if (w <= 0) return;
    const k = String(keyOf(x) || "").trim() || "Não informado";
    m.set(k, (m.get(k) || 0) + w);
  });
  return fatias([...m.entries()].map(([label, n]) => ({ label, n })));
}

function diaSemana(iso: string) {
  const p = String(iso || "").split("-").map(Number);
  if (p.length < 3 || !p[0]) return "";
  const nomes = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
  return nomes[new Date(Date.UTC(p[0], p[1] - 1, p[2], 15)).getUTCDay()] || "";
}

function dataOficina(x: Record<string, unknown>) {
  const dias = String(x.dias || "").split(",").map((s) => s.trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (dias.length) return dias[0];
  const one = String(x.data || x.dt || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(one) ? one : "";
}

function graficos(ags: Record<string, unknown>[], ideias: Record<string, unknown>[]): Bloco[] {
  const ag = ags.filter((x) => naAgenda(String(x.status || "Agendado")));
  const re = ag.filter((x) => String(x.status || "") === "Realizado");
  const cancel = ags.filter((x) => String(x.status || "") === "Cancelado");
  const base = re.length ? re : ag;
  const quem = re.length ? "pessoas atendidas" : "pessoas previstas";
  const pessoas = (x: Record<string, unknown>) => alunosDe(x.alunos);
  const ofi = ideias.filter((x) => {
    if (String(x.papel || "") === "cotidiana") return false;
    const st = String(x.status || "");
    return (st === "Aprovada" || st === "Em piloto") && !!dataOficina(x);
  });
  const out: Bloco[] = [];
  const add = (titulo: string, unidade: string, slices: Fatia[]) => {
    if (slices.length) out.push({ titulo, unidade, fatias: slices });
  };
  add("Faixa etária (" + quem + ")", "pessoas", somar(base, (x) => String(x.serie || ""), pessoas));
  add("Tipo de instituição (" + quem + ")", "pessoas", somar(base, (x) => String(x.tipo || ""), pessoas));
  add("Situação dos grupos", "grupos", somar(ag.concat(cancel), (x) => String(x.status || "Agendado"), () => 1));
  add("Dia da semana", "grupos", somar(ag, (x) => diaSemana(String(x.data || "")), () => 1));
  const pcd = ag.filter((x) => String(x.pcd || "").trim()).length;
  if (pcd) {
    add("Acessibilidade", "grupos", fatias([
      { label: "Com registro de pessoas com deficiência", n: pcd },
      { label: "Sem esse registro", n: Math.max(0, ag.length - pcd) },
    ]));
  }
  add("Público-alvo das oficinas", "oficinas", somar(ofi, (x) => String(x.publico || ""), () => 1));
  return out;
}

function isoDia(v: unknown) {
  const d = String(v || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "";
}

function montarBases(ags: Record<string, unknown>[], dias: Map<string, Dia>, ideias: Record<string, unknown>[]) {
  const porDia = new Map<string, number>();
  const datasGrp = new Set<string>();
  ags.forEach((x) => {
    if (String(x.status || "") !== "Realizado") return;
    const d = isoDia(x.data);
    if (!d) return;
    datasGrp.add(d);
    const n = alunosDe(x.alunos);
    if (n) porDia.set(d, (porDia.get(d) || 0) + n);
  });
  const datasEsp = new Set<string>();
  dias.forEach((v, d) => {
    if (!isoDia(d)) return;
    if (v.grpManual || String(v.grpObs || "").trim()) datasGrp.add(d);
    if (v.esp > 0 || String(v.espObs || "").trim()) datasEsp.add(d);
  });
  const todos = [...new Set([...datasGrp, ...datasEsp])].sort();
  const linhasDias: Linha[] = [[
    "Data", "Dia da semana", "Pessoas grupos", "Observação grupos", "Pessoas livres", "Observação livres", "Grupos", "Livres",
  ]];
  todos.forEach((d) => {
    const v = dias.get(d);
    const n = v && v.grpManual ? v.grp : Math.round(porDia.get(d) || 0);
    linhasDias.push([
      dataFormula(d),
      semana(d),
      n,
      celula(v?.grpObs || ""),
      v?.esp || 0,
      celula(v?.espObs || ""),
      datasGrp.has(d) ? 1 : 0,
      datasEsp.has(d) ? 1 : 0,
    ]);
  });
  const linhasAg: Linha[] = [["Data", "Status", "Alunos", "Série", "Tipo", "Dia", "PCD", "Realizado", "Na agenda"]];
  ags.forEach((x) => {
    const d = isoDia(x.data);
    if (!d) return;
    const status = celula(x.status || "Agendado") || "Agendado";
    linhasAg.push([
      dataFormula(d),
      status,
      alunosDe(x.alunos),
      celula(x.serie || "") || "Não informado",
      celula(x.tipo || "") || "Não informado",
      diaSemana(d) || "Não informado",
      String(x.pcd || "").trim() ? 1 : 0,
      status === "Realizado" ? 1 : 0,
      naAgenda(status) ? 1 : 0,
    ]);
  });
  const linhasOfi: Linha[] = [["Data", "Público"]];
  ideias.forEach((x) => {
    if (String(x.papel || "") === "cotidiana") return;
    const st = String(x.status || "");
    if (st !== "Aprovada" && st !== "Em piloto") return;
    const d = dataOficina(x);
    if (!d) return;
    linhasOfi.push([dataFormula(d), celula(x.publico || "") || "Não informado"]);
  });
  return { linhasDias, linhasAg, linhasOfi, grupos: datasGrp.size, livres: datasEsp.size };
}

function cabecalhoRelatorio(de: number | "", ate: number | "") {
  return [
    ["MEDIAÇÃO CULTURAL | EDUCATIVO SESC", "", "", ""],
    ["Relatório de mediação", "", "", ""],
    ["Exposição Letras & Filetes", "", "", ""],
    ["Atualizado em " + agora() + " · De e Até escolhem o período e não são apagados. Anotações da gestão ficam na outra aba.", "", "", ""],
    ["", "", "", ""],
    ["", "", "", ""],
    ["", "", "", ""],
    ["De", de, "Até", ate],
    ["Deixe em branco para ver todos os registros. Ao escolher as datas, tabelas e gráficos mudam na hora.", "", "", ""],
    ["", "", "", ""],
    ["Visitas de grupos/agendamentos", "", "", ""],
    ["Data", "Dia da semana", "Pessoas", "Observação"],
  ];
}
function pedidosFormato(sheetId: number) {
  const base = {
    backgroundColor: WHITE,
    textFormat: texto(INK, 11, false),
    horizontalAlignment: "LEFT",
    verticalAlignment: "MIDDLE",
    wrapStrategy: "WRAP",
  };
  const req: Record<string, unknown>[] = [];
  req.push(fmt(sheetId, 0, 0, 80, 4, base));
  [0, 1, 2, 3, 8, 10].forEach((r) => {
    req.push({ mergeCells: { range: caixa(sheetId, r, 0, r + 1, 4), mergeType: "MERGE_ALL" } });
  });
  req.push(fmt(sheetId, 0, 0, 1, 4, { ...base, textFormat: texto(RED, 11, true) }));
  req.push(fmt(sheetId, 1, 0, 2, 4, { ...base, textFormat: texto(NAVY, 22, true), verticalAlignment: "BOTTOM" }));
  req.push(fmt(sheetId, 2, 0, 3, 4, { ...base, textFormat: texto(MUTED, 12, false) }));
  req.push(fmt(sheetId, 3, 0, 4, 4, { ...base, textFormat: texto(MUTED, 10, false), wrapStrategy: "WRAP" }));
  req.push(fmt(sheetId, 4, 0, 5, 4, { ...base, backgroundColor: RED }));
  req.push(fmt(sheetId, 5, 0, 6, 4, { ...base, backgroundColor: GOLD }));
  req.push(fmt(sheetId, 7, 0, 8, 1, { ...base, textFormat: texto(NAVY, 12, true), horizontalAlignment: "RIGHT" }));
  req.push(fmt(sheetId, 7, 2, 8, 3, { ...base, textFormat: texto(NAVY, 12, true), horizontalAlignment: "RIGHT" }));
  req.push(fmt(sheetId, 7, 1, 8, 2, {
    ...base,
    backgroundColor: CREAM,
    textFormat: texto(NAVY, 12, true),
    horizontalAlignment: "CENTER",
    numberFormat: { type: "DATE", pattern: "dd/mm/yyyy" },
    borders: { top: borda("SOLID", NAVY), bottom: borda("SOLID", NAVY), left: borda("SOLID", NAVY), right: borda("SOLID", NAVY) },
  }));
  req.push(fmt(sheetId, 7, 3, 8, 4, {
    ...base,
    backgroundColor: CREAM,
    textFormat: texto(NAVY, 12, true),
    horizontalAlignment: "CENTER",
    numberFormat: { type: "DATE", pattern: "dd/mm/yyyy" },
    borders: { top: borda("SOLID", NAVY), bottom: borda("SOLID", NAVY), left: borda("SOLID", NAVY), right: borda("SOLID", NAVY) },
  }));
  req.push(fmt(sheetId, 8, 0, 9, 4, { ...base, textFormat: texto(MUTED, 10, false), wrapStrategy: "WRAP" }));
  req.push(fmt(sheetId, 10, 0, 11, 4, {
    ...base,
    textFormat: texto(NAVY, 14, true),
    borders: { bottom: borda("SOLID_MEDIUM", RED) },
  }));
  req.push(fmt(sheetId, 11, 0, 12, 4, {
    ...base,
    backgroundColor: NAVY,
    textFormat: texto(WHITE, 11, true),
  }));
  req.push(fmt(sheetId, 11, 2, 12, 3, {
    ...base,
    backgroundColor: NAVY,
    textFormat: texto(WHITE, 11, true),
    horizontalAlignment: "RIGHT",
  }));
  req.push(fmt(sheetId, 12, 0, 80, 4, {
    ...base,
    borders: { top: borda("SOLID"), bottom: borda("SOLID"), left: borda("SOLID"), right: borda("SOLID") },
  }));
  req.push(fmt(sheetId, 12, 2, 80, 3, {
    ...base,
    textFormat: texto(NAVY, 11, true),
    horizontalAlignment: "RIGHT",
    numberFormat: { type: "NUMBER", pattern: "0" },
    borders: { top: borda("SOLID"), bottom: borda("SOLID"), left: borda("SOLID"), right: borda("SOLID") },
  }));
  [[1, 2, 36], [4, 5, 8], [5, 6, 6], [7, 8, 32]].forEach(([i, f, px]) => {
    req.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "ROWS", startIndex: i, endIndex: f },
        properties: { pixelSize: px },
        fields: "pixelSize",
      },
    });
  });
  [[0, 140], [1, 150], [2, 130], [3, 320]].forEach(([i, px]) => {
    req.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: px },
        fields: "pixelSize",
      },
    });
  });
  [1, 3].forEach((col) => {
    req.push({
      setDataValidation: {
        range: caixa(sheetId, 7, col, 8, col + 1),
        rule: { condition: { type: "DATE_IS_VALID" }, strict: false, showCustomUi: true },
      },
    });
  });
  req.push({
    updateSheetProperties: {
      properties: { sheetId, tabColor: RED, gridProperties: { hideGridlines: true, frozenRowCount: 8 } },
      fields: "tabColor,gridProperties.hideGridlines,gridProperties.frozenRowCount",
    },
  });
  return req;
}

function regraCond(sheetId: number, formula: string, format: Record<string, unknown>) {
  return {
    addConditionalFormatRule: {
      rule: {
        ranges: [caixa(sheetId, 12, 0, 400, 4)],
        booleanRule: {
          condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: formula }] },
          format,
        },
      },
      index: 0,
    },
  };
}

function pedidosGraficos(relId: number, dadosId: number) {
  return GRAFICOS_FIXOS.map((g, i) => ({
    addChart: {
      chart: {
        spec: {
          title: g.titulo,
          titleTextFormat: texto(NAVY, 12, true),
          fontName: "Arial",
          backgroundColor: WHITE,
          pieChart: {
            legendPosition: "RIGHT_LEGEND",
            domain: { sourceRange: { sources: [caixa(dadosId, 1 + i * 14, 22, 9 + i * 14, 23)] } },
            series: { sourceRange: { sources: [caixa(dadosId, 1 + i * 14, 23, 9 + i * 14, 24)] } },
          },
        },
        position: {
          overlayPosition: {
            anchorCell: { sheetId: relId, rowIndex: 10 + Math.floor(i / 2) * 16, columnIndex: 5 + (i % 2) * 5 },
            offsetXPixels: 8,
            offsetYPixels: 8,
            widthPixels: 420,
            heightPixels: 250,
          },
        },
      },
    },
  }));
}
async function lerTudo(admin: ReturnType<typeof createClient>, path: string) {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await admin.from("docs").select("id,data").eq("path", path).range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = data || [];
    rows.forEach((row) => out.push({ id: row.id, ...(row.data || {}) }));
    if (rows.length < 1000) break;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use o painel para atualizar a planilha." }, 405);

  const url = Deno.env.get("SUPABASE_URL") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ") || !url || !anon || !service) return json({ error: "Entre no painel para atualizar a planilha." }, 401);

  const token = auth.slice(7).trim();
  const papel = jwtPayload(token).role || "";
  if (papel !== "service_role") {
    const userClient = createClient(url, anon, { global: { headers: { Authorization: auth } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Sessão inválida. Entre de novo." }, 401);
    const adminCheck = createClient(url, service);
    const { data: profile } = await adminCheck.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
    const role = profile?.role || "";
    if (role !== "supervisao" && role !== "equipe") return json({ error: "Somente a equipe atualiza a planilha." }, 403);
  }

  let email = "";
  try {
    const sa = contaGoogle();
    email = sa.email;
    const sheetId = Deno.env.get("GOOGLE_SHEET_ID") || SHEET_FALLBACK;
    const access = await tokenGoogle(sa.email, sa.key);
    const base = "https://sheets.googleapis.com/v4/spreadsheets/" + sheetId;
    const admin = createClient(url, service);
    const [ags, ideias, diasRows] = await Promise.all([
      lerTudo(admin, "agendamentos"),
      lerTudo(admin, "ideias"),
      lerTudo(admin, "relatorio_dias"),
    ]);
    const dias = new Map<string, Dia>();
    diasRows.forEach((row) => {
      const id = String(row.id || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(id)) return;
      dias.set(id, {
        esp: inteiro(row.esp),
        espObs: String(row.espObs || ""),
        grp: inteiro(row.grp),
        grpManual: row.grpManual ? 1 : 0,
        grpObs: String(row.grpObs || ""),
      });
    });
    const bases = montarBases(ags, dias, ideias);

    let meta = await gfetch(base + "?fields=sheets(properties,charts(chartId),conditionalFormats)", access) as {
      sheets?: { properties: { sheetId: number; title: string }; charts?: { chartId: number }[]; conditionalFormats?: unknown[] }[];
    };
    const titles = () => new Map((meta.sheets || []).map((s) => [s.properties.title, s]));
    let abas = titles();
    const garantir: Record<string, unknown>[] = [];
    if (!abas.has(ABA_REL)) {
      const primeira = (meta.sheets || [])[0];
      if (!primeira) throw new Error("A planilha não tem nenhuma aba.");
      garantir.push({
        updateSheetProperties: {
          properties: { sheetId: primeira.properties.sheetId, title: ABA_REL },
          fields: "title",
        },
      });
    }
    if (!abas.has(ABA_DADOS)) garantir.push({ addSheet: { properties: { title: ABA_DADOS, hidden: true } } });
    if (!abas.has(ABA_NOTAS)) garantir.push({ addSheet: { properties: { title: ABA_NOTAS, tabColor: GOLD } } });
    if (garantir.length) {
      await gfetch(base + ":batchUpdate", access, { method: "POST", body: JSON.stringify({ requests: garantir }) });
      meta = await gfetch(base + "?fields=sheets(properties,charts(chartId),conditionalFormats)", access) as typeof meta;
      abas = titles();
    }
    const rel = abas.get(ABA_REL);
    const dadosAba = abas.get(ABA_DADOS);
    const notasAba = abas.get(ABA_NOTAS);
    if (!rel || !dadosAba || !notasAba) throw new Error("Não foi possível preparar as abas da planilha.");

    let de: number | "" = "";
    let ate: number | "" = "";
    try {
      const per = await gfetch(base + "/values/" + encodeURIComponent("'" + ABA_REL + "'!B8:D8") + "?valueRenderOption=UNFORMATTED_VALUE", access) as { values?: unknown[][] };
      const row = per.values?.[0] || [];
      de = serialDe(row[0]);
      ate = serialDe(row[2]);
      if (de !== "" && ate !== "" && de > ate) { const tmp = de; de = ate; ate = tmp; }
    } catch { /* a planilha ainda não tem o período */ }

    let notasVazias = false;
    try {
      const atual = await gfetch(base + "/values/" + encodeURIComponent("'" + ABA_NOTAS + "'!A1"), access) as { values?: string[][] };
      notasVazias = !String(atual.values?.[0]?.[0] || "").trim();
    } catch {
      notasVazias = true;
    }

    await gfetch(base + ":batchUpdate", access, {
      method: "POST",
      body: JSON.stringify({
        requests: [
          { updateSpreadsheetProperties: { properties: { locale: "pt_BR", timeZone: "America/Sao_Paulo" }, fields: "locale,timeZone" } },
          { unmergeCells: { range: caixa(rel.properties.sheetId, 0, 0, 400, 4) } },
        ],
      }),
    });
    await gfetch(base + "/values:batchClear", access, {
      method: "POST",
      body: JSON.stringify({ ranges: ["'" + ABA_REL + "'!A1:D400", "'" + ABA_DADOS + "'!A1:Z600"] }),
    });
    const data: { range: string; values: Linha[] }[] = [
      { range: "'" + ABA_REL + "'!A1", values: cabecalhoRelatorio(de, ate) },
      { range: "'" + ABA_REL + "'!A13", values: [[formulaCorpo()]] },
      { range: "'" + ABA_DADOS + "'!A1", values: bases.linhasDias },
      { range: "'" + ABA_DADOS + "'!J1", values: bases.linhasAg },
      { range: "'" + ABA_DADOS + "'!T1", values: bases.linhasOfi },
      { range: "'" + ABA_DADOS + "'!Z1", values: [[formulaTotal("C", "G")], [formulaTotal("E", "H")]] },
    ];
    GRAFICOS_FIXOS.forEach((g, i) => {
      const row = 1 + i * 14;
      data.push({ range: "'Dados'!W" + row, values: [[g.titulo]] });
      data.push({ range: "'Dados'!W" + (row + 1), values: [[g.formula()]] });
    });
    if (notasVazias) {
      data.push({
        range: "'" + ABA_NOTAS + "'!A1",
        values: [
          ["Anotações da gestão", "", ""],
          ["Esta aba é de vocês. O painel não apaga o que for escrito aqui. A aba Relatório é atualizada sozinha quando uma visita é marcada como Realizado ou quando uma ativação livre é lançada. De e Até, na aba Relatório, escolhem o período.", "", ""],
          ["", "", ""],
          ["Data", "Tema", "Anotação"],
        ],
      });
    }
    await gfetch(base + "/values:batchUpdate", access, {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
    });

    const req = pedidosFormato(rel.properties.sheetId);
    const regras = rel.conditionalFormats || [];
    for (let i = regras.length - 1; i >= 0; i--) req.push({ deleteConditionalFormatRule: { sheetId: rel.properties.sheetId, index: i } });
    req.push(regraCond(rel.properties.sheetId, '=$A13="Total"', { backgroundColor: CREAM, textFormat: { bold: true, foregroundColor: NAVY } }));
    req.push(regraCond(rel.properties.sheetId, '=$A13="Data"', { backgroundColor: NAVY, textFormat: { bold: true, foregroundColor: WHITE } }));
    req.push(regraCond(rel.properties.sheetId, '=$A13="Ativações livres do educativo"', { backgroundColor: WHITE, textFormat: { bold: true, foregroundColor: NAVY } }));
    (rel.charts || []).forEach((c) => req.push({ deleteEmbeddedObject: { objectId: c.chartId } }));
    pedidosGraficos(rel.properties.sheetId, dadosAba.properties.sheetId).forEach((c) => req.push(c));
    if (notasVazias) {
      const id = notasAba.properties.sheetId;
      const baseFmt = {
        backgroundColor: WHITE,
        textFormat: texto(INK, 11, false),
        verticalAlignment: "MIDDLE",
        wrapStrategy: "WRAP",
      };
      req.push({ mergeCells: { range: caixa(id, 0, 0, 1, 3), mergeType: "MERGE_ALL" } });
      req.push({ mergeCells: { range: caixa(id, 1, 0, 2, 3), mergeType: "MERGE_ALL" } });
      req.push(fmt(id, 0, 0, 1, 3, { ...baseFmt, textFormat: texto(NAVY, 20, true) }));
      req.push(fmt(id, 1, 0, 2, 3, { ...baseFmt, textFormat: texto(MUTED, 11, false) }));
      req.push(fmt(id, 3, 0, 4, 3, {
        ...baseFmt,
        backgroundColor: NAVY,
        textFormat: texto(WHITE, 11, true),
      }));
      [[0, 140], [1, 220], [2, 460]].forEach(([i, px]) => {
        req.push({
          updateDimensionProperties: {
            range: { sheetId: id, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
            properties: { pixelSize: px },
            fields: "pixelSize",
          },
        });
      });
      req.push({
        updateDimensionProperties: {
          range: { sheetId: id, dimension: "ROWS", startIndex: 1, endIndex: 2 },
          properties: { pixelSize: 48 },
          fields: "pixelSize",
        },
      });
      req.push({
        updateSheetProperties: {
          properties: { sheetId: id, tabColor: GOLD, gridProperties: { frozenRowCount: 4 } },
          fields: "tabColor,gridProperties.frozenRowCount",
        },
      });
    }
    await gfetch(base + ":batchUpdate", access, { method: "POST", body: JSON.stringify({ requests: req }) });
    return json({ ok: true, grupos: bases.grupos, livres: bases.livres, graficos: GRAFICOS_FIXOS.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Não foi possível atualizar a planilha.";
    const status = /chave|incompleta|não está no servidor/i.test(msg) ? 500 : 502;
    return json({ error: erroGoogle(msg, email) }, status);
  }
});
