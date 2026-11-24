// CNPJ do cadastro (critérios 2 e 3): dígitos verificadores, consulta na BrasilAPI
// (`GET <CNPJ_API_URL>/api/cnpj/v1/<cnpj>`, padrão oficial https://brasilapi.com.br, que espelha os
// dados abertos da Receita Federal), situação cadastral ativa, regime (MEI ou Simples ME/EPP) e o
// município no padrão nacional.
// Sem Deno.*: roda também no node --test.

export const CNPJ_API_PADRAO = "https://brasilapi.com.br";
// A BrasilAPI responde 403 ao user-agent "node" e 429 sem user-agent (22/10/2026): o nosso vai sempre explícito.
export const USER_AGENT = "no-fiscal/1.0 (+https://www.notechstack.com.br)";
// Espelho: `GET <CNPJ_API_ESPELHO_URL>/<cnpj>`, mesmos campos da BrasilAPI (conferido em 24/11/2026).
export const CNPJ_API_ESPELHO = "https://minhareceita.org";
// Por fonte. Com o espelho, o pior caso fica em ~14 s, dentro do limite da edge function.
const TEMPO_MS = 7000;

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

/** `opSimpNac` da DPS: mei = 2, simples (ME/EPP) = 3. Quem não é do Simples não é atendido. */
export type Regime = "mei" | "simples";

/** O que cada fonte respondeu quando a consulta não confirmou nada (vai para a log, sem dado do CNPJ). */
export type Tentativa = { fonte: "principal" | "espelho"; status?: number; erro?: "tempo" | "rede" | "corpo"; ms: number };

export type Consulta =
  | { ok: true; dados: DadosCnpj }
  | { ok: false; motivo: "nao_encontrado" | "fora_do_simples" }
  | { ok: false; motivo: "indisponivel"; tentativas?: Tentativa[] }
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
    /** Espelho da BrasilAPI para quando ela falha; `null` desliga. */
    espelhoUrl?: string | null;
    fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    /** Regime confirmado à mão (nofiscal.fiscal_regime_confirmado), usado quando a base pública nega o Simples. */
    regimeConfirmado?: (cnpj: string) => Promise<Regime | null>;
  } = {},
): Promise<Consulta> {
  const r = await consultarPublico(cnpj, o);
  if (r.ok || r.motivo !== "fora_do_simples" || !o.regimeConfirmado) return r;
  const regime = await o.regimeConfirmado(cnpj).catch(() => null);
  if (regime !== "mei" && regime !== "simples") return r;
  // Os dados (razão social, município) vêm da consulta pública; só o regime vem da confirmação.
  const dados = await consultarPublico(cnpj, o, regime);
  return dados.ok ? dados : r;
}

/** Corpo da BrasilAPI ou do espelho com tudo o que a consulta precisa; sem um campo, ela não confirma nada. */
function completo(b: Record<string, unknown> | null): b is Record<string, unknown> {
  return !!b && typeof b === "object" && !!codigo(b.codigo_municipio_ibge, 7) && !!texto(b.razao_social) &&
    !!texto(b.descricao_situacao_cadastral) && "opcao_pelo_mei" in b && "opcao_pelo_simples" in b;
}

