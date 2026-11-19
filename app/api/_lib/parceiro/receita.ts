// Cópia de supabase/functions/_shared/fiscal/cnpj.ts para o lado Vercel (o app publica com Root Directory `app`, que
// não enxerga a pasta supabase/): a mesma consulta do cadastro do painel, usada por POST /v1/empresas. Ao mudar uma
// regra de CNPJ, mude as duas (o teste parceiro/receita.test.ts confere que o corpo é igual ao da edge function).
// CNPJ do cadastro (critérios 2 e 3): dígitos verificadores, consulta na BrasilAPI
// (`GET <CNPJ_API_URL>/api/cnpj/v1/<cnpj>`, padrão oficial https://brasilapi.com.br, que espelha os
// dados abertos da Receita Federal), situação cadastral ativa, regime (MEI, Simples ME/EPP, ou Lucro Presumido/Real
// declarado) e o município no padrão nacional.
// Sem Deno.*: roda também no node --test.

export const CNPJ_API_PADRAO = "https://brasilapi.com.br";
// A BrasilAPI responde 403 ao user-agent "node" e 429 sem user-agent (22/10/2026): o nosso vai sempre explícito.
export const USER_AGENT = "no-fiscal/1.0 (+https://www.notechstack.com.br)";
const TEMPO_MS = 8000;

export function soDigitos(v: unknown): string {
  return typeof v === "string" ? v.replace(/\D/g, "") : "";
}

function dv(base: string, pesos: number[]): number {
  const soma = pesos.reduce((s, p, i) => s + Number(base[i]) * p, 0);
  const r = soma % 11;
  return r < 2 ? 0 : 11 - r;
}

