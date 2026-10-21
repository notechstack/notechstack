// E-mails do auditor: relatório (resumo + 3 prioridades + botão) e avisos (reconexão, expiração).
// Montagem pura; o envio recebe o fetch por parâmetro (testável). Nenhuma métrica além do resumo.

import type { Narrativa } from "./redacao.ts";
import type { ResultadoRegras } from "./regras.ts";

export const REMETENTE_RELATORIOS = "nó.agentes <relatorios@notechstack.com.br>";

export type Email = { assunto: string; texto: string; html: string };

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const TITULO_TIPO = { retrospectiva: "Sua retrospectiva", semanal: "Relatório semanal", mensal: "Relatório mensal" } as const;

function desconectadas(r: ResultadoRegras): string[] {
  const nomes: Record<string, string> = { meta_ads: "Facebook", google_ads: "Google", ga4: "Google", gsc: "Google" };
  const s = new Set<string>();
  for (const [f, e] of Object.entries(r.fontes)) if ((e === "expirado" || e === "revogado") && nomes[f]) s.add(nomes[f]);
  return [...s];
}

export function emailRelatorio(o: {
  tipo: keyof typeof TITULO_TIPO;
  negocio: string;
  resultado: ResultadoRegras;
  narrativa: Narrativa;
  urlRelatorio: string;
  urlConexoes: string;
}): Email {
  const titulo = `${TITULO_TIPO[o.tipo]} · ${o.negocio} · ${o.resultado.periodo.rotulo}`;
  const reconectar = desconectadas(o.resultado);
  const linhasTexto = [
    titulo, "", o.narrativa.resumo, "",
    ...(o.narrativa.prioridades.length ? ["Prioridades:", ...o.narrativa.prioridades.map((p, i) => `${i + 1}. ${p.titulo} — ${p.o_que_fazer}`), ""] : []),
    ...(reconectar.length ? [`Reconecte o ${reconectar.join(" e o ")} para o próximo relatório vir completo: ${o.urlConexoes}`, ""] : []),
    `Ver relatório completo: ${o.urlRelatorio}`,
    "", "Você recebe este e-mail porque assinou o auditor da nó.agentes. Para cancelar ou excluir seus dados, acesse o seu painel.",
  ];
  const html = `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;color:#141414;max-width:560px;margin:0 auto;padding:24px">
<p style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#6b6b6b">${esc(TITULO_TIPO[o.tipo])} · ${esc(o.resultado.periodo.rotulo)}</p>
<h1 style="font-size:20px;margin:0 0 12px">${esc(o.negocio)}</h1>
<p style="font-size:15px;line-height:1.5">${esc(o.narrativa.resumo)}</p>
${o.narrativa.prioridades.length ? `<h2 style="font-size:16px;margin-top:24px">Prioridades</h2><ol style="padding-left:20px">${o.narrativa.prioridades.map((p) => `<li style="margin-bottom:10px"><strong>${esc(p.titulo)}</strong><br>${esc(p.o_que_fazer)}</li>`).join("")}</ol>` : ""}
${reconectar.length ? `<p style="background:#fff4d6;padding:12px;border-radius:8px">Reconecte o ${esc(reconectar.join(" e o "))} para o próximo relatório vir completo. <a href="${esc(o.urlConexoes)}">Reconectar</a></p>` : ""}
<p style="margin:28px 0"><a href="${esc(o.urlRelatorio)}" style="background:#141414;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:bold">Ver relatório completo</a></p>
<p style="font-size:12px;color:#6b6b6b">Você recebe este e-mail porque assinou o auditor da nó.agentes. Para cancelar ou excluir seus dados, acesse o seu painel.</p>
</body></html>`;
  return { assunto: titulo, texto: linhasTexto.join("\n"), html };
}

export type TipoAviso = "expira_7d" | "expira_1d" | "gratis_tokens_apagados" | "sem_fonte_30d";

export function emailAviso(o: { tipo: TipoAviso; negocio: string; provedor: "meta" | "google" | null; urlConexoes: string }): Email {
  const plataforma = o.provedor === "google" ? "Google" : "Facebook";
  const textos: Record<TipoAviso, [string, string]> = {
    expira_7d: [`A conexão com o ${plataforma} expira em 7 dias`, `Para os relatórios de ${o.negocio} continuarem completos, reconecte o ${plataforma}. Leva um clique.`],
    expira_1d: [`A conexão com o ${plataforma} expira amanhã`, `Reconecte o ${plataforma} hoje para o próximo relatório de ${o.negocio} não sair incompleto.`],
    gratis_tokens_apagados: [`Desconectamos o ${plataforma} de ${o.negocio}`, `Como não houve assinatura em 30 dias, apagamos o acesso ao ${plataforma}, como diz nossa Política de Privacidade. Se assinar, é só conectar de novo.`],
    sem_fonte_30d: [`Há 30 dias sem contas conectadas em ${o.negocio}`, `Seus relatórios estão saindo só com a verificação do site. Reconecte suas contas ou fale com a gente se quiser ajuda ou cancelar.`],
  };
  const [assunto, corpo] = textos[o.tipo];
  return {
    assunto,
    texto: `${corpo}\n\n${o.urlConexoes}`,
    html: `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;color:#141414;max-width:560px;margin:0 auto;padding:24px"><h1 style="font-size:18px">${esc(assunto)}</h1><p style="font-size:15px;line-height:1.5">${esc(corpo)}</p><p><a href="${esc(o.urlConexoes)}" style="background:#141414;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:bold">Abrir meu painel</a></p></body></html>`,
  };
}

// Envio pelo Resend. Devolve o id do e-mail; erro sem detalhe do destinatário.
export async function enviarResend(o: { apiKey: string; para: string; email: Email; fetch?: typeof fetch; remetente?: string }): Promise<string> {
  const f = o.fetch ?? fetch;
  const resp = await f("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: o.remetente ?? REMETENTE_RELATORIOS, to: [o.para], subject: o.email.assunto, text: o.email.texto, html: o.email.html }),
  });
  const corpo = await resp.json().catch(() => ({})) as { id?: string };
  if (!resp.ok || !corpo.id) throw new Error(resp.status >= 500 || resp.status === 429 ? "resend_transitorio" : "resend_recusou");
  return corpo.id;
}

export function emailLinkAcesso(link: string): Email {
  const assunto = "Seu link de acesso ao auditor da nó.agentes";
  const corpo = "Use o botão abaixo para entrar. O link vale por pouco tempo e só funciona uma vez. Se não foi você que pediu, ignore este e-mail.";
  return {
    assunto,
    texto: `${corpo}\n\n${link}`,
    html: `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;color:#141414;max-width:560px;margin:0 auto;padding:24px"><h1 style="font-size:18px">${esc(assunto)}</h1><p style="font-size:15px;line-height:1.5">${esc(corpo)}</p><p><a href="${esc(link)}" style="background:#141414;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:bold">Entrar no auditor</a></p></body></html>`,
  };
}
