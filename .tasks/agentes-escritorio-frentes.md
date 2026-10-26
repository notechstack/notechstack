# Frentes em paralelo · /agentes/ "Escritório nó"

Divisão da task `.tasks/agentes-escritorio.md` para rodar **tlc-implement** em vários chats do
Personal Workspace ao mesmo tempo. A task continua sendo o registro de decisão. Este arquivo só
define quem constrói o quê, em que pasta e como as peças se encaixam.

## Por que esta divisão funciona no Personal Workspace

- Cada chat roda numa pasta ou numa **worktree já existente**, que o app descobre por
  `git worktree list`. O app não cria worktree nem branch. Por isso as worktrees abaixo já
  estão criadas.
- Duas frentes nunca escrevem no mesmo arquivo, então o merge final não tem conflito.
- As frentes B e C não esperam a A: elas constroem contra o **contrato** abaixo e testam numa
  página de bancada própria, em `.checks/agentes/`.
- As cinco contas Claude são os mesmos perfis do Escritório nó, com a mesma franquia. Não
  rode reuniões do Escritório em paralelo enquanto as frentes trabalham.
- Use o modo **Agente** ou o **Auto** com conta Claude: as regras de negação de `.env*`
  valem ali. No Codex com `danger-full-access` não há essa trava, e por isso ele fica fora
  das frentes que escrevem código.
- Push, PR, merge remoto e deploy continuam sendo de Lucca: nenhuma frente faz.

## Frentes

| Frente | Worktree (abrir como contexto) | Branch | Conta sugerida | Critérios | Arquivos que só ela escreve |
|---|---|---|---|---|---|
| **A · Página e integração** | `C:/Users/lucca/projetos/notechstack-agentes` | `feat/agentes-escritorio` | Claude · Opus 5.5, esforço alto | 1–5, 19, 20, 22–25, 27–32 e a integração de todas | `agentes/index.html`, `agentes/agentes.css`, `agentes/escritorio/pagina.js` |
| **B · Cena 3D** | `C:/Users/lucca/projetos/notechstack-agentes-cena` | `feat/agentes-escritorio-cena` | Claude · Opus 5.5 ou Fable 5.1, esforço máximo | 6–11, mais os pôsteres do 26 | `agentes/escritorio/cena.js`, `agentes/escritorio/cena-*.js` (se dividir), `agentes/escritorio/poster-escritorio.webp`, `agentes/escritorio/poster-fecho.webp`, `.checks/agentes/cena.html`, `.checks/agentes/cena-*.png` |
| **C · Gaveta e WhatsApp** | `C:/Users/lucca/projetos/notechstack-agentes-whatsapp` | `feat/agentes-escritorio-whatsapp` | Claude · Sonnet 5.5, esforço alto | 12–18, 21 e a parte da gaveta do 26 | `agentes/escritorio/gaveta.js`, `agentes/escritorio/gaveta.css`, `.checks/agentes/gaveta.html`, `.checks/agentes/gaveta-*.png` |
| **D · Verificação independente** | a da frente A, depois do merge | `feat/agentes-escritorio` (só leitura) | outra conta Claude, que não construiu nada | prova os 32, com capturas em 375×812, 390×844 e 1440×900 | `.checks/agentes/verificacao.md`, `.checks/agentes/final-*.png` |

Ordem:

```
A ─┐
B ─┼─(paralelo)─→ A faz merge local de B e C em feat/agentes-escritorio ─→ A integra e liga ─→ D verifica ─→ Lucca: PR
C ─┘
```

A única restrição de ordem é essa: D só começa depois do merge e da integração. A pode
começar o HTML, o CSS, a tela de carregamento e a versão estática (com um pôster
provisório) antes de B e C terminarem.

## Contrato entre as frentes

O contrato é o que permite às três frentes trabalharem ao mesmo tempo. Mudar nome, assinatura
ou caminho daqui exige combinar antes com as outras frentes, por mensagem de Lucca.

**Cena (B entrega, A consome):** `agentes/escritorio/cena.js`, módulo ES que importa `three`
pelo importmap da página (`three@0.170.0`, igual à home).

```js
export async function montarEscritorio(canvas, { aoProgresso }) // aoProgresso(p) com p de 0 a 1
// resolve depois do primeiro quadro desenhado; rejeita se não houver WebGL
// devolve:
{
  focar(mesa),        // 'fiscal' | 'auditor' | null — aproxima a mesa (Tela 2) ou volta
  fecho(t),           // t de 0 a 1, chamado por A conforme a rolagem — 0 = Tela 1, 1 = Tela 3
  aoTocarMesa(fn),    // fn('fiscal' | 'auditor' | 'vaga') no toque no canvas
  pausar(), retomar(),
  quadros(),          // contador de quadros desenhados (prova do critério 10)
  destruir()
}
```

