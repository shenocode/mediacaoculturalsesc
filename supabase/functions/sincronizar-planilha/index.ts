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

function tabela(linhas: Linha[], mark: Record<string, number>, prefix: string, titulo: string, rows: { data: string; sem: string; n: number; obs: string }[]) {
  mark[prefix + "Tit"] = linhas.length;
  linhas.push([titulo, "", "", ""]);
  mark[prefix + "Head"] = linhas.length;
  linhas.push(["Data", "Dia da semana", "Pessoas", "Observação"]);
  mark[prefix + "Ini"] = linhas.length;
  if (!rows.length) linhas.push(["—", "—", 0, "Nenhum registro ainda"]);
  else rows.forEach((r) => linhas.push([r.data, r.sem, r.n, r.obs]));
  mark[prefix + "Fim"] = linhas.length;
  mark[prefix + "Tot"] = linhas.length;
  linhas.push(["Total", "", rows.reduce((s, r) => s + r.n, 0), ""]);
}

function montar(ags: Record<string, unknown>[], dias: Map<string, Dia>, ideias: Record<string, unknown>[]) {
  const porDia = new Map<string, number>();
  const datasGrp = new Set<string>();
  ags.forEach((x) => {
    if (String(x.status || "") !== "Realizado") return;
    const d = String(x.data || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    datasGrp.add(d);
    const n = alunosDe(x.alunos);
    if (n) porDia.set(d, (porDia.get(d) || 0) + n);
  });
  const datasEsp = new Set<string>();
  dias.forEach((v, d) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    if (v.grpManual || String(v.grpObs || "").trim()) datasGrp.add(d);
    if (v.esp > 0 || String(v.espObs || "").trim()) datasEsp.add(d);
  });
  const grp = [...datasGrp].sort().map((d) => {
    const v = dias.get(d);
    const n = v && v.grpManual ? v.grp : Math.round(porDia.get(d) || 0);
    return { data: dataBR(d), sem: semana(d), n, obs: v?.grpObs || "" };
  });
  const esp = [...datasEsp].sort().map((d) => {
    const v = dias.get(d) || { esp: 0, espObs: "", grp: 0, grpManual: 0, grpObs: "" };
    return { data: dataBR(d), sem: semana(d), n: v.esp, obs: v.espObs || "" };
  });
  const linhas: Linha[] = [];
  const mark: Record<string, number> = {};
  linhas.push(["MEDIAÇÃO CULTURAL | EDUCATIVO SESC", "", "", ""]);
  linhas.push(["Relatório de mediação", "", "", ""]);
  linhas.push(["Exposição Letras & Filetes · todos os registros do painel", "", "", ""]);
  linhas.push(["Atualizado em " + agora() + " · esta aba é reescrita pelo painel. As anotações da gestão ficam na outra aba.", "", "", ""]);
  mark.faixa1 = linhas.length;
  linhas.push(["", "", "", ""]);
  mark.faixa2 = linhas.length;
  linhas.push(["", "", "", ""]);
  linhas.push(["", "", "", ""]);
  tabela(linhas, mark, "grp", "Visitas de grupos/agendamentos", grp);
  linhas.push(["", "", "", ""]);
  tabela(linhas, mark, "esp", "Ativações livres do educativo", esp);
  linhas.push(["", "", "", ""]);
  mark.rodape = linhas.length;
  linhas.push(["Mediação Cultural | Educativo Sesc · Letras & Filetes: Memória Afetiva e Latinidades", "", "", ""]);
  linhas.push(["", "", "", ""]);
  mark.graf = linhas.length;
  linhas.push(["Gráficos", "", "", ""]);
  for (let i = 0; i < 52; i++) linhas.push(["", "", "", ""]);
  return { linhas, mark, grp: grp.length, esp: esp.length, blocos: graficos(ags, ideias) };
}

function gradeDados(blocos: Bloco[]) {
  const grid: Linha[] = Array.from({ length: 42 }, () => Array.from({ length: 12 }, () => ""));
  const refs: { titulo: string; row: number; col: number; n: number }[] = [];
  blocos.forEach((b, i) => {
    const col = (i % 3) * 4;
    const row = Math.floor(i / 3) * 14;
    grid[row][col] = b.titulo;
    grid[row + 1][col] = "Rótulo";
    grid[row + 1][col + 1] = b.unidade;
    b.fatias.forEach((f, k) => {
      grid[row + 2 + k][col] = f.label;
      grid[row + 2 + k][col + 1] = f.n;
    });
    refs.push({ titulo: b.titulo, row: row + 2, col, n: b.fatias.length });
  });
  return { grid, refs };
}

