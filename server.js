import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import bodyParser from "body-parser";

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// Função para decidir qual modelo usar
function escolherModelo(formData) {
  const camposTexto =
    (formData.observacoes || "").length +
    (formData.dadosViagem || "").length;

  // Se for apenas texto simples, usa OpenAI mini
  if (!formData.pdf && !formData.imagem && camposTexto < 300) {
    return { tipo: "openai", modelo: "gpt-4o-mini" };
  }

  // Caso contrário, usa Claude
  return { tipo: "anthropic", modelo: "claude-3-sonnet-20240229" };
}

app.post("/api/ai", async (req, res) => {
  try {
    const { formData } = req.body;
    const { tipo, modelo } = escolherModelo(formData);

    const prompt = `
Você é uma atendente da CVC. Formate um orçamento para WhatsApp
seguindo o modelo descrito no link abaixo:
https://docs.google.com/document/d/1J6luZmr0Q_ldqsmEJ4kuMEfA7BYt3DInd7-
Dados recebidos: ${JSON.stringify(formData, null, 2)}
`;

    let respostaTexto = "";

    if (tipo === "openai") {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: modelo,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await r.json();
      respostaTexto = data.choices?.[0]?.message?.content || "";
    } else {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: modelo,
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await r.json();
      respostaTexto = data.content?.[0]?.text || "";
    }

    res.json({ resposta: respostaTexto });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro ao processar IA" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