- B cuida sozinho da pausa por `IntersectionObserver` e `visibilitychange`. `pausar()` e
  `retomar()` existem para A pausar a cena enquanto a tela de carregamento está aberta.
- Os pôsteres são renderizados da própria cena: 750×1624 (375×812 @2x) em WebP, um no
  enquadramento da Tela 1 e outro no da Tela 3.

**Gaveta (C entrega, A consome):** `agentes/escritorio/gaveta.js` (módulo ES, sem dependência)
e `agentes/escritorio/gaveta.css`.

```js
export function montarGaveta(raiz, { estatico }) // raiz: <div id="gaveta"> vazio na página
// devolve:
{
  abrir(agente, origem), // 'fiscal' | 'auditor'; origem = botão que recebe o foco ao fechar
  fechar(),
  aoMudar(fn)            // fn({ aberta, agente }) — A usa para chamar cena.focar()
}
```

- C cuida de: selo, título, mockup, animação das mensagens, laço do critério 14, nota do
  critério 17, CTAs, ×, `Esc`, toque fora, foco preso e o cancelamento de temporizadores do
  critério 21.
- Com `estatico: true`, mostra a conversa inteira sem animação.

**Página (A):** `agentes/index.html` tem:
- `<canvas id="escritorio-canvas">` e `<img id="escritorio-poster">` na hero;
- `<div id="gaveta">`;
- um botão por mesa (`data-mesa="fiscal|auditor|vaga"`);
- a tela de carregamento, com a classe `carregando` no `<html>`, posta só por JS.

`agentes/escritorio/pagina.js` (de A):
- liga o carregamento;
- decide entre a versão animada e a estática;
- chama `montarEscritorio` e `montarGaveta`;
- liga a rolagem do fecho a `cena.fecho(t)`;
- liga a gaveta à câmera.

## Texto para colar em cada chat

**A**
> Rode tlc-implement em `.tasks/agentes-escritorio.md` como a **frente A** de
> `.tasks/agentes-escritorio-frentes.md`. Construa só os critérios e arquivos da frente A e
> respeite o contrato. Comece pelo HTML, pelo CSS, pela tela de carregamento e pela versão
> estática com pôster provisório. Quando Lucca avisar que B e C terminaram, faça merge local
> de `feat/agentes-escritorio-cena` e `feat/agentes-escritorio-whatsapp` e integre. Antes, leia
> a skill no-design-system. Commits locais, sem push.

**B**
> Rode tlc-implement em `.tasks/agentes-escritorio.md` como a **frente B** de
> `.tasks/agentes-escritorio-frentes.md`: a cena 3D, critérios 6–11 e os pôsteres do 26.
> Escreva só os arquivos da frente B e entregue exatamente a API `montarEscritorio` do
> contrato. Teste em `.checks/agentes/cena.html` com 375×812. Referência visual:
> `.tasks/refs/agentes-escritorio-referencia.webp`. Matéria e padrão:
> `lp-narrador/cenas-lp/historia/cenas3d.js`. Antes, leia a skill no-design-system. Commits
> locais, sem push.

**C**
> Rode tlc-implement em `.tasks/agentes-escritorio.md` como a **frente C** de
> `.tasks/agentes-escritorio-frentes.md`: gaveta e mockups de WhatsApp, critérios 12–18 e 21
> e a parte da gaveta do 26. Escreva só os arquivos da frente C e entregue exatamente a API
> `montarGaveta` do contrato. Teste em `.checks/agentes/gaveta.html` com 375×812. Textos do
> fiscal saem de `agentes/fiscal/fiscal.js`. O formato do auditor sai de `textoCopia` em
> `supabase/functions/marketing-hub/auditor.ts`, e os números só da demonstração da
> retrospectiva (Unresolved 3). Antes, leia a skill no-design-system. Commits locais, sem push.

**D**
> Na worktree `notechstack-agentes`, depois da integração da frente A, verifique os 32
> critérios de `.tasks/agentes-escritorio.md` sem corrigir nada. Um por um, com a prova:
> comando, captura ou leitura do DOM. Capture em 375×812, 390×844 e 1440×900. Registre em
> `.checks/agentes/verificacao.md` o que passou, o que falhou e a evidência de cada um.
