// api/ai.js
// Handler serverless para Vercel – versão simples, focada em orçamento
// Depende de: openai, @anthropic-ai/sdk, pdf-parse

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import pdfParse from "pdf-parse";

// --- Clients (criam só se tiver key) ---
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// --- Util: CORS básico ---
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// --- Escolha simples de modelo (AUTO + preferência do front) ---
function escolherModelos(formData, preferido, fallbackPreferido) {
  const pref = (preferido || "auto").toLowerCase();
  const fall = Array.isArray(fallbackPreferido) ? fallbackPreferido : ["gpt-4o"];

  if (pref !== "auto") {
    return { modelo: preferido, fallback: fall };
  }

  const temArquivo = !!(formData?.pdfBase64 || formData?.imagemBase64 || formData?.arquivoBase64);
  const temClaude = !!process.env.ANTHROPIC_API_KEY;

  if (temArquivo) {
    if (temClaude) return { modelo: "claude-3-5-sonnet-20240620", fallback: ["gpt-4o"] };
    return { modelo: "gpt-4o", fallback: ["gpt-4o-mini"] };
  }
  return { modelo: "gpt-4o-mini", fallback: ["gpt-4o"] };
}

// --- PDF: extrai texto do base64 ---
async function extrairTextoPDF(pdfBase64) {
  const buf = Buffer.from(pdfBase64, "base64");
  const out = await pdfParse(buf);
  return out.text || "";
}

// --- Prompt simples (o HTML pode anexar INSTRUÇÕES DE FORMATAÇÃO nas observações) ---
function montarPrompt(formData) {
  const {
    observacoes = "",
    textoColado = "",
    destino = "",
    adultos = "2",
    criancas = "0",
    tipos = [],
  } = formData || {};

  const cabecalho = `Você é um assistente da CVC. Gere um *Orçamento Principal* pronto para WhatsApp, claro, objetivo e padronizado.`;
  const regras = `Se houver a seção "[INSTRUÇÕES DE FORMATAÇÃO]", siga-a à risca.
- Não invente preços; foque em estrutura/roteiro/organização de dados.
- Use títulos curtos, bullets e blocos claros.
- Personalize com destino, quantidade de passageiros e serviços marcados.`;

  const contexto = [
    destino && `Destino: ${destino}`,
    `Passageiros: ${adultos} adulto(s) e ${criancas} criança(s)`,
    tipos?.length ? `Serviços: ${tipos.join(", ")}` : "",
    observacoes && `Observações:\n${observacoes}`,
    textoColado && `Texto adicional:\n${textoColado}`,
  ].filter(Boolean).join("\n\n");

  const saída = `Entregue apenas o texto final do orçamento (sem explicações).`;

  return `${cabecalho}\n\n${regras}\n\n${contexto}\n\n${saída}`;
}

// --- Chamada OpenAI (texto/imagem) ---
async function chamarOpenAI({ prompt, imagemBase64, modelo }) {
  if (!openai) throw new Error("OPENAI_API_KEY ausente");

  const hasImage = !!imagemBase64;
  const content = hasImage
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/png;base64,${imagemBase64}` } },
      ]
    : [{ type: "text", text: prompt }];

  const resp = await openai.chat.completions.create({
    model: modelo || "gpt-4o-mini",
    messages: [{ role: "user", content }],
    temperature: 0.3,
  });

  return resp.choices?.[0]?.message?.content?.trim() || "";
}

// --- Chamada Claude (texto/imagem) ---
async function chamarClaude({ prompt, imagemBase64, modelo }) {
  if (!anthropic) throw new Error("ANTHROPIC_API_KEY ausente");

  const content = [];
  if (imagemBase64) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: imagemBase64 },
    });
  }
  content.push({ type: "text", text: prompt });

  const resp = await anthropic.messages.create({
    model: modelo || "claude-3-5-sonnet-20240620",
    max_tokens: 2000,
    temperature: 0.3,
    messages: [{ role: "user", content }],
  });

  return resp?.content?.[0]?.text?.trim() || "";
}

// --- Função que tenta com modelo escolhido e cai para fallback se der erro ---
async function gerarRespostaLLM({ prompt, imagemBase64, modelo, fallback }) {
  const tentativas = [modelo, ...(fallback || [])];

  for (const m of tentativas) {
    const mLower = (m || "").toLowerCase();
    try {
      if (mLower.startsWith("claude")) {
        return await chamarClaude({ prompt, imagemBase64, modelo: m });
      }
      // default: openai
      return await chamarOpenAI({ prompt, imagemBase64, modelo: m });
    } catch (e) {
      console.warn(`Falha com modelo ${m}:`, e.message);
      continue;
    }
  }
  throw new Error("Falha ao gerar resposta nos modelos informados.");
}

// --- Handler principal ---
export default async function handler(req, res) {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body || {};
    const formData = body.formData || body;
    const tipo = body.tipo || "orcamento";
    const preferenciaReq = { modelo: body.modelo || "auto", fallback: body.fallback || ["gpt-4o"] };

    // Se vier PDF, extrai o texto e injeta nas observações
    if (tipo === "pdf" && formData?.pdfBase64) {
      const textoPDF = await extrairTextoPDF(formData.pdfBase64);
      formData.observacoes = `${formData.observacoes || ""}\n\n[EXTRAÍDO DO PDF]\n${textoPDF}`.trim();
    }

    // Seleção de modelo (AUTO + preferência do front)
    const { modelo, fallback } = escolherModelos(formData, preferenciaReq.modelo, preferenciaReq.fallback);

    // Monta prompt com observações + dados + instruções
    const prompt = montarPrompt(formData);

    // Chama LLM
    const texto = await gerarRespostaLLM({
      prompt,
      imagemBase64: formData?.imagemBase64 || null,
      modelo,
      fallback,
    });

    return res.status(200).json({ success: true, result: texto, modeloUsado: modelo });
  } catch (err) {
    console.error("Erro API:", err);
    return res.status(500).json({ success: false, error: err.message || "Erro interno" });
  }
}
