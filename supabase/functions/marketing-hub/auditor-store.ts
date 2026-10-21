// Implementação Supabase do AuditorStore (Frente 3). Só service role: a fila, os snapshots e a exclusão
// não passam pelo JWT do cliente. Nenhum método devolve token.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { AuditorStore } from "./auditor.ts";
import type { Aviso, AtivoColeta, ConexaoEstado, RelatorioFila } from "../_shared/auditor/processar.ts";

function falhar(contexto: string, error: { message?: string; code?: string } | null): never {
  throw new Error(`${contexto}: ${error?.code ?? ""} ${error?.message ?? "falha"}`.trim());
}

export function criarAuditorStore(admin: SupabaseClient): AuditorStore {
  const emails = new Map<string, string | null>();
  async function emailDe(userId: string): Promise<string | null> {
    if (emails.has(userId)) return emails.get(userId)!;
    const { data, error } = await admin.auth.admin.getUserById(userId);
    const email = error ? null : data.user?.email ?? null;
    emails.set(userId, email);
    return email;
  }

  return {
    async cronSecretOk(segredo) {
      const { data, error } = await admin.rpc("marketing_cron_secret_ok", { p_secret: segredo });
      return !error && data === true;
    },

    async claim(limite) {
      const { data, error } = await admin.rpc("auditor_claim_relatorios", { p_limit: limite });
      if (error) falhar("auditor_claim_relatorios", error);
      return ((data ?? []) as RelatorioFila[]).map((r) => ({
        id: r.id, client_id: r.client_id, tipo: r.tipo, periodo_de: r.periodo_de, periodo_ate: r.periodo_ate, tentativas: r.tentativas,
      }));
    },

    async negocio(clientId) {
      const { data, error } = await admin.from("auditor_clientes")
        .select("client_id, site_url, clients!inner(name), auditor_contas!inner(dono_user_id)").eq("client_id", clientId).maybeSingle();
      if (error) falhar("auditor_clientes", error);
      if (!data) return null;
      const d = data as unknown as { client_id: string; site_url: string | null; clients: { name: string }; auditor_contas: { dono_user_id: string } };
      return { client_id: d.client_id, nome: d.clients.name, site_url: d.site_url, dono_email: await emailDe(d.auditor_contas.dono_user_id) };
    },

    async ativos(clientId) {
      const { data, error } = await admin.from("marketing_cliente_ativos").select("tipo, external_id, login_customer_id").eq("client_id", clientId);
      if (error) falhar("marketing_cliente_ativos", error);
      return (data ?? []) as AtivoColeta[];
    },

    async conexoes(clientId) {
      const { data, error } = await admin.from("marketing_cliente_conexoes").select("provedor, estado").eq("client_id", clientId).neq("estado", "desconectado");
      if (error) falhar("marketing_cliente_conexoes", error);
      return (data ?? []) as ConexaoEstado[];
    },

    async snapshot(l) {
      const { error } = await admin.from("marketing_cliente_snapshots")
        .upsert({ ...l, versao_formato: 1, coletado_em: new Date().toISOString() }, { onConflict: "client_id,tipo,external_id,periodo_de,periodo_ate" });
      if (error) falhar("marketing_cliente_snapshots", error);
    },

    async atualizar(id, patch) {
      const { error } = await admin.from("auditor_relatorios").update(patch).eq("id", id);
      if (error) falhar("auditor_relatorios", error);
    },

    async falha(id, erro, transitorio) {
      const { data, error } = await admin.rpc("auditor_relatorio_falha", { p_id: id, p_erro: erro, p_transitorio: transitorio });
      if (error) falhar("auditor_relatorio_falha", error);
      return String(data);
    },

    async avisosPendentes(limite) {
      const { data, error } = await admin.from("auditor_avisos").select("id, client_id, tipo, referencia").is("enviado_em", null).order("criado_em").limit(limite);
      if (error) falhar("auditor_avisos", error);
      return (data ?? []) as Aviso[];
    },

    async avisoEnviado(id) {
      const { error } = await admin.from("auditor_avisos").update({ enviado_em: new Date().toISOString() }).eq("id", id);
      if (error) falhar("auditor_avisos", error);
    },

    async evento(clientId, acao, detalhe) {
      await admin.rpc("marketing_cliente_evento", { p_client_id: clientId, p_ator: null, p_papel: "SISTEMA", p_acao: acao, p_detalhe: detalhe });
    },

    async contaDoDono(userId) {
      const { data, error } = await admin.from("auditor_contas")
        .select("id, auditor_clientes(client_id), auditor_assinaturas!auditor_contas_assinatura_id_fkey(pagarme_subscription_id, status)")
        .eq("dono_user_id", userId).maybeSingle();
      if (error) falhar("auditor_contas", error);
      if (!data) return null;
      const d = data as unknown as {
        id: string; auditor_clientes: { client_id: string }[];
        auditor_assinaturas: { pagarme_subscription_id: string | null; status: string } | null;
      };
      const a = d.auditor_assinaturas;
      return {
        conta_id: d.id,
        negocios: d.auditor_clientes.map((x) => x.client_id),
        assinatura: a?.pagarme_subscription_id ? { subscription_id: a.pagarme_subscription_id, status: a.status } : null,
      };
    },

    async apagarConta(contaId) {
      const { data, error } = await admin.rpc("auditor_apagar_conta", { p_conta_id: contaId, p_origem: "cliente" });
      if (error) falhar("auditor_apagar_conta", error);
      const r = data as { codigo: string; usuario_apagado: boolean };
      return { codigo: r.codigo, usuario_apagado: r.usuario_apagado };
    },

    async operacao() {
      const { data, error } = await admin.from("auditor_operacao").select("*").order("conta_criada_em", { ascending: false }).limit(500);
      if (error) falhar("auditor_operacao", error);
      // U6: falhou → parcial → o resto.
      const peso = (x: { ultimo_relatorio?: { estado?: string } | null }) =>
        x.ultimo_relatorio?.estado === "falhou" ? 0 : x.ultimo_relatorio?.estado === "parcial" ? 1 : 2;
      return ((data ?? []) as { ultimo_relatorio?: { estado?: string } | null }[]).sort((a, b) => peso(a) - peso(b));
    },

    async suporteVigente(userId, clientId) {
      void userId; // a concessão é do negócio; quem lê é o NO_ADMIN já checado pelo handler (aal2)
      const agora = new Date().toISOString();
      const { data, error } = await admin.from("auditor_acessos_suporte").select("id")
        .eq("client_id", clientId).is("revogado_em", null).lte("inicio", agora).gt("expira_em", agora).limit(1);
      if (error) falhar("auditor_acessos_suporte", error);
      return (data ?? []).length > 0;
    },
  };
}