function pedidosFormato(sheetId: number, mark: Record<string, number>) {
  const base = {
    backgroundColor: WHITE,
    textFormat: texto(INK, 11, false),
    horizontalAlignment: "LEFT",
    verticalAlignment: "MIDDLE",
    wrapStrategy: "WRAP",
  };
  const req: Record<string, unknown>[] = [];
  req.push({ unmergeCells: { range: caixa(sheetId, 0, 0, 220, 4) } });
  req.push(fmt(sheetId, 0, 0, 220, 4, base));
  [0, 1, 2, 3, mark.rodape, mark.graf].forEach((r) => {
    if (r == null) return;
    req.push({ mergeCells: { range: caixa(sheetId, r, 0, r + 1, 4), mergeType: "MERGE_ALL" } });
  });
  req.push(fmt(sheetId, 0, 0, 1, 4, { ...base, textFormat: texto(RED, 11, true) }));
  req.push(fmt(sheetId, 1, 0, 2, 4, { ...base, textFormat: texto(NAVY, 22, true), verticalAlignment: "BOTTOM" }));
  req.push(fmt(sheetId, 2, 0, 3, 4, { ...base, textFormat: texto(MUTED, 12, false) }));
  req.push(fmt(sheetId, 3, 0, 4, 4, { ...base, textFormat: texto(MUTED, 10, false), wrapStrategy: "WRAP" }));
  req.push(fmt(sheetId, mark.faixa1, 0, mark.faixa1 + 1, 4, { ...base, backgroundColor: RED }));
  req.push(fmt(sheetId, mark.faixa2, 0, mark.faixa2 + 1, 4, { ...base, backgroundColor: GOLD }));
  req.push(fmt(sheetId, mark.graf, 0, mark.graf + 1, 4, { ...base, textFormat: texto(NAVY, 16, true) }));
  req.push(fmt(sheetId, mark.rodape, 0, mark.rodape + 1, 4, { ...base, textFormat: texto(MUTED, 9, false) }));
  (["grp", "esp"] as const).forEach((p) => {
    const tit = mark[p + "Tit"];
    const head = mark[p + "Head"];
    const ini = mark[p + "Ini"];
    const fim = mark[p + "Fim"];
    const tot = mark[p + "Tot"];
    req.push({ mergeCells: { range: caixa(sheetId, tit, 0, tit + 1, 4), mergeType: "MERGE_ALL" } });
    req.push(fmt(sheetId, tit, 0, tit + 1, 4, {
      ...base,
      textFormat: texto(NAVY, 14, true),
      borders: { bottom: borda("SOLID_MEDIUM", RED) },
    }));
    req.push(fmt(sheetId, head, 0, head + 1, 4, {
      ...base,
      backgroundColor: NAVY,
      textFormat: texto(WHITE, 11, true),
      borders: {
        top: borda("SOLID", NAVY),
        bottom: borda("SOLID", NAVY),
        left: borda("SOLID", NAVY),
        right: borda("SOLID", NAVY),
      },
    }));
    req.push(fmt(sheetId, head, 2, head + 1, 3, {
      ...base,
      backgroundColor: NAVY,
      textFormat: texto(WHITE, 11, true),
      horizontalAlignment: "RIGHT",
    }));
    if (fim > ini) {
      req.push(fmt(sheetId, ini, 0, fim, 4, {
        ...base,
        borders: { top: borda("SOLID"), bottom: borda("SOLID"), left: borda("SOLID"), right: borda("SOLID") },
      }));
      req.push(fmt(sheetId, ini, 2, fim, 3, {
        ...base,
        textFormat: texto(NAVY, 11, true),
        horizontalAlignment: "RIGHT",
        numberFormat: { type: "NUMBER", pattern: "0" },
        borders: { top: borda("SOLID"), bottom: borda("SOLID"), left: borda("SOLID"), right: borda("SOLID") },
      }));
    }
    req.push({ mergeCells: { range: caixa(sheetId, tot, 0, tot + 1, 2), mergeType: "MERGE_ALL" } });
    req.push(fmt(sheetId, tot, 0, tot + 1, 4, {
      ...base,
      backgroundColor: CREAM,
      textFormat: texto(NAVY, 11, true),
      borders: { top: borda("SOLID"), bottom: borda("SOLID"), left: borda("SOLID"), right: borda("SOLID") },
    }));
    req.push(fmt(sheetId, tot, 2, tot + 1, 3, {
      ...base,
      backgroundColor: CREAM,
      textFormat: texto(NAVY, 11, true),
      horizontalAlignment: "RIGHT",
      numberFormat: { type: "NUMBER", pattern: "0" },
      borders: { top: borda("SOLID"), bottom: borda("SOLID"), left: borda("SOLID"), right: borda("SOLID") },
    }));
  });
  const alturas: [number, number, number][] = [[1, 2, 36], [mark.faixa1, mark.faixa1 + 1, 8], [mark.faixa2, mark.faixa2 + 1, 6]];
  alturas.forEach(([a, b, px]) => {
    req.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "ROWS", startIndex: a, endIndex: b },
        properties: { pixelSize: px },
        fields: "pixelSize",
      },
    });
  });
  [[0, 140], [1, 180], [2, 110], [3, 360]].forEach(([i, px]) => {
    req.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: px },
        fields: "pixelSize",
      },
    });
  });
  req.push({
    updateSheetProperties: {
      properties: { sheetId, tabColor: RED, gridProperties: { hideGridlines: true, frozenRowCount: 6 } },
      fields: "tabColor,gridProperties.hideGridlines,gridProperties.frozenRowCount",
    },
  });
  return req;
}

