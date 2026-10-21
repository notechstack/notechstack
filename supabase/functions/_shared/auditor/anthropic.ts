// Gerador real da redação (só no runtime Deno das Edge Functions; os testes usam um gerador falso).
// Modelo e parâmetros: spec 2026-10-21, seção 4 (D5): Claude Opus 5.5, effort low, saída estruturada,
// fallbacks "default" para recusas. Sem ANTHROPIC_API_KEY, quem chama passa `null` e sai o texto de modelo.

import Anthropic from "npm:@anthropic-ai/sdk@0.137.0";
import type { GeradorIa } from "./redacao.ts";

export const MODELO_REDACAO = "claude-opus-5-5";

export function criarGeradorAnthropic(apiKey: string | undefined): GeradorIa | null {
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 });
  return async ({ system, prompt, schema }) => {
    // `fallbacks: "default"` e o beta ainda podem não estar nos tipos do SDK; o corpo vai como está.
    const resposta = await client.beta.messages.create({
      model: MODELO_REDACAO,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema } },
      system,
      messages: [{ role: "user", content: prompt }],
    } as unknown as Parameters<typeof client.beta.messages.create>[0]) as unknown as {
      model: string;
      stop_reason: string | null;
      content: { type: string; text?: string }[];
      usage: { input_tokens: number; output_tokens: number };
    };
    if (resposta.stop_reason === "refusal") throw new Error("recusa_ia");
    if (resposta.stop_reason === "max_tokens") throw new Error("ia_truncada");
    const texto = resposta.content.find((b) => b.type === "text")?.text;
    if (!texto) throw new Error("ia_sem_texto");
    let json: unknown;
    try {
      json = JSON.parse(texto);
    } catch {
      throw new Error("ia_json_invalido");
    }
    return {
      json,
      uso: { modelo: resposta.model, tokens_entrada: resposta.usage.input_tokens, tokens_saida: resposta.usage.output_tokens },
    };
  };
}