export function cnpjValido(cnpj: string): boolean {
  if (!/^\d{14}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false;
  const d1 = dv(cnpj, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(cnpj, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === Number(cnpj[12]) && d2 === Number(cnpj[13]);
}

export type DadosCnpj = {
  cnpj: string;
  razao_social: string;
  municipio: string;
  uf: string;
  codigo_municipio_ibge: string;
  cnae: string | null;
  regime: Regime;
};

/**
 * `opSimpNac` da DPS: mei = 2, simples (ME/EPP) = 3, presumido e real = 1 (não optante; Lucca, 19/11/2026).
 * As bases públicas só dizem "fora do Simples": Presumido ou Real é declarado por quem cadastra, e só vale em
 * município que usa o Emissor Nacional para todos os regimes (`municipioAtendido`).
 */
export type Regime = "mei" | "simples" | "presumido" | "real";
export type RegimeNormal = "presumido" | "real";
export const REGIMES_NORMAIS: readonly RegimeNormal[] = ["presumido", "real"];

export function lerRegimeNormal(v: unknown): RegimeNormal | null {
  const t = typeof v === "string" ? v.trim().toLowerCase().replace(/^lucro[\s_-]*/, "") : "";
  return t === "presumido" || t === "real" ? t : null;
}

/** Fora do Simples, a consulta devolve os dados da empresa (sem regime) para o cadastro oferecer o Presumido. */
export type DadosSemRegime = Omit<DadosCnpj, "regime">;

export type Consulta =
  | { ok: true; dados: DadosCnpj }
  | { ok: false; motivo: "nao_encontrado" | "indisponivel" }
  | { ok: false; motivo: "fora_do_simples"; dados?: DadosSemRegime }
  | { ok: false; motivo: "inativo"; situacao: string };

function texto(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

function codigo(v: unknown, tamanho: number): string | null {
  const s = typeof v === "number" ? String(Math.trunc(v)) : typeof v === "string" ? v.replace(/\D/g, "") : "";
  if (!s) return null;
  const p = s.padStart(tamanho, "0");
  return p.length === tamanho ? p : null;
}

export async function consultarCnpj(
  cnpj: string,
  o: {
    apiUrl?: string;
    reservaUrl?: string;
    fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    /** Regime confirmado à mão (nofiscal.fiscal_regime_confirmado), usado quando a base pública nega o Simples. */
    regimeConfirmado?: (cnpj: string) => Promise<Regime | null>;
    /**
     * Lucro Presumido ou Real, declarado por quem cadastra. Só vale quando a Receita diz que o CNPJ está fora do
     * Simples: se a base disser MEI ou Simples, manda a base (a Sefin recusa a DPS com o regime errado).
     */
    regimeDeclarado?: RegimeNormal | null;
  } = {},
): Promise<Consulta> {
  const r = await consultarPublico(cnpj, o);
  if (r.ok || r.motivo !== "fora_do_simples") return r;
  const confirmado = o.regimeConfirmado ? await o.regimeConfirmado(cnpj).catch(() => null) : null;
  if (confirmado === "mei" || confirmado === "simples") {
    // Os dados (razão social, município) vêm da consulta pública; só o regime vem da confirmação.
    const dados = await consultarPublico(cnpj, o, confirmado);
    if (dados.ok) return dados;
  }
  if (o.regimeDeclarado && r.dados) return { ok: true, dados: { ...r.dados, regime: o.regimeDeclarado } };
  return r;
}

async function consultarPublico(
  cnpj: string,
  o: { apiUrl?: string; reservaUrl?: string; fetch?: (url: string, init?: RequestInit) => Promise<Response> },
  regimeForcado?: Regime,
): Promise<Consulta> {
  const f = o.fetch ?? fetch;
  const base = (o.apiUrl || CNPJ_API_PADRAO).replace(/\/+$/, "");
  let resp: Response;
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TEMPO_MS);
  try {
    resp = await f(`${base}/api/cnpj/v1/${cnpj}`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: controle.signal,
    });
  } catch {
    return { ok: false, motivo: "indisponivel" };
  } finally {
    clearTimeout(relogio);
  }
  // A BrasilAPI (e a base que ela espelha) não tem todo CNPJ: em 16/11/2026 respondeu 404 para um escritório
  // ativo no Simples desde 2009 que a CNPJ.ws, a CNPJá e a ReceitaWS acharam. No 404, pergunta à reserva.
  if (resp.status === 404) return await consultarReserva(cnpj, f, o.reservaUrl, regimeForcado);
  if (!resp.ok) return { ok: false, motivo: "indisponivel" };
  const b = await resp.json().catch(() => null) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return { ok: false, motivo: "indisponivel" };
  const ibge = codigo(b.codigo_municipio_ibge, 7);
  const razao = texto(b.razao_social);
  if (!ibge || !razao) return { ok: false, motivo: "indisponivel" };
  // Só empresa ATIVA na Receita emite (pedido de Lucca, 22/10/2026). Sem o campo, a consulta não confirma nada.
  const situacao = texto(b.descricao_situacao_cadastral).toUpperCase();
  if (!situacao) return { ok: false, motivo: "indisponivel" };
  if (situacao !== "ATIVA") return { ok: false, motivo: "inativo", situacao };
  // Só MEI e Simples ME/EPP emitem (Lucca, 22/10/2026): Lucro Presumido, Real e Arbitrado ficam fora.
  // A BrasilAPI responde true (optante hoje), false (saiu) ou null (nunca optou); sem as chaves, não confirma nada.
  if (!("opcao_pelo_mei" in b) || !("opcao_pelo_simples" in b)) return { ok: false, motivo: "indisponivel" };
  const regime: Regime | null = regimeForcado ?? (b.opcao_pelo_mei === true ? "mei" : b.opcao_pelo_simples === true ? "simples" : null);
  const empresa: DadosSemRegime = {
    cnpj,
    razao_social: razao.slice(0, 150),
    municipio: texto(b.municipio),
    uf: texto(b.uf).toUpperCase(),
    codigo_municipio_ibge: ibge,
    cnae: codigo(b.cnae_fiscal, 7),
  };
  if (!regime) {
    // A base da BrasilAPI pode estar atrás da Receita no regime: em 17/11/2026 ela disse "fora do Simples" para
    // um escritório optante. Antes de recusar, pergunta à reserva; só aceita se ela confirmar MEI ou Simples.
    const segunda = await consultarReserva(cnpj, f, o.reservaUrl);
    return segunda.ok ? segunda : { ok: false, motivo: "fora_do_simples", dados: empresa };
  }
  return { ok: true, dados: { ...empresa, regime } };
}

/** Reserva: API pública da CNPJ.ws (`GET <reserva>/cnpj/<cnpj>`), usada só quando a BrasilAPI responde 404. */
export const CNPJ_API_RESERVA = "https://publica.cnpj.ws";

function simNao(v: unknown): boolean | null {
  const s = texto(v).toUpperCase();
  return s === "SIM" ? true : s === "NÃO" || s === "NAO" ? false : null;
}

async function consultarReserva(
  cnpj: string,
  f: (url: string, init?: RequestInit) => Promise<Response>,
  reservaUrl?: string,
  regimeForcado?: Regime,
): Promise<Consulta> {
  const base = (reservaUrl || CNPJ_API_RESERVA).replace(/\/+$/, "");
  let resp: Response;
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TEMPO_MS);
  try {
    resp = await f(`${base}/cnpj/${cnpj}`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: controle.signal,
    });
  } catch {
    return { ok: false, motivo: "nao_encontrado" };
  } finally {
    clearTimeout(relogio);
  }
  // A reserva fora do ar não muda a resposta original da BrasilAPI (não encontrado).
  if (!resp.ok) return { ok: false, motivo: "nao_encontrado" };
  const b = await resp.json().catch(() => null) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return { ok: false, motivo: "nao_encontrado" };
  const e = (b.estabelecimento && typeof b.estabelecimento === "object" ? b.estabelecimento : {}) as Record<string, unknown>;
  const cidade = (e.cidade && typeof e.cidade === "object" ? e.cidade : {}) as Record<string, unknown>;
  const estado = (e.estado && typeof e.estado === "object" ? e.estado : {}) as Record<string, unknown>;
  const atividade = (e.atividade_principal && typeof e.atividade_principal === "object" ? e.atividade_principal : {}) as Record<string, unknown>;
  const simples = (b.simples && typeof b.simples === "object" ? b.simples : null) as Record<string, unknown> | null;
  const ibge = codigo(cidade.ibge_id, 7);
  const razao = texto(b.razao_social);
  if (!ibge || !razao) return { ok: false, motivo: "nao_encontrado" };
  const situacao = texto(e.situacao_cadastral).toUpperCase();
  if (!situacao) return { ok: false, motivo: "indisponivel" };
  if (situacao !== "ATIVA") return { ok: false, motivo: "inativo", situacao };
  // Sem o bloco `simples`, a reserva não confirma o regime: trata como fora do Simples só se ele disser "Não".
  if (!simples && !regimeForcado) return { ok: false, motivo: "indisponivel" };
  const mei = simples ? simNao(simples.mei) : null;
  const optante = simples ? simNao(simples.simples) : null;
  if (!regimeForcado && mei === null && optante === null) return { ok: false, motivo: "indisponivel" };
  const regime: Regime | null = regimeForcado ?? (mei === true ? "mei" : optante === true ? "simples" : null);
  const empresa: DadosSemRegime = {
    cnpj,
    razao_social: razao.slice(0, 150),
    municipio: texto(cidade.nome).toUpperCase(),
    uf: texto(estado.sigla).toUpperCase(),
    codigo_municipio_ibge: ibge,
    cnae: codigo(atividade.id, 7),
  };
  if (!regime) return { ok: false, motivo: "fora_do_simples", dados: empresa };
  return { ok: true, dados: { ...empresa, regime } };
}

