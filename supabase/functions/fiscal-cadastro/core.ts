// fiscal-cadastro: consulta do CNPJ e criação da empresa self-service (critérios 2, 3, 6 e 8;
// Landing "fiscal-cadastro: forma", lote A). Público (verify_jwt = false); `criar` confere a sessão.
// Núcleo testável: sem Deno e sem supabase-js. O banco só é alcançado por public.fiscal_cadastro_criar.

import { corsFiscal, json } from "../_shared/fiscal/cors.ts";
import { cnpjValido, type Consulta, consultarCnpj, type ListaMunicipios, municipioAtendido, type Regime, soDigitos } from "../_shared/fiscal/cnpj.ts";
import { comNonoDigito, normalizarTelefone } from "../assinatura-fiscal/teste-gratis.ts";

export type ArgsCriar = {
  user_id: string;
  cnpj: string;
  razao_social: string;
  codigo_municipio_ibge: string;
  cnae: string | null;
  regime: Regime;
  telefone: string;
  plano: "inicial" | "pro";
  responsavel: string;
  api_key_hash: string;
  ambiente: "producao_restrita" | "producao";
};

export type RespostaCriar = { status: string; tenant_id?: string; etapa?: string };

export type CadastroDeps = {
  env: (k: string) => string | undefined;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Usuário da sessão Supabase (Authorization: Bearer), ou null. */
  sessao: (req: Request) => Promise<string | null>;
  municipios: () => Promise<ListaMunicipios>;
  criar: (args: ArgsCriar) => Promise<RespostaCriar>;
  /** 32 bytes aleatórios; o sha256 deles vira api_key_hash e eles são descartados. */
  bytesAleatorios?: () => Uint8Array<ArrayBuffer>;
  log?: (evento: string, detalhe?: Record<string, unknown>) => void;
};

type H = Record<string, string>;

function erro(status: number, error_code: string, mensagem: string, h: H): Response {
  return json(status, { ok: false, error_code, mensagem }, h);
}

const MSG_CNPJ_INVALIDO = "CNPJ inválido. Confira os 14 números.";
const MSG_NAO_ENCONTRADO = "Não encontramos este CNPJ na Receita Federal.";
const MSG_INDISPONIVEL = "Não conseguimos confirmar o CNPJ na Receita Federal agora. Tente de novo em alguns minutos.";
const MSG_FORA_DO_PADRAO =
  "Seu município ainda não emite pelo padrão nacional. Para empresas do Simples, só atendemos cidades que já usam o Emissor Nacional";
const MSG_FORA_DO_SIMPLES =
  "O nó.fiscal atende MEI e empresas do Simples Nacional. Na Receita Federal, este CNPJ não está no Simples";