function pedidosGraficos(relId: number, dadosId: number, refs: { titulo: string; row: number; col: number; n: number }[], anchor: number) {
  return refs.map((ref, i) => ({
    addChart: {
      chart: {
        spec: {
          title: ref.titulo,
          titleTextFormat: texto(NAVY, 12, true),
          fontName: "Arial",
          backgroundColor: WHITE,
          pieChart: {
            legendPosition: "RIGHT_LEGEND",
            domain: {
              sourceRange: {
                sources: [caixa(dadosId, ref.row, ref.col, ref.row + ref.n, ref.col + 1)],
              },
            },
            series: {
              sourceRange: {
                sources: [caixa(dadosId, ref.row, ref.col + 1, ref.row + ref.n, ref.col + 2)],
              },
            },
          },
        },
        position: {
          overlayPosition: {
            anchorCell: { sheetId: relId, rowIndex: anchor + 1 + Math.floor(i / 2) * 16, columnIndex: (i % 2) * 5 },
            offsetXPixels: 4,
            offsetYPixels: 4,
            widthPixels: 460,
            heightPixels: 268,
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
    const doc = montar(ags, dias, ideias);
    const dados = gradeDados(doc.blocos);

    let meta = await gfetch(base + "?fields=sheets(properties,charts(chartId))", access) as {
      sheets?: { properties: { sheetId: number; title: string }; charts?: { chartId: number }[] }[];
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
      meta = await gfetch(base + "?fields=sheets(properties,charts(chartId))", access) as typeof meta;
      abas = titles();
    }
    const rel = abas.get(ABA_REL);
    const dadosAba = abas.get(ABA_DADOS);
    const notasAba = abas.get(ABA_NOTAS);
    if (!rel || !dadosAba || !notasAba) throw new Error("Não foi possível preparar as abas da planilha.");

    let notasVazias = false;
    try {
      const atual = await gfetch(base + "/values/" + encodeURIComponent("'" + ABA_NOTAS + "'!A1"), access) as { values?: string[][] };
      notasVazias = !String(atual.values?.[0]?.[0] || "").trim();
    } catch {
      notasVazias = true;
    }

    await gfetch(base + "/values:batchClear", access, {
      method: "POST",
      body: JSON.stringify({ ranges: ["'" + ABA_REL + "'!A1:D220", "'" + ABA_DADOS + "'!A1:L42"] }),
    });
    const data: { range: string; values: Linha[] }[] = [
      { range: "'" + ABA_REL + "'!A1", values: doc.linhas },
      { range: "'" + ABA_DADOS + "'!A1", values: dados.grid },
    ];
    if (notasVazias) {
      data.push({
        range: "'" + ABA_NOTAS + "'!A1",
        values: [
          ["Anotações da gestão", "", ""],
          ["Esta aba é de vocês. O painel não apaga o que for escrito aqui. A aba Relatório é atualizada sozinha quando uma visita é marcada como Realizado ou quando uma ativação livre é lançada.", "", ""],
          ["", "", ""],
          ["Data", "Tema", "Anotação"],
        ],
      });
    }
    await gfetch(base + "/values:batchUpdate", access, {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "RAW", data }),
    });

    const req = pedidosFormato(rel.properties.sheetId, doc.mark);
    (rel.charts || []).forEach((c) => req.push({ deleteEmbeddedObject: { objectId: c.chartId } }));
    pedidosGraficos(rel.properties.sheetId, dadosAba.properties.sheetId, dados.refs, doc.mark.graf).forEach((c) => req.push(c));
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
    return json({ ok: true, grupos: doc.grp, livres: doc.esp, graficos: doc.blocos.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Não foi possível atualizar a planilha.";
    const status = /chave|incompleta|não está no servidor/i.test(msg) ? 500 : 502;
    return json({ error: erroGoogle(msg, email) }, status);
  }
});
