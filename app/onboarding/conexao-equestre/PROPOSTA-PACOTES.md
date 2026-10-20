# Conexão Equestre — reformulação do site · três pacotes

Cliente: Conexão Equestre (centro hípico, Bragança Paulista · conexaoequestre.com.br).
Agência: Maisis Publicidade. Proposta preparada em 20/10/2026 pela nó.
Valores definidos pelo Lucca: R$ 2.000 · R$ 5.000 · R$ 10.000. Custos recorrentes de
terceiros (domínio, e-mail, gateway de pagamento) não estão incluídos e serão confirmados
por pacote antes do fechamento.

## Diagnóstico do site atual (20/10/2026)

- WordPress com tema "Equestrian Centre" (2016–2018), Revolution Slider, Essential Grid,
  Max Mega Menu, The Events Calendar. Rodapé ainda diz "© 2016-2018".
- 27 itens de menu em quatro grupos (A Hípica · Para pessoas · Para cavalos · Contato),
  com páginas duplicadas (`/escoladeequitacao` e `/escola-de-equitacao/`, `/domanatural/`
  e `/doma-natural-iniciacao-de-potros/`) e links quebrados (`/site/...`, `/services_group/...`,
  Escola da Leveza retorna 404).
- Conteúdo desatualizado em destaque: cursos de 2023 "cancelados/adiados", "Próxima data a
  ser marcada em 2022", "III Etapa do Ranking de Salto" sem ano, calendário com "0 eventos".
- Textos longos e bons (metodologia, percurso de aprendizagem, estrutura, Terra), mas
  publicados como blocos corridos sem hierarquia. Placeholders "xxm2" na Estrutura e Eventos.
- Sem CTA fixo de WhatsApp, sem formulário funcional visível, mapa repetido em todas as páginas.
- Ativos reaproveitáveis: logo (âmbar + verde `#01855F`), fotos boas de passeio, baias,
  piquetes, equipe (12 pessoas), canal no YouTube, Instagram e Facebook.

Conteúdo-fonte extraído de 20 páginas do site atual e preservado integralmente na LP básica
(resumo visível + texto completo em blocos expansíveis). Sem invenção de datas ou valores.

---

## Pacote 1 · Básico — R$ 2.000 · "Site de uma página"

O que já está no protótipo navegável (`lp-basica-v1`). É a base dos três pacotes.

**Entrega**
- Site de página única, responsivo, com todo o conteúdo atual reorganizado em seções:
  A Hípica · Para pessoas (passeio, escola, lúdica, horsemanship, arquearia, cursos) ·
  Para cavalos (hospedagem, doma natural, serviços) · Estrutura · Filosofia & Terra ·
  Equipe · Eventos & locações · Equoterapia · Parceiros · Contato.
- Menu âncora com os mesmos quatro grupos do site atual; cada página antiga vira uma seção
  com o texto completo em "ler mais", sem perder conteúdo e sem parede de texto.
- Identidade preservada: logo, verde institucional e âmbar; fotos atuais tratadas.
- WhatsApp fixo (botão flutuante + CTAs por seção), Google Maps, canal do YouTube,
  Instagram e Facebook.
- Formulário de contato via WhatsApp/e-mail (sem servidor).
- SEO básico: título, descrição, Open Graph, favicon, dados estruturados de negócio local;
  redirecionamento das URLs antigas para as âncoras correspondentes (preserva Google).
- Hospedagem estática em CDN (Vercel ou Cloudflare), HTTPS, carregamento rápido;
  o WordPress atual pode ser desligado.

**Prazo estimado:** 1–2 semanas após aprovação. 1 rodada de ajustes. Suporte 15 dias.
**Não inclui:** painel de edição, blog, calendário de eventos, inscrições, páginas internas.

---

## Pacote 2 · Completo — R$ 5.000 · "Site institucional com painel"

Tudo do Básico, mais:

- Páginas internas próprias (até 15), espelhando o menu atual: Escola de Equitação
  (com percurso de aprendizagem e modalidades), Equitação Lúdica, Natural Horsemanship,
  Arquearia, Doma Natural, Hospedagem, Serviços para cavalos, Estrutura, Equipe, Eventos
  & locações, Equoterapia/Instituto Pegasus, Terra, Parceiros, Contato.
- Painel de edição simples para a equipe da Conexão: textos, datas e valores dos cursos,
  fotos, equipe e parceiros — sem depender de agência para atualizar.
- Agenda de cursos e eventos (substitui o calendário do WordPress) com página por evento
  e botão de inscrição via WhatsApp ou link externo.
- Formulário de contato real com envio por e-mail e cópia no painel.
- Galeria de fotos e vídeos por seção; SEO por página, sitemap e redirects 301 de todas as
  URLs antigas; Google Analytics e Search Console configurados.
- Migração das imagens do WordPress e desligamento assistido do site antigo.

**Prazo estimado:** 3–5 semanas. 2 rodadas de ajustes. Suporte 30 dias.
**Não inclui:** pagamento online, área do aluno, automações.

---

## Pacote 3 · Plataforma — R$ 10.000 · "Site + inscrições e relacionamento"

Tudo do Completo, mais:

- Inscrições online em cursos, workshops e passeios com controle de vagas e pagamento
  (Pix e cartão), confirmação automática por e-mail/WhatsApp e lista de inscritos no painel.
- Agendamento de passeios a cavalo e aulas experimentais com horários disponíveis.
- Área do cliente: histórico de inscrições, certificados dos módulos de Horsemanship,
  e ficha do cavalo hospedado (documentos, vacinas, ferrageamento) para proprietários.
- Blog/notícias e newsletter (Terra, eventos, resultados de provas) com editor no painel.
- Versão em inglês das páginas de cursos internacionais (Arquearia Montada, Horsemanship).
- Site instalável no celular (PWA) e integração do feed do Instagram.
- Relatórios no painel: inscrições, origem dos contatos, receita por curso.

**Prazo estimado:** 6–9 semanas. 3 rodadas de ajustes. Suporte 60 dias.
Custos recorrentes de gateway de pagamento e e-mail transacional a confirmar.

---

## Pendente de revisão (20/10/2026)

Lucca: acentuar os diferenciais de experiência entre os pacotes. O gap essencial de front
do Básico para a Plataforma é a UX/UI do visitante: animações de entrada e de scroll,
componentes interativos (carrosséis, filtros, calculadoras, agenda), microinterações e
transições de página. Reescrever as listas de cada pacote com esse eixo antes de apresentar.

## Comparativo rápido

| | Básico · R$ 2 mil | Completo · R$ 5 mil | Plataforma · R$ 10 mil |
|---|---|---|---|
| Páginas | 1 (seções) | até 15 | até 15 + área logada |
| Painel de edição | — | sim | sim |
| Agenda de eventos | — | sim | sim, com inscrição e vagas |
| Contato | WhatsApp / e-mail | formulário real | formulário + agendamento |
| Pagamento online | — | — | Pix e cartão |
| Área do cliente | — | — | sim |
| Blog / newsletter | — | — | sim |
| Inglês | — | — | páginas de cursos |
| Redirects SEO | âncoras | 301 por página | 301 por página |
| Prazo | 1–2 sem. | 3–5 sem. | 6–9 sem. |
| Suporte | 15 dias | 30 dias | 60 dias |