/** Conteúdo de municipios-padrao-nacional.json (lote P). */
export type ListaMunicipios = { fonte: string | null; consultado_em?: string; codigos_ibge: string[] } | null;

// Sem lista, ou com fonte nula, todo município vale (Unresolved 1 da tarefa).
export function padraoNacional(ibge: string, lista: ListaMunicipios): boolean {
  if (!lista || !lista.fonte || !Array.isArray(lista.codigos_ibge)) return true;
  return lista.codigos_ibge.map(String).includes(ibge);
}

/**
 * Municípios que usam o Emissor Nacional para TODOS os regimes, inclusive Lucro Presumido e Real (Lucca, 19/11/2026).
 * Lista mantida à mão, uma linha por cidade, com a norma: a Sefin não publica quem aceita não optante. A regra E0039 do
 * Anexo I (o município precisa estar parametrizado para os emissores nacionais) exceptua só o MEI e a ME/EPP com
 * regApTribSN 1; a planilha de aderentes do gov.br (coluna AderenteEmissorNacional) não separa por regime, e o
 * GET /parametros_municipais/{ibge}/convenio só responde com certificado. Para incluir uma cidade: decreto ou página
 * oficial dizendo que todo prestador emite pelo Emissor Nacional, e de preferência uma nota de Presumido autorizada lá.
 * Fora da lista ficam, por ora: São Paulo e DF (emissor próprio; só o Simples migrou), Curitiba, Belo Horizonte, Serra,
 * Vila Velha e Cariacica (a confirmar na norma da prefeitura). Método: 05-Núcleo/methods/nofiscal-virada-nt009.md.
 */
