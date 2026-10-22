// Dublê da API da Anthropic (:3005): POST /v1/messages com respostas fixas, para o intérprete do pedido e para a
// leitura do PDF. A resposta segue o esquema que o pedido declarar (ferramenta com input_schema, ou saída
// estruturada em output_config/output_format): cada propriedade conhecida recebe o valor fixo abaixo, e as outras,
// o valor neutro do tipo. Sem esquema, devolve o objeto fixo em texto JSON. Os tokens vêm em `usage`.
import { servidor, lerJson, json, html, pagina, esc, id } from '../http.mjs';

export const PDF_FIXO = {
  nome: 'Prontia Saúde', tomador_nome: 'Prontia Saúde Ltda', tomador_documento: '11444777000161', tomador_email: 'financeiro@prontia.com.br',
  tomador_endereco: null, codigo_servico_nacional: '040101', descricao: 'Consulta médica', valor_padrao: '150.00', valor: '150.00',
  eh_danfse: true, danfse: true, legivel: true
};

/* "nota pra Prontia Saúde, 10 reais" → tomador e valor; o resto fica neutro. */
export function interpretar(texto) {
  const t = String(texto || '');
  const cancelar = /cancel/i.test(t);
  const valor = /(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:reais|r\$)?/i.exec(t.replace(/r\$\s*/i, ''));
  const tomador = /\b(?:pra|para|pro)\s+(?:a\s+|o\s+)?([^,\d]+?)(?:\s*,|\s+no valor|\s+de\s+\d|\s+\d|$)/i.exec(t);
  const n = valor ? Number(valor[1].replace(/\./g, '').replace(',', '.')) : NaN;
  return {
    intencao: cancelar ? 'cancelar' : 'emitir',
    tomador: tomador ? tomador[1].trim() : null,
    valor: isFinite(n) ? n.toFixed(2) : null,
    modelo: null, descricao: null, documento: null, tomador_documento: null, email: null, tomador_email: null, numero_nota: null, confianca: 0.95
  };
}

function neutro(s) {
  const tipos = [].concat((s && s.type) || []);
  if (s && Array.isArray(s.anyOf)) return neutro(s.anyOf.find((x) => x.type !== 'null') || s.anyOf[0]);
  if (tipos.includes('null')) return null;
  if (s && Array.isArray(s.enum)) return s.enum[0];
  if (tipos.includes('object')) return deEsquema(s, {});
  if (tipos.includes('array')) return [];
  if (tipos.includes('number') || tipos.includes('integer')) return 0;
  if (tipos.includes('boolean')) return true;
  return '';
}

function aceita(s, v) {
  if (!s) return true;
  if (v === null) return [].concat(s.type || []).includes('null') || (s.anyOf || []).some((x) => x.type === 'null') || (s.enum || []).includes(null);
  if (Array.isArray(s.enum)) return s.enum.includes(v);
  const tipos = [].concat(s.type || (s.anyOf || []).map((x) => x.type)).flat();
  if (!tipos.length) return true;
  if (typeof v === 'string') return tipos.includes('string');
  if (typeof v === 'number') return tipos.includes('number') || tipos.includes('integer');
  if (typeof v === 'boolean') return tipos.includes('boolean');
  return tipos.includes('object') || tipos.includes('array');
}

export function deEsquema(s, fixo) {
  const props = (s && s.properties) || {};
  const saida = {};
  for (const [k, sub] of Object.entries(props)) {
    saida[k] = k in fixo && aceita(sub, fixo[k]) ? fixo[k] : neutro(sub);
  }
  return Object.keys(props).length ? saida : { ...fixo };
}

const temPdf = (mensagens) => (mensagens || []).some((m) => Array.isArray(m.content) && m.content.some((c) => c && c.type === 'document'));
function ultimoTexto(mensagens) {
  for (const m of [...(mensagens || [])].reverse()) {
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const t = (m.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
    if (t) return t;
  }
  return '';
}

export async function iniciarIa({ porta = 3005 } = {}) {
  const log = [];
  return servidor(porta, async (req, res, url) => {
    const p = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'POST' && p === '/v1/messages') {
      const b = (await lerJson(req)) || {};
      const pdf = temPdf(b.messages);
      // O texto do pedido costuma vir ao fim da mensagem do usuário; o dublê usa a última linha com conteúdo.
      const pedido = ultimoTexto(b.messages).split('\n').map((x) => x.trim()).filter(Boolean).pop() || '';
      const fixo = pdf ? PDF_FIXO : interpretar(pedido);
      const ferramenta = Array.isArray(b.tools) && b.tools.length ? (b.tool_choice && b.tool_choice.name ? b.tools.find((t) => t.name === b.tool_choice.name) : b.tools[0]) : null;
      const esquema = (b.output_config && b.output_config.format && b.output_config.format.schema) || (b.output_format && b.output_format.schema) || null;
      const usage = { input_tokens: pdf ? 1830 : 412, output_tokens: pdf ? 96 : 58 };
      let content, stop = 'end_turn';
      if (ferramenta) { content = [{ type: 'tool_use', id: id('toolu_demo'), name: ferramenta.name, input: deEsquema(ferramenta.input_schema, fixo) }]; stop = 'tool_use'; }
      else content = [{ type: 'text', text: JSON.stringify(esquema ? deEsquema(esquema, fixo) : fixo) }];
      log.unshift({ em: new Date().toISOString(), tipo: pdf ? 'pdf' : 'pedido', pedido: pdf ? '(PDF)' : pedido, saida: ferramenta ? content[0].input : content[0].text });
      log.length = Math.min(log.length, 100);
      json(res, 200, { id: id('msg_demo'), type: 'message', role: 'assistant', model: b.model || 'demo', content, stop_reason: stop, stop_sequence: null, usage });
      return;
    }
    if (req.method === 'GET' && p === '/') {
      html(res, 200, pagina('IA', `<h1>IA (Anthropic dublê)</h1><p class="cinza">Respostas fixas: o intérprete lê tomador e valor do texto; a leitura de PDF devolve sempre a Prontia Saúde.</p>
        <div class="cartao"><table>${log.map((l) => `<tr><td class="mono">${esc(l.em.slice(11, 19))}</td><td>${esc(l.tipo)}</td><td>${esc(l.pedido)}</td><td class="mono">${esc(typeof l.saida === 'string' ? l.saida : JSON.stringify(l.saida))}</td></tr>`).join('') || '<tr><td class="cinza">nenhuma chamada</td></tr>'}</table></div>`, { atualizar: 5 }));
      return;
    }
    json(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'rota sem dublê' } });
  }, 'ia');
}
