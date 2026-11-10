import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TIPOS = [
  "Particular",
  "Escola Estadual",
  "Escola Municipal",
  "ONG",
  "Universidade",
  "Empresa",
  "Sesc / funcionários",
  "Outros",
];

const MIMES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use o envio de fotos na aba Agendamentos." }, 405);

  const url = Deno.env.get("SUPABASE_URL") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ") || !url || !anon || !service) {
    return json({ error: "Entre como supervisão para ler documentos." }, 401);
  }

  const userClient = createClient(url, anon, { global: { headers: { Authorization: auth } } });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json({ error: "Sessão inválida. Entre de novo." }, 401);

  const admin = createClient(url, service);
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!profile || profile.role !== "supervisao") {
    return json({ error: "Somente a supervisão lê documentos da gestão." }, 403);
  }

  let gemini = Deno.env.get("GOOGLE_GENERATIVE_AI_API_KEY") || "";
  if (gemini.length < 20) {
    const { data: stored, error: keyErr } = await admin.rpc("chave_leitura");
    if (!keyErr && typeof stored === "string") gemini = stored;
  }
  if (gemini.length < 20) {
    return json({ error: "A leitura de fotos ainda não foi ativada. Abra “Ativar a leitura” e cole a chave grátis do Google." }, 409);
  }

  let body: { images?: { mime?: string; data?: string }[]; hoje?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Não foi possível ler o envio." }, 400);
  }

  const images = (Array.isArray(body.images) ? body.images : []).slice(0, 8).filter((im) => {
    const mime = String(im?.mime || "");
    const data = String(im?.data || "");
    return MIMES.has(mime) && data.length > 20 && data.length < 8_000_000;
  });
  if (!images.length) return json({ error: "Envie ao menos uma foto nítida ou um PDF." }, 400);

  const hoje = /^\d{4}-\d{2}-\d{2}$/.test(String(body.hoje || "")) ? String(body.hoje) : new Date().toISOString().slice(0, 10);
  const prompt = `Você lê documentos de agendamento de visitas de grupos no Sesc Piracicaba (mediação cultural).
A data de hoje é ${hoje}.
As imagens podem ser, juntas:
- uma foto de tabela ou calendário com várias visitas (uma linha ou célula por grupo);
- folhas avulsas com o detalhe de cada visita.
Una a folha de detalhe à linha da tabela pelo nome do grupo e pela data. Se a folha não tiver par na tabela, crie a visita mesmo assim. Se a tabela não tiver folha, crie a visita com o que a tabela tiver.
Não invente nome, telefone, data, horário nem quantidade. O que não estiver legível fica vazio.
Datas em AAAA-MM-DD. Se o ano não aparecer, use o ano de ${hoje}, salvo se o mês da visita já passou há mais de dois meses — nesse caso use o ano seguinte.
Horários em HH:MM, 24 horas (9h = 09:00, 14h30 = 14:30). Se só houver um horário, use-o em hora e deixe fim vazio.
alunos é só o número de pessoas, sem texto.
tipo, se der para classificar, deve ser exatamente um destes: ${TIPOS.join(" | ")}. Se não der, deixe vazio.
Campos: escola (nome do grupo ou escola), data, hora, fim, alunos, tipo, serie (faixa etária, ano ou perfil), resp (responsável externo que chega com o grupo), contato (telefone), pcd (pessoas com deficiência: quantas e qual), obs (acessibilidade, interesses, temas e qualquer outro detalhe útil; diga aqui se algum campo ficou incerto).
Não preencha mediador. Não repita a mesma visita duas vezes.
avisos: lista curta, em português, do que ficou ilegível ou ambíguo.`;

  const parts: Record<string, unknown>[] = images.map((im) => ({
    inline_data: { mime_type: im.mime, data: im.data },
  }));
  parts.push({ text: prompt });

  const model = Deno.env.get("GEMINI_MODEL") || "gemini-flash-latest";
  let upstream: Response;
  try {
    upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(gemini)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                visitas: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: {
                      escola: { type: "STRING" },
                      data: { type: "STRING" },
                      hora: { type: "STRING" },
                      fim: { type: "STRING" },
                      alunos: { type: "STRING" },
                      tipo: { type: "STRING" },
                      serie: { type: "STRING" },
                      resp: { type: "STRING" },
                      contato: { type: "STRING" },
                      pcd: { type: "STRING" },
                      obs: { type: "STRING" },
                    },
                    required: ["escola", "data", "hora", "fim", "alunos", "tipo", "serie", "resp", "contato", "pcd", "obs"],
                  },
                },
                avisos: { type: "ARRAY", items: { type: "STRING" } },
              },
              required: ["visitas", "avisos"],
            },
          },
        }),
      },
    );
  } catch {
    return json({ error: "A leitura não respondeu. Tente de novo em instantes." }, 502);
  }

  const raw = await upstream.json().catch(() => null) as {
    error?: { message?: string };
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  } | null;
  if (!upstream.ok) {
    const detail = String(raw?.error?.message || "").slice(0, 180);
    return json({ error: "Não foi possível ler as imagens." + (detail ? " " + detail : "") }, 502);
  }
  const text = raw?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  let parsed: { visitas?: unknown; avisos?: unknown };
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim() || "{}");
  } catch {
    return json({ error: "A leitura não devolveu as visitas em formato utilizável. Tente uma foto mais nítida." }, 502);
  }
  const visitas = Array.isArray(parsed.visitas) ? parsed.visitas.slice(0, 40) : [];
  const avisos = Array.isArray(parsed.avisos) ? parsed.avisos.map((a) => String(a || "").slice(0, 300)).filter(Boolean).slice(0, 8) : [];
  return json({ visitas, avisos });
});