export const MUNICIPIOS_TODOS_OS_REGIMES: Readonly<Record<string, { nome: string; desde: string; fonte: string }>> = {
  "3304557": { nome: "Rio de Janeiro/RJ", desde: "2026-01-01", fonte: "Prefeitura do Rio (carioca.rio): só emissor nacional desde 01/01/2026" },
  "4314902": { nome: "Porto Alegre/RS", desde: "2025-11-01", fonte: "Prefeitura de Porto Alegre (prefeitura.poa.br): obrigatório para todos desde 01/11/2025" },
  "3205309": { nome: "Vitória/ES", desde: "2026-01-01", fonte: "Decreto municipal 25.903/2025: todo prestador emite pelo Emissor Nacional desde 01/01/2026" },
};

export function aceitaTodosOsRegimes(ibge: string): boolean {
  return Object.hasOwn(MUNICIPIOS_TODOS_OS_REGIMES, ibge);
}

/** Cidades com emissor próprio para quem não é do Simples (norma lida em 19/11/2026). */
export const MUNICIPIOS_SEM_PRESUMIDO: Readonly<Record<string, string>> = {
  "3550308": "São Paulo/SP",
  "5300108": "Brasília/DF",
};

/**
 * O que se sabe da cidade para Presumido/Real: `aceita`, `recusada` ou `null` (a conferir). A fonte principal é a tabela
 * `nofiscal.fiscal_municipios_presumido` (public.fiscal_municipio_presumido), que o worker atualiza com a Sefin: nota
 * autorizada marca aceita; recusa de convênio (E0037/E0038/E0039) marca recusada. Sem resposta do banco, valem as
 * listas acima. Cidade a conferir entra no cadastro: a primeira nota decide.
 */
export type SituacaoMunicipio = "aceita" | "recusada" | null;

export function situacaoDoMunicipio(ibge: string, doBanco?: SituacaoMunicipio | string | null): SituacaoMunicipio {
  if (doBanco === "aceita" || doBanco === "recusada") return doBanco;
  if (aceitaTodosOsRegimes(ibge)) return "aceita";
  if (Object.hasOwn(MUNICIPIOS_SEM_PRESUMIDO, ibge)) return "recusada";
  return null;
}

/** O IBGE da empresa numa consulta (também fora do Simples, quando a base devolveu os dados). */
export function ibgeDaConsulta(c: Consulta): string | null {
  if (c.ok) return c.dados.codigo_municipio_ibge;
  return c.motivo === "fora_do_simples" && c.dados ? c.dados.codigo_municipio_ibge : null;
}

// O MEI emite pelo Emissor Nacional em qualquer município: as regras E0037, E0038 e E0039 da Sefin
// (Anexo I v1.01, aba RN DPS_NFS-e) exceptuam o MEI.
// Desde a competência 01/11/2026, a Resolução CGSN 191/2026 obriga a ME/EPP do Simples a emitir
// "exclusivamente pelo Emissor Nacional (Web ou API)", "independentemente de o município possuir emissor
// próprio" (gov.br/nfse, notícia de 29/10/2026). Por isso o Simples também passa em qualquer município, e a
// lista (padraoNacional) deixou de barrar o cadastro.
// Presumido e Real: a cidade é decidida por `avaliarRegime` (aceita, recusada ou a conferir), não por esta lista.
export function municipioAtendido(d: Pick<DadosCnpj, "regime" | "codigo_municipio_ibge">, lista: ListaMunicipios): boolean {
  if (d.regime === "mei" || d.regime === "simples" || d.regime === "presumido" || d.regime === "real") return true;
  return padraoNacional(d.codigo_municipio_ibge, lista);
}

const CIDADES_TODOS_OS_REGIMES = Object.values(MUNICIPIOS_TODOS_OS_REGIMES).map((m) => m.nome.replace(/\/[A-Z]{2}$/, ""));