// Nenhum caminho cria empresa sem a Receita confirmar o CNPJ: fora do ar também bloqueia (Lucca, 22/10/2026).
function respostaConsulta(c: Consulta, h: H): Response | null {
  if (c.ok) return null;
  if (c.motivo === "nao_encontrado") return erro(404, "CNPJ_NAO_ENCONTRADO", MSG_NAO_ENCONTRADO, h);
  if (c.motivo === "inativo") {
    const situacao = c.situacao.toLowerCase();
    return erro(422, "CNPJ_INATIVO", `Este CNPJ está com situação ${situacao} na Receita Federal. Só empresas ativas podem emitir notas.`, h);
  }
  if (c.motivo === "fora_do_simples") return erro(422, "CNPJ_FORA_DO_SIMPLES", MSG_FORA_DO_SIMPLES, h);
  return erro(503, "CONSULTA_INDISPONIVEL", MSG_INDISPONIVEL, h);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function texto(v: unknown, min: number, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.normalize("NFC").replace(/\s+/g, " ").trim();
  return t.length >= min && t.length <= max ? t : null;
}

export async function handle(req: Request, deps: CadastroDeps): Promise<Response> {
  const log = deps.log ?? (() => {});
  const h = corsFiscal(req.headers.get("origin"), deps.env);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return erro(405, "METHOD_NOT_ALLOWED", "Método não permitido.", h);

  const bruto = await req.text();
  if (bruto.length > 8192) return erro(400, "DADOS_INVALIDOS", "Pedido grande demais.", h);
  let b: Record<string, unknown>;
  try {
    const p = JSON.parse(bruto);
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error();
    b = p;
  } catch {
    return erro(400, "DADOS_INVALIDOS", "Não recebemos os dados. Recarregue a página e tente de novo.", h);
  }

  const consultar = (cnpj: string) =>
    consultarCnpj(cnpj, { apiUrl: deps.env("CNPJ_API_URL"), fetch: deps.fetch });

  if (b.acao === "consultar_cnpj") {
    const cnpj = soDigitos(b.cnpj);
    if (!cnpjValido(cnpj)) return erro(422, "CNPJ_INVALIDO", MSG_CNPJ_INVALIDO, h);
    const c = await consultar(cnpj);
    const r = respostaConsulta(c, h);
    if (r || !c.ok) {
      if (!c.ok) log("fiscal_cadastro_consulta", { motivo: c.motivo });
      return r!;
    }
    return json(200, { ok: true, ...c.dados, padrao_nacional: municipioAtendido(c.dados, await deps.municipios()) }, h);
  }

  if (b.acao !== "criar") return erro(400, "ACAO_INVALIDA", "Ação desconhecida.", h);

  const userId = await deps.sessao(req);
  if (!userId) return erro(401, "SEM_SESSAO", "Sua sessão expirou. Peça um código novo.", h);

  const cnpj = soDigitos(b.cnpj);
  if (!cnpjValido(cnpj)) return erro(422, "CNPJ_INVALIDO", MSG_CNPJ_INVALIDO, h);
  const razaoDigitada = texto(b.razao_social, 1, 150);
  const responsavel = texto(b.responsavel, 2, 120);
  // Guardado com o nono dígito: é a forma que o WhatsApp do dono vai casar depois (comNonoDigito).
  const telefoneBruto = typeof b.telefone === "string" ? normalizarTelefone(b.telefone) : null;
  const telefone = telefoneBruto ? comNonoDigito(telefoneBruto) : null;
  if (!razaoDigitada) return erro(422, "DADOS_INVALIDOS", "Informe o nome da empresa.", h);
  if (!responsavel) return erro(422, "DADOS_INVALIDOS", "Informe o nome do responsável.", h);
  if (!telefone || !telefone.startsWith("+55")) return erro(422, "DADOS_INVALIDOS", "Informe um WhatsApp do Brasil com DDD.", h);
  const plano = b.plano === "pro" ? "pro" : "inicial";

  // Município, IBGE, CNAE e regime vêm sempre da consulta, nunca do corpo (critério 3).
  const c = await consultar(cnpj);
  const r = respostaConsulta(c, h);
  if (r || !c.ok) return r!;
  if (!municipioAtendido(c.dados, await deps.municipios())) {
    return erro(422, "MUNICIPIO_FORA_DO_PADRAO", MSG_FORA_DO_PADRAO, h);
  }

  const bytes = deps.bytesAleatorios ? deps.bytesAleatorios() : crypto.getRandomValues(new Uint8Array(32));
  const ambiente = deps.env("FISCAL_AMBIENTE_PADRAO") === "producao" ? "producao" : "producao_restrita";

  let res: RespostaCriar;
  try {
    res = await deps.criar({
      user_id: userId,
      cnpj,
      razao_social: c.dados.razao_social,
      codigo_municipio_ibge: c.dados.codigo_municipio_ibge,
      cnae: c.dados.cnae,
      regime: c.dados.regime,
      telefone,
      plano,
      responsavel,
      api_key_hash: await sha256Hex(bytes),
      ambiente,
    });
  } catch {
    log("fiscal_cadastro_banco_falhou");
    return erro(503, "INDISPONIVEL", "Não conseguimos criar o cadastro agora. Tente de novo em alguns minutos.", h);
  } finally {
    bytes.fill(0);
  }

  switch (res.status) {
    case "criado":
    case "existente":
      log("fiscal_cadastro_criado", { status: res.status, plano, regime: c.dados.regime });
      // novo: a conta nasceu agora (o site mede o cadastro concluído só uma vez).
      return json(201, { ok: true, tenant_id: res.tenant_id, etapa: res.etapa, novo: res.status === "criado" }, h);
    case "cnpj_ja_cadastrado":
      return erro(409, "CNPJ_JA_CADASTRADO", "Este CNPJ já tem conta. Entre pela sua conta", h);
    case "telefone_de_outra_empresa":
      return erro(409, "TELEFONE_DE_OUTRA_EMPRESA", "Este WhatsApp já está ligado a outra empresa", h);
    case "conta_ja_tem_empresa":
      return erro(409, "CONTA_JA_TEM_EMPRESA", "Este e-mail já tem outra empresa. Entre pela sua conta", h);
    case "sem_email_confirmado":
      return erro(401, "SEM_SESSAO", "Confirme o e-mail com o código antes de continuar.", h);
    default:
      log("fiscal_cadastro_status_desconhecido");
      return erro(503, "INDISPONIVEL", "Não conseguimos criar o cadastro agora. Tente de novo em alguns minutos.", h);
  }
}