async function consultarPublico(
  cnpj: string,
  o: { apiUrl?: string; reservaUrl?: string; espelhoUrl?: string | null; fetch?: (url: string, init?: RequestInit) => Promise<Response> },
  regimeForcado?: Regime,
): Promise<Consulta> {
  const f = o.fetch ?? fetch;
  const base = (o.apiUrl || CNPJ_API_PADRAO).replace(/\/+$/, "");
  // Em 23/11/2026 a BrasilAPI falhou por ~30 min e nenhum escritório conseguiu adicionar empresa. Se ela cai,
  // demora, dá erro ou responde incompleto, pergunta ao espelho (minhareceita.org: mesma base e mesmos campos,
  // é de onde a BrasilAPI tira o CNPJ). Só depois das duas a consulta fica indisponível.
  const fontes: { fonte: Tentativa["fonte"]; url: string }[] = [{ fonte: "principal", url: `${base}/api/cnpj/v1/${cnpj}` }];
  if (o.espelhoUrl !== null) {
    fontes.push({ fonte: "espelho", url: `${(o.espelhoUrl || CNPJ_API_ESPELHO).replace(/\/+$/, "")}/${cnpj}` });
  }
  const tentativas: Tentativa[] = [];
  let b: Record<string, unknown> | null = null;
  for (const { fonte, url } of fontes) {
    const inicio = Date.now();
    const controle = new AbortController();
    const relogio = setTimeout(() => controle.abort(), TEMPO_MS);
    let resp: Response;
    try {
      resp = await f(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: controle.signal });
    } catch {
      tentativas.push({ fonte, erro: controle.signal.aborted ? "tempo" : "rede", ms: Date.now() - inicio });
      continue;
    } finally {
      clearTimeout(relogio);
    }
    // A BrasilAPI (e a base que ela espelha) não tem todo CNPJ: em 16/11/2026 respondeu 404 para um escritório
    // ativo no Simples desde 2009 que a CNPJ.ws, a CNPJá e a ReceitaWS acharam. No 404, pergunta à reserva.
    if (resp.status === 404) return await consultarReserva(cnpj, f, o.reservaUrl, regimeForcado);
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      tentativas.push({ fonte, status: resp.status, ms: Date.now() - inicio });
      continue;
    }
    const corpo = await resp.json().catch(() => null) as Record<string, unknown> | null;
    if (completo(corpo)) {
      b = corpo;
      break;
    }
    tentativas.push({ fonte, status: resp.status, erro: "corpo", ms: Date.now() - inicio });
  }
  if (!b) return { ok: false, motivo: "indisponivel", tentativas };
  const ibge = codigo(b.codigo_municipio_ibge, 7)!;
  const razao = texto(b.razao_social);
  // Só empresa ATIVA na Receita emite (pedido de Lucca, 22/10/2026).
  const situacao = texto(b.descricao_situacao_cadastral).toUpperCase();
  if (situacao !== "ATIVA") return { ok: false, motivo: "inativo", situacao };
  // Só MEI e Simples ME/EPP emitem (Lucca, 22/10/2026): Lucro Presumido, Real e Arbitrado ficam fora.
  // A BrasilAPI responde true (optante hoje), false (saiu) ou null (nunca optou).
  const regime: Regime | null = regimeForcado ?? (b.opcao_pelo_mei === true ? "mei" : b.opcao_pelo_simples === true ? "simples" : null);
  if (!regime) {
    // A base da BrasilAPI pode estar atrás da Receita no regime: em 17/11/2026 ela disse "fora do Simples" para
    // um escritório optante. Antes de recusar, pergunta à reserva; só aceita se ela confirmar MEI ou Simples.
    const segunda = await consultarReserva(cnpj, f, o.reservaUrl);
    return segunda.ok ? segunda : { ok: false, motivo: "fora_do_simples" };
  }
  return {
    ok: true,
    dados: {
      cnpj,
      razao_social: razao.slice(0, 150),
      municipio: texto(b.municipio),
      uf: texto(b.uf).toUpperCase(),
      codigo_municipio_ibge: ibge,
      cnae: codigo(b.cnae_fiscal, 7),
      regime,
    },
  };
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
  if (!regime) return { ok: false, motivo: "fora_do_simples" };
  return {
    ok: true,
    dados: {
      cnpj,
      razao_social: razao.slice(0, 150),
      municipio: texto(cidade.nome).toUpperCase(),
      uf: texto(estado.sigla).toUpperCase(),
      codigo_municipio_ibge: ibge,
      cnae: codigo(atividade.id, 7),
      regime,
    },
  };
}

/** Conteúdo de municipios-padrao-nacional.json (lote P). */
export type ListaMunicipios = { fonte: string | null; consultado_em?: string; codigos_ibge: string[] } | null;

// Sem lista, ou com fonte nula, todo município vale (Unresolved 1 da tarefa).
export function padraoNacional(ibge: string, lista: ListaMunicipios): boolean {
  if (!lista || !lista.fonte || !Array.isArray(lista.codigos_ibge)) return true;
  return lista.codigos_ibge.map(String).includes(ibge);
}

// O MEI emite pelo Emissor Nacional em qualquer município: as regras E0037, E0038 e E0039 da Sefin
// (Anexo I v1.01, aba RN DPS_NFS-e) exceptuam o MEI.
// Desde a competência 01/11/2026, a Resolução CGSN 191/2026 obriga a ME/EPP do Simples a emitir
// "exclusivamente pelo Emissor Nacional (Web ou API)", "independentemente de o município possuir emissor
// próprio" (gov.br/nfse, notícia de 29/10/2026). Por isso o Simples também passa em qualquer município, e a
// lista (padraoNacional) deixou de barrar o cadastro. Ela fica para quando surgir regime que dependa dela.
export function municipioAtendido(d: Pick<DadosCnpj, "regime" | "codigo_municipio_ibge">, lista: ListaMunicipios): boolean {
  if (d.regime === "mei" || d.regime === "simples") return true;
  return padraoNacional(d.codigo_municipio_ibge, lista);
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