export const MSG_FORA_DO_SIMPLES_SEM_DADOS =
  "O nó.fiscal atende MEI, Simples Nacional e, em algumas cidades, Lucro Presumido e Real. Não conseguimos confirmar o regime deste CNPJ na Receita Federal";
export const MSG_DECLARAR_REGIME =
  "Este CNPJ não está no Simples Nacional. Escolha o regime da empresa: Lucro Presumido ou Lucro Real";
export const MSG_MUNICIPIO_A_CONFERIR =
  "Ainda não emitimos Lucro Presumido nesta cidade: a primeira nota confirma se a prefeitura aceita esse regime no Emissor Nacional. Se a Sefin recusar, avisamos na hora e a empresa vai para a lista de espera";

export function msgPresumidoForaDaCidade(municipio: string, uf: string): string {
  const cidade = [municipio, uf].filter(Boolean).join("/") || "Esta cidade";
  return `Para Lucro Presumido e Real, o nó.fiscal emite só onde a prefeitura usa o Emissor Nacional para todas as empresas ` +
    `(por exemplo, ${CIDADES_TODOS_OS_REGIMES.join(", ")}). ${cidade} ainda emite esses regimes pelo sistema próprio. ` +
    `Fale com a nó pelo WhatsApp para entrar na lista de espera`;
}

export type AvaliacaoDoRegime =
  | { codigo: "REGIME_A_DECLARAR"; mensagem: string; dados: DadosSemRegime; a_conferir: boolean }
  | { codigo: "CNPJ_FORA_DO_SIMPLES"; mensagem: string; lista_espera: true }
  | { codigo: "CNPJ_FORA_DO_SIMPLES"; mensagem: string };

/**
 * O que fazer com um CNPJ fora do Simples (cadastro, Minhas empresas e API do parceiro), ou `null` para seguir.
 * `situacao` é a da cidade (`situacaoDoMunicipio`, com o que o banco sabe):
 * - cidade recusada: recusa com a lista de espera, declarado ou não;
 * - Presumido ou Real declarado em cidade aceita ou a conferir: segue;
 * - fora do Simples sem regime declarado: pedir Presumido ou Real (`a_conferir` quando ninguém emitiu lá ainda);
 * - sem os dados da empresa (a base não respondeu o regime): a recusa de sempre.
 */
export function avaliarRegime(c: Consulta, situacao?: SituacaoMunicipio | string | null): AvaliacaoDoRegime | null {
  const ibge = ibgeDaConsulta(c);
  const sit = ibge ? situacaoDoMunicipio(ibge, situacao) : null;
  if (c.ok) {
    if ((c.dados.regime === "presumido" || c.dados.regime === "real") && sit === "recusada") {
      return { codigo: "CNPJ_FORA_DO_SIMPLES", mensagem: msgPresumidoForaDaCidade(c.dados.municipio, c.dados.uf), lista_espera: true };
    }
    return null;
  }
  if (c.motivo !== "fora_do_simples") return null;
  if (!c.dados) return { codigo: "CNPJ_FORA_DO_SIMPLES", mensagem: MSG_FORA_DO_SIMPLES_SEM_DADOS };
  if (sit === "recusada") {
    return { codigo: "CNPJ_FORA_DO_SIMPLES", mensagem: msgPresumidoForaDaCidade(c.dados.municipio, c.dados.uf), lista_espera: true };
  }
  const aConferir = sit !== "aceita";
  return {
    codigo: "REGIME_A_DECLARAR",
    mensagem: aConferir ? `${MSG_DECLARAR_REGIME}. ${MSG_MUNICIPIO_A_CONFERIR}` : MSG_DECLARAR_REGIME,
    dados: c.dados,
    a_conferir: aConferir,
  };
}

export function lerListaMunicipios(conteudo: string | null): ListaMunicipios {
  if (!conteudo) return null;
  try {
    const j = JSON.parse(conteudo) as Record<string, unknown>;
    if (!j || typeof j !== "object" || !Array.isArray(j.codigos_ibge)) return null;
    return { fonte: typeof j.fonte === "string" && j.fonte ? j.fonte : null, codigos_ibge: j.codigos_ibge.map(String) };
  } catch {
    return null;
  }
}
