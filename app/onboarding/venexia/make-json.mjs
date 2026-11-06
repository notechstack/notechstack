// Gera venexia.json (snapshot do cadastro). Uso: node app/onboarding/venexia/make-json.mjs
// Os links de WhatsApp dos pacotes são montados aqui para a mensagem ficar codificada corretamente.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const THOMAS = '5511997151833'
const wa = (pkg) => `https://wa.me/${THOMAS}?text=` + encodeURIComponent(`Olá, Thomas! Vi a proposta da Venexia no painel da nó e quero seguir com o ${pkg}.`)
const t = (source_id, title, phase, status, note, position) => ({ source_id, title, phase, status, note, week: null, position })
const P0 = 'Fase 0 · Proposta'
const P1 = 'Fase 1 · Conteúdo e identidade'
const P2 = 'Fase 2 · Produção do site'
const P3 = 'Fase 3 · Publicação'

const spec = {
  client: { name: 'Venexia', slug: 'venexia', login_email: 'venexia@maisis.com.br' },
  project: {
    name: 'Novo site Venexia',
    niche: 'venda direta · bem-estar e beleza',
    agency_slug: 'maisis',
    lead_status: 'JANELA_DE_DECISAO',
    project_status: 'EM_REVISAO_CLIENTE',
    access_status: 'ATIVO_ATE_FIM_DO_PROJETO',
    modules: { como_funciona: 'ativo', prototipo: 'ativo', etapas: 'ativo', editor: 'bloqueado', versoes: 'bloqueado', marca: 'bloqueado' },
  },
  source: {
    site_atual: 'https://venexia.com.br/',
    apresentacao: 'Apresentação Venexia.pdf (23 slides, recebida da Maisis em 06/11/2026)',
    referencia_pacote_3: 'https://www.instagram.com/reels/DfIYxtGR8Vu/',
    prototipo: 'app/public/prototipos/venexia/lp-institucional-v1/',
  },
  roadmap: {
    stack: {
      architecture: {
        title: 'A tecnologia do novo site.',
        description: 'Pacote 1: site institucional de página única, estático e rápido, com animações de entrada. O Pacote 2 acrescenta loja, estoque e pagamentos; o Pacote 3 transforma o catálogo num mural interativo.',
        inputs: [
          { id: 'site', brand: '', title: 'Site institucional', tool: 'HTML, CSS e JavaScript', detail: 'Página única com produtos, Clube Namu, Best Off e oportunidade', href: 'https://developer.mozilla.org/pt-BR/docs/Web/HTML' },
          { id: 'contato', brand: 'resend', title: 'Formulário de contato', tool: 'Resend', detail: 'Envio dos contatos por e-mail · previsto, desligado no protótipo', href: 'https://resend.com' },
          { id: 'whatsapp', brand: 'whatsapp', title: 'Botão de WhatsApp', tool: 'WhatsApp', detail: 'Número da Venexia a confirmar · previsto para o site final', href: 'https://business.whatsapp.com' },
        ],
        core: { id: 'core', brand: 'no', title: 'Site publicado pela nó', tool: 'Vercel', detail: 'Hospedagem em CDN com HTTPS · prevista para o site final', href: 'https://vercel.com' },
        services: [
          { id: 'dominio', brand: '', title: 'Domínio', tool: 'Domínio próprio', detail: 'venexia.com.br apontado para o novo site após a aprovação', href: 'https://venexia.com.br' },
          { id: 'seo', brand: 'meta', title: 'SEO e compartilhamento', tool: 'Meta tags + Open Graph', detail: 'Prévia ao compartilhar no WhatsApp e nas redes · prevista para o site final', href: 'https://developers.facebook.com/docs/sharing/webmasters/' },
          { id: 'loja', brand: 'supabase', title: 'Loja, estoque e pedidos', tool: 'Supabase', detail: 'Pacote 2 · não incluído no Pacote 1', href: 'https://supabase.com' },
        ],
        caption: 'O protótipo navegável é o Pacote 1 pronto para aprovação. Hospedagem, domínio, loja e pagamentos dependem do pacote escolhido e ainda não foram ativados.',
      },
    },
    costs: [],
    next_steps: {
      presentation: {
        phase_mode: 'source',
        review_label: 'Proposta em análise',
        review_description: 'Três pacotes propostos; nenhum escolhido ainda.',
        prototype_title: 'Navegue pelo novo site da Venexia.',
        editor_lock_reason: 'O Editor fica bloqueado até a aprovação do pacote. Navegue pela aba Protótipo e envie suas observações à Maisis.',
        hero_title: 'O novo site da Venexia, pronto para aprovação.',
        hero_description: 'Explore o protótipo do site institucional, conheça a tecnologia e compare os três pacotes propostos.',
        infrastructure_title: 'Três pacotes. Escolha o tamanho do próximo passo.',
        scope_options: [
          {
            label: 'Site institucional', badge: 'Pacote 1', price: 'R$ 1.500',
            tagline: 'O site que você está vendo no protótipo, pronto para ir ao ar.',
            selected: false,
            features: [
              'Site novo em uma página: marca, produtos, Clube Namu, Best Off e oportunidade.',
              'Formulário de contato e botão de WhatsApp (número a confirmar).',
              'Animações de entrada, textos e cores, como no protótipo.',
              'Prazo e suporte combinados com a Maisis.',
            ],
            cta_label: 'Quero o Pacote 1', cta_href: wa('Pacote 1 — Site institucional (R$ 1.500)'),
          },
          {
            label: 'E-commerce', badge: 'Pacote 2', price: 'R$ 5.000',
            tagline: 'Loja virtual completa para vender os produtos direto pelo site.',
            selected: false,
            features: [
              'Loja com catálogo dos produtos, carrinho e checkout.',
              'Pagamentos por API, controle de estoque e logística de entrega.',
              'Painel de produtos e pedidos, com o visual animado do Pacote 1.',
              'Prazo e suporte combinados com a Maisis.',
            ],
            cta_label: 'Quero o Pacote 2', cta_href: wa('Pacote 2 — E-commerce (R$ 5.000)'),
          },
          {
            label: 'Catálogo conceitual', badge: 'Pacote 3', price: 'R$ 8.000 a 10.000',
            tagline: 'Uma vitrine de luxo: o catálogo vira um mural interativo.',
            selected: false,
            features: [
              'Catálogo em mural: produtos em nichos iluminados, como numa galeria.',
              'Clique no produto e ele se expande com detalhes e preço.',
              'Zoom, transições e componentes interativos: a experiência mais imersiva.',
              'Prazo e suporte combinados com a Maisis.',
            ],
            cta_label: 'Quero o Pacote 3', cta_href: wa('Pacote 3 — Catálogo conceitual (R$ 8.000 a 10.000)'),
          },
        ],
        scope_note: 'Nenhum pacote foi escolhido ainda. Valores da proposta de 06/11/2026; prazos, suporte e custos de domínio e meio de pagamento são confirmados com a Maisis antes do fechamento.',
        hide_project_navigation: true,
      },
      task_details: {},
    },
    references: [
      'Site atual: https://venexia.com.br/ (página de lançamento, 1º/11/2026)',
      'Apresentação institucional da Venexia (23 slides): textos, fotos e plano de marketing',
      'Referência do Pacote 3: mural de produtos que expande ao clique',
      'Protótipo: lp-institucional-v1 (Pacote 1)',
    ],
    tiers: {},
    preferred_tier: null,
    prototype_url: '/prototipos/venexia/lp-institucional-v1/index.html',
  },
  tasks: [
    t('p0-1', 'Leitura da apresentação e do site atual', P0, 'concluido', '23 slides e a página de lançamento: textos, produtos e plano.', 0),
    t('p0-2', 'Proposta com três pacotes', P0, 'concluido', 'Institucional, E-commerce e Catálogo conceitual.', 1),
    t('p0-3', 'Protótipo do site institucional', P0, 'concluido', 'Disponível na aba Protótipo.', 2),
    t('p0-4', 'Apresentação pela Maisis', P0, 'a_fazer', 'Reunião com a Venexia.', 3),
    t('p0-5', 'Escolha do pacote', P0, 'a_fazer', 'Define o escopo das próximas fases.', 4),
    t('p1-1', 'Fotos originais dos produtos', P1, 'a_fazer', 'As do protótipo foram recortadas da apresentação.', 5),
    t('p1-2', 'Revisão dos textos e do plano de marketing', P1, 'a_fazer', 'Inclui a regra vigente da Venexia Experience.', 6),
    t('p1-3', 'Contatos e redes da Venexia', P1, 'a_fazer', 'WhatsApp, e-mail de atendimento e Instagram.', 7),
    t('p1-4', 'Uso das marcas Namu e Best Off', P1, 'a_fazer', 'Confirmar textos e logos autorizados pelos parceiros.', 8),
    t('p2-1', 'Ajustes após a aprovação', P2, 'a_fazer', 'Rodadas de revisão conforme o pacote.', 9),
    t('p2-2', 'Formulário de contato ativo', P2, 'a_fazer', 'Contatos chegando no e-mail da Venexia.', 10),
    t('p2-3', 'Testes em celular e computador', P2, 'a_fazer', 'Velocidade, animações, formulário e WhatsApp.', 11),
    t('p3-1', 'Domínio venexia.com.br apontado', P3, 'a_fazer', 'Substitui a página de lançamento atual.', 12),
    t('p3-2', 'Site no ar e conferido', P3, 'a_fazer', 'Formulário, WhatsApp e velocidade no endereço final.', 13),
    t('p3-3', 'Início do suporte', P3, 'a_fazer', 'Período conforme o pacote escolhido.', 14),
  ],
}

writeFileSync(path.join(here, 'venexia.json'), JSON.stringify(spec, null, 2) + '\n')
console.log('ok venexia.json')
