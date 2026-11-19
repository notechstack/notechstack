# API do nó.fiscal — emissão de NFS-e e NF-e para parceiros

> Documento único, pensado para ser lido inteiro por uma pessoa ou por um assistente de IA que vai escrever a
> integração. Tudo o que a API aceita e devolve está aqui. O contrato em OpenAPI 3.1 está em
> [`openapi.yaml`](./openapi.yaml), na mesma pasta.
>
> Versão do documento: 2026-11-19. Base da API: `https://app.notechstack.com.br/api`.

## Sumário

1. [O que a API faz](#1-o-que-a-api-faz)
2. [Do zero à primeira nota](#2-do-zero-à-primeira-nota)
3. [Autenticação](#3-autenticação)
4. [Convenções](#4-convenções)
5. [Empresas](#5-empresas)
6. [NFS-e](#6-nfs-e)
7. [NF-e (modelo 55)](#7-nf-e-modelo-55)
8. [Webhook de retorno](#8-webhook-de-retorno)
9. [Status das notas](#9-status-das-notas)
10. [Erros](#10-erros)
11. [Idempotência e reenvio](#11-idempotência-e-reenvio)
12. [Limites](#12-limites)
13. [White label: o que leva a marca da nó](#13-white-label-o-que-leva-a-marca-da-nó)
14. [Checklist da integração](#14-checklist-da-integração)
15. [Sandbox, produção restrita e chave de produção](#15-sandbox-produção-restrita-e-chave-de-produção)

---

## 1. O que a API faz

O nó.fiscal emite **NFS-e Nacional** (Sefin Nacional, padrão do Emissor Nacional) e **NF-e modelo 55** (Sefaz de cada
UF) para empresas do **Simples Nacional e MEI**.

A API é feita para um **parceiro** (por exemplo, um escritório contábil com sistema próprio) que emite notas por
várias empresas clientes dentro do próprio sistema:

- **Uma chave por conta.** A chave da conta Escritório emite por **qualquer empresa ativa da conta**: basta mandar o
  CNPJ da empresa em `cnpj_prestador` (NFS-e) ou `cnpj_emitente` (NF-e). Sem esse campo, a nota sai pela própria
  conta (o escritório).
- **Empresas pela API.** O sistema do parceiro cadastra a empresa cliente, define código de serviço, percentual do
  Simples e retenção padrão, e consulta a situação dela (pronta, falta A1, procuração pendente…).
- **Assíncrona.** O pedido de nota responde `202` na hora; a transmissão à Sefin/Sefaz roda em segundo plano (a cada
  minuto). O resultado chega pelo **webhook** e também pode ser consultado por `GET`.
- **Quem assina.** A nota é assinada com o certificado A1 da própria empresa **ou**, por procuração eletrônica, com
  o A1 do escritório. **A nó nunca assina nota de cliente.**

O que **não** passa pela API: envio do certificado A1 e senha (só pelo painel, ver [5.5](#55-certificado-a1)),
assinatura e cobrança, e os dados de NF-e da empresa (IE, endereço, série — aba NF-e do painel).

---

## 2. Do zero à primeira nota

Passo a passo de uma conta Escritório. Os exemplos usam `curl`; troque `$CHAVE` pela sua chave.

> **Comece pelo sandbox.** Com a chave `nfk_test_…` que a nó entrega, os mesmos passos funcionam sem Sefin, sem
> certificado e sem risco fiscal. O caminho completo (sandbox → produção restrita → produção) está em
> [15](#15-sandbox-produção-restrita-e-chave-de-produção).

**Passo 1 — Gerar a chave.** No painel (`https://www.notechstack.com.br/agentes/fiscal/conta/`), aba **API**, clique
em **Gerar chave**. A chave (`nfk_…`) aparece **uma vez só**: guarde no cofre de segredos do seu servidor. Trocar a
chave invalida a anterior na hora.

**Passo 2 — Webhook.** Na mesma aba, informe a URL `https` do seu sistema e salve. O **segredo** (`whsec_…`) também
aparece uma vez só. Clique em **Testar**: o seu sistema recebe um evento `teste` assinado (ver [8](#8-webhook-de-retorno)).

**Passo 3 — Certificado do escritório.** Para emitir por procuração (o caminho recomendado para muitos CNPJs), o
escritório precisa do **próprio A1** gravado no painel (aba Minhas empresas, linha do escritório).

**Passo 4 — Conferir as empresas da conta.**

```bash
curl -s https://app.notechstack.com.br/api/v1/empresas -H "x-api-key: $CHAVE"
```

**Passo 5 — Cadastrar uma empresa cliente.** Os dados do CNPJ (razão social, município, regime) vêm da Receita.

```bash
curl -s -X POST https://app.notechstack.com.br/api/v1/empresas \
  -H "x-api-key: $CHAVE" -H "content-type: application/json" \
  -d '{
    "cnpj": "11222333000181",
    "codigo_servico_nacional": "040101",
    "simples_percentual": "6.00",
    "retencao": { "retem_iss": false, "retem_inss": false }
  }'
```

A resposta traz `empresa.situacao`. Uma empresa nova começa em `falta_a1`.

**Passo 6 — Procuração.** O cliente entra no Portal de Serviços da Receita e cadastra uma **procuração eletrônica
para o serviço NFS-e** em nome do CNPJ do escritório (o campo `empresa.procurador.cnpj` da resposta). Depois, o seu
sistema declara:

```bash
curl -s -X PATCH https://app.notechstack.com.br/api/v1/empresas/11222333000181 \
  -H "x-api-key: $CHAVE" -H "content-type: application/json" \
  -d '{ "procuracao": { "valida_ate": null } }'
```

A empresa passa a `situacao: "pronta"`. O nó.fiscal confere a procuração no Ambiente de Dados Nacional a cada rodada;
se a Receita ainda não mostrar a procuração, a situação volta para `procuracao_pendente`.

**Passo 7 — Emitir.**

```bash
curl -s -X POST https://app.notechstack.com.br/api/v1/nfse \
  -H "x-api-key: $CHAVE" -H "content-type: application/json" \
  -d '{
    "external_id": "venda-000123",
    "cnpj_prestador": "11222333000181",
    "tomador": { "cpf": "52998224725", "nome": "Maria Souza", "email": "maria@exemplo.com.br" },
    "valor": "150.00"
  }'
```

Resposta `202` com `status: "queued"` e o `id` da nota.

**Passo 8 — Resultado.** Em até alguns minutos, o webhook recebe `nfse.emitida` (ou `nfse.recusada`, com o motivo).
Baixe o DANFSe e o XML:

```bash
curl -s https://app.notechstack.com.br/api/v1/nfse/<id>/pdf -H "x-api-key: $CHAVE" -o danfse.pdf
curl -s https://app.notechstack.com.br/api/v1/nfse/<id>/xml -H "x-api-key: $CHAVE" -o nfse.xml
```

**Passo 9 — Sua marca.** Na conta parceira (white label), a nó não manda e-mail nem WhatsApp de nota a ninguém: o
seu sistema entrega o PDF e o XML. Ver [13](#13-white-label-o-que-leva-a-marca-da-nó).

---

## 3. Autenticação

Toda requisição leva o header:

```
x-api-key: nfk_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

- A chave tem `nfk_` + 43 caracteres. O nó.fiscal guarda só o hash dela; quem perde a chave gera outra no painel.
- A chave **sandbox** tem `nfk_test_` + 43 caracteres e vai no mesmo header. Ela só enxerga o sandbox
  ([15](#15-sandbox-produção-restrita-e-chave-de-produção)).
- A chave vale para a conta inteira. **Nunca** use no navegador ou em app instalado: só no seu servidor.
- Chave ausente ou errada: `401 UNAUTHORIZED`. Conta desativada: `403 TENANT_INACTIVE`.
- Trocar a chave no painel invalida a anterior **na hora**. Para trocar sem parar, atualize o segredo no seu servidor
  logo depois de gerar.

---

## 4. Convenções

- **JSON UTF-8** no corpo e na resposta (`content-type: application/json`). Downloads (`pdf`, `danfe`, `xml`) voltam
  como `application/pdf` ou `application/xml`.
- **CPF e CNPJ:** só dígitos (`"52998224725"`, `"11222333000181"`), em string.
- **Valores em reais:** string decimal com ponto e até 2 casas (`"150.00"`, `"1234.5"`). Número JSON também é aceito
  (`150`), mas string evita erro de ponto flutuante.
- **Datas e horas:** ISO 8601 em UTC (`"2026-11-18T13:05:00.000Z"`). Datas sem hora: `AAAA-MM-DD`.
- **Campos desconhecidos são recusados** (`422 UNKNOWN_FIELD`), em qualquer nível. Isso pega erro de digitação cedo e
  garante que nenhum certificado ou senha entre por engano.
- **IDs** de nota são UUID.
- **Ambiente.** Cada empresa tem `ambiente`: `producao_restrita` (homologação da Receita, nota sem valor fiscal) ou
  `producao`. A empresa cadastrada pela API herda o ambiente da conta.

---

## 5. Empresas

### 5.1 Objeto `empresa`

```json
{
  "cnpj": "11222333000181",
  "razao_social": "Clínica Nova Ltda",
  "regime": "simples",
  "ambiente": "producao",
  "ativa": true,
  "principal": false,
  "situacao": "pronta",
  "bloqueio": null,
  "autenticacao": "procuracao",
  "certificado": null,
  "procuracao": { "status": "confirmada", "valida_ate": null, "conferida_em": "2026-11-18T12:00:00.000Z", "ultimo_erro": null },
  "procurador": { "cnpj": "12345678000199", "razao_social": "Escritório Contábil Ltda" },
  "dados_fiscais": { "codigo_servico_nacional": "040101", "simples_percentual": "6.00" },
  "retencao": { "retem_iss": false, "aliquota_iss": null, "retem_inss": true, "inss_percentual": "11.00" },
  "nfe": { "bloqueio": "NFE_SEM_IE" }
}
```

| Campo | Significado |
|---|---|
| `regime` | `simples` (ME/EPP) ou `mei`. Vem da Receita. |
| `principal` | `true` para a própria conta (o escritório). |
| `situacao` | Pode emitir NFS-e? Ver tabela abaixo. |
| `bloqueio` | `null` quando pronta; senão `{ "codigo", "motivo" }` (motivo em português, pronto para mostrar). |
| `autenticacao` | `certificado_proprio` (A1 da empresa) ou `procuracao` (A1 do escritório). |
| `certificado.vence_em` | Validade do A1 da própria empresa, se houver. |
| `procuracao.status` | `declarada` (o escritório disse que fez), `confirmada` (a Receita mostrou ou uma nota saiu), `invalida`, `revogada`. |
| `procurador` | A quem a empresa dá a procuração: sempre o escritório. `null` na própria conta. |
| `dados_fiscais.simples_percentual` | Percentual aproximado de tributos do Simples na nota (`pTotTribSN`). `null` no MEI, no Presumido e no Real. |
| `dados_fiscais.tributos_aproximados` | Lucro Presumido e Real: `{ "federal", "estadual", "municipal" }`, percentuais da Lei 12.741 na nota (`pTotTrib`). `null` nos outros regimes. |
| `retencao` | Padrão de retenção da empresa. Toda nota usa este padrão, salvo se o pedido disser outra coisa. |
| `nfe.bloqueio` | `null` quando a empresa pode emitir NF-e; senão o código (ver [7.6](#76-situação-da-empresa-para-nf-e)). |

**`situacao`**

| Valor | O que falta |
|---|---|
| `pronta` | Nada: pode emitir NFS-e. |
| `falta_a1` | A1 da empresa (painel) **ou** procuração ao escritório (`PATCH` com `procuracao`). |
| `a1_vencido` | Novo A1 da empresa no painel, ou procuração. |
| `procuracao_pendente` | A Receita ainda não mostra a procuração. Confira o cadastro no Portal de Serviços da Receita (serviço NFS-e, procurador = CNPJ do escritório). |
| `procuracao_vencida` | Renovar a procuração e declarar de novo com a nova `valida_ate`. |
| `a1_do_escritorio_invalido` | O A1 do escritório (que assina pelas procurações) venceu ou falta. Painel. |
| `falta_dados_fiscais` | `codigo_servico_nacional` e, no Simples, `simples_percentual`; no Presumido e no Real, `tributos_aproximados` (`PATCH`). |
| `desativada` | A empresa foi desativada no painel. |
| `assinatura_inativa` | A assinatura da conta não está ativa. |
| `municipio_sem_presumido` | Presumido/Real numa cidade que não aceita esses regimes no Emissor Nacional (a Sefin recusou). Lista de espera. |
| `bloqueada` | Outro motivo; veja `bloqueio.motivo`. |

### 5.2 `GET /v1/empresas`

Lista todas as empresas da conta (a principal primeiro).

```json
{ "empresas": [ { "cnpj": "12345678000199", "principal": true, "situacao": "pronta", "...": "..." } ] }
```

### 5.3 `POST /v1/empresas`

Cadastra uma empresa cliente na conta. Só no plano **Escritório**.

| Campo | Tipo | Obrigatório | Regra |
|---|---|---|---|
| `cnpj` | string | sim | 14 dígitos com dígito verificador. Empresa **ativa** na Receita, **Simples ou MEI**; **Lucro Presumido ou Real** onde a prefeitura usa o Emissor Nacional para todas as empresas. Cidade recusada (norma ou recusa da Sefin, como São Paulo e DF) devolve `FORA_DO_SIMPLES` com `lista_espera`; cidade onde ainda ninguém emitiu entra com `"municipio_a_conferir": true`, e a primeira nota confirma. |
| `regime` | string | no Presumido/Real | `"presumido"` ou `"real"`. A Receita só diz "fora do Simples", então quem cadastra informa. Ignorado se a Receita disser MEI ou Simples. |
| `codigo_servico_nacional` | string | sim | 6 dígitos da lista nacional (cTribNac), por exemplo `"040101"`. Vira o código padrão das notas. |
| `simples_percentual` | string | no Simples | `"0"` a `"100"`, até 2 casas. Ignorado no MEI. |
| `tributos_aproximados` | objeto | no Presumido/Real | `{ "federal": "13.45", "estadual": "0", "municipal": "5" }`, de 0 a 100 com até 2 casas; `estadual` ausente vale 0. |
| `retencao` | objeto | não | `{ "retem_iss": bool, "aliquota_iss": "2" a "5", "retem_inss": bool, "inss_percentual": ">0 e <100" }`. MEI não tem retenção. |
| `procuracao` | objeto | não | `{ "valida_ate": "AAAA-MM-DD" ou null }`: declara que a empresa já deu procuração ao escritório. |

Respostas:

- `201` — criada: `{ "criada": true, "reativada": false, "empresa": { ... } }`.
- `200` — o CNPJ **já é desta conta**: devolve como está, sem mudar nada (`"criada": false`). Para mudar, `PATCH`.
- `200` — empresa desativada desta conta voltou: `{ "criada": false, "reativada": true, ... }`.
- `201` com `aviso` — a empresa foi criada, mas a retenção ou a procuração foram recusadas (o `aviso` traz o erro).
- `409 CNPJ_JA_CADASTRADO` — o CNPJ está em outra conta do nó.fiscal.
- `409 EMPRESAS_ACIMA_DO_LIMITE` — o plano já tem o máximo de empresas ativas (`limite` na resposta).
- `422 CNPJ_NAO_ENCONTRADO`, `CNPJ_INATIVO`, `FORA_DO_SIMPLES` — resposta da Receita. Fora do Simples numa cidade sem emissor nacional para todos, `FORA_DO_SIMPLES` vem com `"lista_espera": true`.
- `422 REGIME_A_DECLARAR` — CNPJ fora do Simples: repita com `regime`. `municipio_a_conferir: true` quando ninguém emitiu Presumido na cidade ainda.
- `201` com `"municipio_a_conferir": true` — criada numa cidade a conferir. Se a Sefin recusar a primeira nota por convênio (E0037/E0038/E0039), a cidade passa a recusada e a `situacao` das empresas Presumido/Real dela vira `municipio_sem_presumido`.
- `503 RECEITA_INDISPONIVEL` — a consulta à Receita falhou; tente de novo em alguns minutos.

### 5.4 `GET /v1/empresas/{cnpj}` e `PATCH /v1/empresas/{cnpj}`

`GET` devolve `{ "empresa": { ... } }` ou `404 EMPRESA_NAO_ENCONTRADA`.

`PATCH` aceita qualquer subconjunto de `codigo_servico_nacional`, `simples_percentual`, `tributos_aproximados`, `retencao` e `procuracao`
(mesmas regras do `POST`) e devolve `{ "empresa": { ... } }`. Recusas da procuração voltam como
`409 PROCURACAO_RECUSADA` com `motivo`:

| `motivo` | Significado |
|---|---|
| `ESCRITORIO_SEM_CERTIFICADO` | O escritório precisa do próprio A1 gravado no painel. |
| `PROCURADOR_CERT_VENCIDO` | O A1 do escritório venceu. |
| `PROCURACAO_SO_NO_ESCRITORIO` | Procuração só para empresa cliente, não para a própria conta. |
| `VALIDADE_PASSADA` | `valida_ate` já passou. |
| `RATE_LIMITED` | Mais de 5 tentativas por hora nesta empresa. |

### 5.5 Certificado A1

O A1 (arquivo `.pfx` e senha) **não** entra pela API: é enviado só no painel, em página própria, e fica no cofre do
nó.fiscal. Para dezenas de CNPJs, prefira a **procuração ao escritório**: o escritório envia o próprio A1 uma vez e
cada cliente só precisa outorgar a procuração no portal da Receita.

A **NF-e não aceita procuração**: para emitir NF-e, a empresa precisa do próprio A1 (painel, aba NF-e).

---

## 6. NFS-e

### 6.1 Objeto `nfse`

```json
{
  "id": "6b0c0a8e-3a8e-4b46-9f0d-3c8b7c8f2a11",
  "external_id": "venda-000123",
  "status": "issued",
  "cnpj_prestador": "11222333000181",
  "numero": "1234",
  "numero_dps": "57",
  "chave_acesso": "35503082112223330001810000000000000126110000000571",
  "valor": "150.00",
  "tomador_documento": "52998224725",
  "last_error_code": null,
  "last_error": null,
  "origem": "api",
  "criada_em": "2026-11-18T13:05:00.000Z",
  "emitida_em": "2026-11-18T13:06:02.000Z",
  "cancelada_em": null
}
```

`numero` é o número da NFS-e (só depois de emitida). `numero_dps` é o número da DPS que o nó.fiscal transmitiu.
`origem` é `api` para nota pedida pela API e `outra` para nota do WhatsApp, do painel ou da planilha.

### 6.2 `POST /v1/nfse`

| Campo | Tipo | Obrigatório | Regra |
|---|---|---|---|
| `external_id` | string | sim | 1 a 100 caracteres. **Chave de idempotência por empresa** (use o id da venda no seu sistema). |
| `cnpj_prestador` | string | não | CNPJ de uma empresa **ativa** da conta. Sem ele, emite a própria conta. |
| `tomador.cpf` ou `tomador.cnpj` | string | um dos dois | 11 ou 14 dígitos. |
| `tomador.nome` | string | sim | 1 a 150 caracteres. |
| `tomador.email` | string | não | Usado no e-mail da nota (se os e-mails da nó estiverem ligados). |
| `servico.codigo_servico_nacional` | string | não | Padrão: o código da empresa. |
| `servico.descricao` | string | não | 1 a 2.000 caracteres. Padrão: `"Prestação de serviços"`. |
| `servico.nbs` | string | não | Código NBS (9 dígitos; aceita com pontos, `"1.1502.10.00"`). Ausente = o NBS padrão da empresa. |
| `servico.c_ind_op` / `servico.c_class_trib` | string | não | Reforma Tributária (IBS/CBS): 6 dígitos cada. |
| `servico.municipio_prestacao_ibge` | string | não | Código IBGE (7 dígitos) do município onde o serviço foi prestado. Ausente = o da empresa. |
| `servico.obra` | objeto | nos códigos de obra | Dados da obra, obrigatórios nos 13 códigos de construção civil (07.02.01, 07.02.02, 07.04.01, 07.05.01, 07.05.02, 07.06.01, 07.06.02, 07.07.01, 07.08.01, 07.17.01, 07.19.01, 14.14.03, 14.14.04); sem eles, `422` com `motivo: "OBRA_SEM_DADOS"`. Ou `{ "cno": "12.345.67890/12" }` (CNO ou CEI, 12 dígitos), ou o endereço `{ "cep", "logradouro", "numero", "complemento" (opcional), "bairro" }`. A cidade da obra é a de `municipio_prestacao_ibge`. Ignorado nos outros códigos. |
| `informacoes_complementares` | string | não | Até 2.000 caracteres (dados bancários, observações). Vai no campo de informações complementares da NFS-e. |
| `valor` | string | sim | Valor do serviço, positivo, até 2 casas. |
| `retencao` | objeto | não | Ver abaixo. Ausente = padrão da empresa. |

**Retenção no pedido** (`retencao`):

```json
{ "retem_iss": true, "aliquota_iss": "2.5", "retem_inss": true, "inss": "11%" }
```

- `retem_iss` / `retem_inss`: `true` ou `false`. Campo ausente = padrão da empresa para aquele imposto.
- `aliquota_iss`: de 2 a 5 (%). Obrigatória com ISS retido se a empresa não tiver alíquota padrão.
- `inss`: percentual (`"11%"`) ou valor em reais (`"165.00"`).
- `irrf` e `csrf` (só **Lucro Presumido e Real**): IRRF retido e PIS + COFINS + CSLL retidos (somados), em percentual (`"1,5%"`, `"4,65%"`) ou valor (`"15.00"`). Na DPS viram `vRetIRRF` e `vRetCSLL` (com `tpRetPisCofins` 3). Não há padrão por empresa: vão no pedido.
- ISS retido só para **tomador CNPJ**; o endereço do tomador é buscado na Receita. MEI não tem retenção.

Respostas:

- `202` — nota na fila: o objeto `nfse` + `avisos` (lista de textos; hoje, só o aviso de franquia).
- `202` — mesmo `external_id` da mesma empresa: devolve a nota que já existe, sem conferir de novo.
- `409 EMISSAO_BLOQUEADA` — a empresa não pode emitir agora; `bloqueio` traz o código (o mesmo da `situacao`).
- `404 EMPRESA_NAO_ENCONTRADA` / `409 EMPRESA_INATIVA` — `cnpj_prestador` não é desta conta, ou está desativada.
- `422 VALIDATION_FAILED` / `UNKNOWN_FIELD` — corpo inválido; retenção inválida traz `motivo` e `campo`.

Exemplo de `409`:

```json
{ "bloqueio": "CERT_MISSING", "error": { "code": "EMISSAO_BLOQUEADA", "message": "Não dá para emitir: Oficina Ltda ainda não tem certificado A1." } }
```

### 6.3 Consultar

- `GET /v1/nfse/{id}` — objeto `nfse`. Nota de outra conta ou id inválido: `404`.
- `GET /v1/nfse?external_id={id}&cnpj_prestador={cnpj}` — a nota pelo seu identificador. Sem `cnpj_prestador`,
  procura na própria conta. Útil quando o `POST` caiu por tempo esgotado e você não sabe se a nota foi criada.

### 6.4 `POST /v1/nfse/{id}/cancel`

Sem corpo. Pede o cancelamento:

- nota `queued` (ainda não transmitida): vira `skipped` na hora, sem ir à Sefin;
- nota `issued`: vira `cancel_requested`; o evento de cancelamento sai na próxima rodada e o webhook avisa
  `nfse.cancelada` ou `nfse.cancelamento_recusado`;
- outro status: devolve a nota como está, sem efeito.

Resposta `202` com o objeto `nfse`.

### 6.5 DANFSe e XML

- `GET /v1/nfse/{id}/pdf` — DANFSe em PDF (com marca d'água "CANCELADA" se cancelada).
- `GET /v1/nfse/{id}/xml` — XML da NFS-e autorizada.
- Nota ainda não emitida: `409 NOT_ISSUED`.

---

## 7. NF-e (modelo 55)

A NF-e usa o mesmo motor do painel e da planilha de NF-e do nó.fiscal.

### 7.1 Antes da primeira NF-e

No painel, aba **NF-e**, para cada empresa: inscrição estadual, endereço, série e próximo número, A1 **da própria
empresa** (a NF-e não aceita procuração) e o botão **Conferir na Sefaz**. A situação aparece em
`GET /v1/empresas` → `empresa.nfe.bloqueio` (`null` = pronta).

### 7.2 `POST /v1/nfe`

```json
{
  "external_id": "pedido-9876",
  "cnpj_emitente": "11222333000181",
  "natureza_operacao": "Venda de mercadoria",
  "consumidor_final": "1",
  "presenca": "2",
  "modalidade_frete": "9",
  "destinatario": {
    "documento": "52998224725",
    "nome": "Maria Souza",
    "indicador_ie": "9",
    "inscricao_estadual": null,
    "email": "maria@exemplo.com.br",
    "endereco": {
      "logradouro": "Rua das Flores", "numero": "100", "complemento": "ap 12", "bairro": "Centro",
      "codigo_municipio": "3550308", "uf": "SP", "cep": "01001000", "fone": "11999990000"
    }
  },
  "itens": [
    {
      "codigo": "CAM-P", "descricao": "Camiseta algodão P", "ncm": "61091000", "cfop": "5102",
      "unidade": "UN", "quantidade": 2, "valor_unitario": 49.9, "csosn": "102", "origem": "0",
      "cest": null, "gtin": null, "desconto": null, "frete": null, "seguro": null, "outros": null,
      "aliquota_credito_sn": null, "cst_pis_cofins": null, "informacoes": null
    }
  ],
  "pagamentos": [ { "forma": "17", "valor": 99.8, "descricao": null, "indicador": "0" } ],
  "informacoes_complementares": "Pedido 9876"
}
```

| Campo | Regra |
|---|---|
| `external_id` | Obrigatório; idempotência por empresa (o mesmo valor devolve a mesma nota, com o mesmo número). |
| `cnpj_emitente` | Empresa ativa da conta. Sem ele, a própria conta. |
| `consumidor_final` | `"0"` ou `"1"`. Padrão: `1` se o destinatário não é contribuinte. |
| `presenca` | `0`, `1` presencial, `2` internet, `3` teleatendimento, `4`, `5`, `9` outros. |
| `modalidade_frete` | `0` emitente, `1` destinatário, `2` terceiros, `3`, `4`, `9` sem frete. |
| `destinatario.indicador_ie` | `1` contribuinte com IE, `2` isento, `9` não contribuinte (padrão). |
| `destinatario.endereco.codigo_municipio` | IBGE, 7 dígitos. |
| `itens` | 1 a 990 itens. `quantidade`, `valor_unitario` e valores em número (ponto decimal). |
| `itens[].csosn` | `101`, `102`, `103`, `300`, `400`, `500`. Com `101`, informe `aliquota_credito_sn`. |
| `pagamentos` | `forma`: `01` dinheiro, `03` crédito, `04` débito, `15` boleto, `17` PIX, `90` sem pagamento, `99` outros. Ausente: `99` no valor da nota. |

As regras fiscais (NCM de 8 dígitos, CFOP coerente com a UF do destinatário, totais, pagamento) são as mesmas do
painel; quando algo não fecha, a resposta é `422 VALIDATION_FAILED` com a lista `problemas`.

Respostas: `202` com o objeto `nfe`; `409 EMISSAO_BLOQUEADA` com `bloqueio`; `422`.

### 7.3 Objeto `nfe`

```json
{
  "id": "0b8f…", "external_id": "pedido-9876", "status": "authorized", "cnpj_emitente": "11222333000181",
  "serie": 1, "numero": 42, "chave": "3526…(44 dígitos)", "protocolo": "135260000012345",
  "valor_total": "99.80", "destinatario_documento": "52998224725", "ambiente": "producao",
  "last_error_code": null, "last_error": null, "origem": "api",
  "criada_em": "…", "autorizada_em": "…", "cancelada_em": null
}
```

O número é reservado na hora do `POST`. Nota `rejected` guarda o número; para liberar o número, inutilize pelo painel.

### 7.4 Consultar, cancelar, baixar

- `GET /v1/nfe/{id}` e `GET /v1/nfe?external_id={id}&cnpj_emitente={cnpj}`.
- `POST /v1/nfe/{id}/cancel` com `{ "justificativa": "texto de 15 a 255 caracteres" }`. Só nota `authorized`; senão
  `409 NFE_NAO_CANCELAVEL`. Resposta `202` com `status: "cancel_requested"`; o webhook avisa `nfe.cancelada`.
- `GET /v1/nfe/{id}/danfe` (PDF) e `GET /v1/nfe/{id}/xml` (`nfeProc` autorizado). Antes da autorização: `409 NOT_ISSUED`.

Carta de correção e inutilização: por enquanto, só pelo painel.

### 7.5 Ambiente

A NF-e segue o ambiente da empresa: `producao_restrita` vira **homologação** na Sefaz (sem valor fiscal).

### 7.6 Situação da empresa para NF-e

| `nfe.bloqueio` | O que falta |
|---|---|
| `NFE_SEM_IE` | Inscrição estadual (painel). |
| `NFE_SEM_ENDERECO` | Endereço (painel). |
| `NFE_SEM_SERIE` | Série e próximo número (painel). |
| `NFE_CERT_MISSING` | A1 da própria empresa. |
| `NFE_NAO_CONFERIDA` / `NFE_CONFERIR_DE_NOVO` | Clicar em "Conferir na Sefaz" no painel. |
| `NFE_NAO_CREDENCIADA` | A empresa não está credenciada para NF-e na Sefaz da UF. |
| `NFE_REGIME_NAO_SUPORTADO` | NF-e só para Simples e MEI. |
| outros | Ver `error.message` do `409`. |

---

## 8. Webhook de retorno

### 8.1 Quando chega

Um `POST` na URL cadastrada no painel quando **qualquer nota de qualquer empresa da conta** chega a um destes estados
(inclusive notas pedidas pelo WhatsApp ou pelo painel; filtre por `origem` se quiser):

| `evento` | Quando |
|---|---|
| `nfse.emitida` | NFS-e autorizada pela Sefin. |
| `nfse.recusada` | A Sefin recusou a DPS (`last_error_code` e `last_error` dizem o motivo). |
| `nfse.cancelada` | Cancelamento registrado. |
| `nfse.cancelamento_recusado` | A Sefin recusou o cancelamento; a nota continua valendo. |
| `nfe.autorizada` | NF-e autorizada. |
| `nfe.rejeitada` | NF-e rejeitada pela Sefaz. |
| `nfe.denegada` | NF-e denegada (irregularidade fiscal do emitente ou destinatário). |
| `nfe.cancelada` | Cancelamento de NF-e registrado. |
| `teste` | Botão **Testar** do painel. |

### 8.2 Requisição

```
POST https://seu-sistema.com.br/nofiscal/webhook
content-type: application/json
user-agent: nofiscal-webhook/1
x-nofiscal-signature: sha256=5d2c…(64 hex)
x-nofiscal-evento: nfse.emitida
x-nofiscal-entrega: 3f6c2b1e-…(uuid)
x-nofiscal-tentativa: 1
```

Corpo: o evento + o objeto da nota (`nfse` ou `nfe`, campos no topo), **como estava no momento do evento**:

```json
{
  "evento": "nfse.emitida",
  "recurso": "nfse",
  "entrega_id": "3f6c2b1e-8d1f-4a51-9a63-2a5d6f3b9c10",
  "enviado_em": "2026-11-18T13:06:05.120Z",
  "id": "6b0c0a8e-3a8e-4b46-9f0d-3c8b7c8f2a11",
  "external_id": "venda-000123",
  "status": "issued",
  "cnpj_prestador": "11222333000181",
  "numero": "1234",
  "chave_acesso": "3550308…",
  "valor": "150.00",
  "last_error_code": null,
  "last_error": null,
  "origem": "api",
  "criada_em": "2026-11-18T13:05:00.000Z",
  "emitida_em": "2026-11-18T13:06:02.000Z",
  "cancelada_em": null
}
```

O webhook não traz o PDF nem o XML: busque em `/v1/nfse/{id}/pdf` e `/xml` (ou `/v1/nfe/{id}/danfe` e `/xml`).

### 8.3 Verificar a assinatura

`x-nofiscal-signature` é `sha256=` + HMAC-SHA256 em hexadecimal dos **bytes exatos do corpo**, com o segredo do
webhook (`whsec_…`) como chave. Calcule sobre o corpo **cru**, antes de fazer parse do JSON.

Node.js:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

export function assinaturaValida(corpoCru, header, segredo) {
  const esperado = 'sha256=' + createHmac('sha256', segredo).update(corpoCru, 'utf8').digest('hex')
  const a = Buffer.from(esperado), b = Buffer.from(header ?? '')
  return a.length === b.length && timingSafeEqual(a, b)
}
// Express: app.post('/nofiscal/webhook', express.raw({ type: 'application/json' }), (req, res) => {
//   if (!assinaturaValida(req.body.toString('utf8'), req.get('x-nofiscal-signature'), process.env.NOFISCAL_WEBHOOK_SECRET)) return res.sendStatus(401)
//   const evento = JSON.parse(req.body.toString('utf8'))
//   ...grave e responda 200 em seguida; processe depois.
// })
```

Python:

```python
import hmac, hashlib

def assinatura_valida(corpo_cru: bytes, header: str, segredo: str) -> bool:
    esperado = "sha256=" + hmac.new(segredo.encode(), corpo_cru, hashlib.sha256).hexdigest()
    return hmac.compare_digest(esperado, header or "")
```

PHP:

```php
$esperado = 'sha256=' . hash_hmac('sha256', file_get_contents('php://input'), getenv('NOFISCAL_WEBHOOK_SECRET'));
if (!hash_equals($esperado, $_SERVER['HTTP_X_NOFISCAL_SIGNATURE'] ?? '')) { http_response_code(401); exit; }
```

Recomendado também: recusar eventos com `enviado_em` mais velho que 10 minutos (proteção contra reenvio malicioso).
Cada reenvio tem `enviado_em` e assinatura novos.

### 8.4 Resposta esperada e reenvio

- Responda **2xx em até 10 segundos**. Grave o evento e processe depois; não faça trabalho pesado na requisição.
- Qualquer outra resposta (ou tempo esgotado) é falha. O nó.fiscal tenta de novo depois de **1, 5, 15, 60, 240, 720
  e 1.440 minutos** — 8 tentativas em cerca de 41 horas. Depois disso, a entrega fica como "Não entregue" no painel,
  com o botão **Reenviar**.
- **Pode chegar mais de uma vez** (por exemplo, se o seu 200 se perder). Deduplique por `entrega_id` (o mesmo em
  todos os reenvios do mesmo evento) ou pelo par (`id`, `evento`).
- **A ordem não é garantida** entre eventos diferentes. Use `status` e as datas da nota; na dúvida, `GET /v1/nfse/{id}`.
- O segredo pode ser trocado no painel ("Gerar novo segredo"); o anterior deixa de valer na hora.
- Sem URL cadastrada, nenhum evento é gravado. Notas emitidas enquanto não havia URL não são reenviadas depois.

---

## 9. Status das notas

**NFS-e**

| `status` | Significado | Final? |
|---|---|---|
| `queued` | Na fila, ainda não transmitida. | não |
| `signing` | Assinando a DPS. | não |
| `sent` | Transmitida, aguardando a Sefin. Com `last_error_code: "SEFIN_UNAVAILABLE"`, a Sefin está instável e o nó.fiscal tenta de novo sozinho. | não |
| `issued` | Emitida. | sim* |
| `rejected` | Recusada pela Sefin. Corrija e mande **com outro `external_id`**. | sim |
| `cancel_requested` | Cancelamento pedido (ou recusado pela Sefin; veja `last_error`). | não |
| `cancelled` | Cancelada. | sim |
| `skipped` | Cancelada antes de ser transmitida. | sim |

\* `issued` pode virar `cancel_requested` / `cancelled` depois.

**NF-e**

| `status` | Significado |
|---|---|
| `queued`, `sending`, `processing` | Na fila, em envio ou em processamento na Sefaz. |
| `authorized` | Autorizada. |
| `rejected` | Rejeitada (o número fica com ela; inutilize pelo painel). |
| `denied` | Denegada. |
| `cancel_requested`, `cancelled` | Cancelamento pedido / registrado. |
| `voided` | Número inutilizado. |

---

## 10. Erros

Formato único:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "valor deve ser decimal positivo com até 2 casas" }, "campo": "valor" }
```

Campos extras (`campo`, `bloqueio`, `motivo`, `limite`, `problemas`) ficam **fora** de `error`, quando existem.
`message` é em português e pode ser mostrada a quem usa o seu sistema. Decida pelo `code`, nunca pelo texto.

| HTTP | `code` | Quando |
|---|---|---|
| 400 | `INVALID_JSON` | Corpo não é JSON. |
| 401 | `UNAUTHORIZED` | Chave ausente ou inválida. |
| 403 | `TENANT_INACTIVE` | Conta desativada. |
| 403 | `SO_ESCRITORIO` | Recurso do plano Escritório. |
| 403 | `SO_SANDBOX` | Rota `/v1/sandbox/…` chamada com a chave de produção. |
| 403 | `SANDBOX_SOMENTE_LEITURA` | Cadastro ou alteração de empresa com a chave sandbox. |
| 404 | `NOT_FOUND` | Rota ou nota não encontrada (inclusive nota de outra conta). |
| 404 | `EMPRESA_NAO_ENCONTRADA` | CNPJ não é de nenhuma empresa da conta. |
| 405 | `METHOD_NOT_ALLOWED` | Método errado para a rota. |
| 409 | `EMISSAO_BLOQUEADA` | A empresa não pode emitir agora (`bloqueio`). |
| 409 | `EMPRESA_INATIVA` | Empresa desativada na conta. |
| 409 | `NOT_ISSUED` | PDF/XML de nota ainda não emitida. |
| 409 | `CNPJ_JA_CADASTRADO` | CNPJ em outra conta. |
| 409 | `EMPRESAS_ACIMA_DO_LIMITE` | Plano no máximo de empresas (`limite`). |
| 409 | `PROCURACAO_RECUSADA` | Ver `motivo` em [5.4](#54-get-v1empresascnpj-e-patch-v1empresascnpj). |
| 409 | `NFE_NAO_CANCELAVEL` | NF-e que não está autorizada. |
| 422 | `VALIDATION_FAILED` | Campo inválido (`campo`, às vezes `motivo` ou `problemas`). |
| 422 | `UNKNOWN_FIELD` | Campo não aceito. |
| 422 | `CNPJ_NAO_ENCONTRADO` / `CNPJ_INATIVO` / `FORA_DO_SIMPLES` | Resposta da Receita no cadastro. |
| 422 | `REGIME_A_DECLARAR` | CNPJ fora do Simples: informe `regime` (`presumido` ou `real`). |
| 500 | `INTERNAL` | Erro do nó.fiscal. Pode repetir (idempotente). |
| 501 | `SANDBOX_SEM_NFE` | NF-e com a chave sandbox (ainda sem sandbox de NF-e). |
| 503 | `RECEITA_INDISPONIVEL` | Consulta de CNPJ fora do ar. Tente de novo. |

**Recusas da Sefin** (não são erro HTTP: chegam no webhook `nfse.recusada` e em `last_error_code`). Exemplos comuns:
`E0718` (assinatura não reconhecida: confira a procuração no portal da Receita) e `E0822` (cancelamento fora do
prazo do município). O texto da Sefin vem sempre em `last_error`.

---

## 11. Idempotência e reenvio

- `external_id` é único **por empresa** (`cnpj_prestador` / `cnpj_emitente`). Repetir o `POST` com o mesmo valor
  devolve a mesma nota, com `202`, **sem** criar outra e **sem** comparar o conteúdo.
- Use o identificador da venda/fatura do seu sistema. Se a nota for recusada e você corrigir os dados, mande com um
  `external_id` novo (por exemplo, `venda-000123-2`).
- Em erro de rede ou `5xx`, repita o mesmo `POST` com o mesmo `external_id`, ou consulte
  `GET /v1/nfse?external_id=…&cnpj_prestador=…`.
- Pedidos ao mesmo tempo com o mesmo `external_id` devolvem a mesma nota.

---

## 12. Limites

- **Franquia de notas:** a do plano da conta, somando NFS-e e NF-e de todas as empresas. Passou da franquia, a nota
  **sai normalmente** e a resposta traz um texto em `avisos`.
- **Empresas:** o máximo de empresas ativas do plano Escritório (resposta `409 EMPRESAS_ACIMA_DO_LIMITE`).
- **Tamanho do corpo:** até 4 MB por requisição.
- **Ritmo:** não há limite por minuto hoje. Recomendamos até 5 requisições por segundo e uma fila no seu lado para
  lotes grandes (a emissão é assíncrona: mandar mais rápido não emite mais rápido).
- **Procuração:** até 5 declarações por hora por empresa.
- **Tempo de emissão:** a fila roda a cada minuto; com a Sefin normal, a nota fica pronta em 1 a 3 minutos.

---

## 13. White label: o que leva a marca da nó

A conta do parceiro é uma **conta parceira (white label)**, ligada pela nó no contrato. Nela, **nada com a marca da
nó chega aos clientes do parceiro**: o parceiro monta a tela, o layout e a entrega; a nó fornece as funções pela API.

| O que | Na conta parceira |
|---|---|
| E-mail de nota (emitida, cancelada) ao tomador, ao contador e à conta | **Não sai.** O seu sistema entrega, avisado pelo webhook. A caixa "A nó manda as notas por e-mail" fica travada. |
| WhatsApp de nota (emitida, recusada, cancelada, fila da Sefin) | **Não sai**, nem para nota pedida pelo painel. |
| DANFSe e DANFE (PDF) | Sem rodapé, logo ou menção à nó, nem nos metadados do arquivo (produtor "DANFSe"/"DANFE"). |
| XML da NFS-e | Versão do aplicativo neutra (`EmissorNFSe-1.0`). |
| XML da NF-e | Versão do aplicativo neutra (`Emissor NF-e 1.0`). **Exceção legal:** o grupo de responsável técnico (`infRespTec`) leva o CNPJ e o contato da nó, que fez o software emissor (NT 2018.005). Esse grupo não aparece no DANFE. |
| Webhook | Headers `x-nofiscal-*`: só o seu servidor vê. |
| Avisos à conta (certificado vencendo, limite do plano, cobrança) | Continuam indo ao escritório (e-mail e WhatsApp da conta), nunca às empresas clientes. |
| Painel, cadastro, procuração | Domínio e marca da nó; usados só pelo escritório. O cliente final não precisa entrar no painel. |

Fora da conta parceira, a caixa **"A nó manda as notas por e-mail"** (aba API) desliga só os e-mails de nota, e nota
pedida pela API nunca gera WhatsApp por nota.

## 14. Checklist da integração

- [ ] Chave guardada no cofre do servidor; nunca no front.
- [ ] Toda chamada com `x-api-key` e `content-type: application/json`.
- [ ] `external_id` = id da venda no seu sistema; repetir em caso de erro de rede.
- [ ] `cnpj_prestador` em toda NFS-e de empresa cliente.
- [ ] Antes de emitir, conferir `GET /v1/empresas/{cnpj}` → `situacao == "pronta"` (ou tratar `409 EMISSAO_BLOQUEADA`).
- [ ] Endpoint de webhook: corpo cru, assinatura conferida, resposta 2xx em menos de 10 s, deduplicação por `entrega_id`.
- [ ] Em `nfse.emitida`: baixar PDF e XML e entregar ao cliente.
- [ ] Em `nfse.recusada`: mostrar `last_error` e permitir reemitir com novo `external_id`.
- [ ] Rotina diária que consulta notas que ficaram em `queued`/`sent` há mais de 1 hora (rede caída do seu lado).
- [ ] No sandbox: os três valores mágicos (`1.11`, `2.22`, `3.33`), o erro de leiaute e o webhook sandbox tratados.
- [ ] Testar tudo com uma empresa em `producao_restrita` antes de virar para `producao`.

---

## 15. Sandbox, produção restrita e chave de produção

O caminho até a primeira nota de verdade tem três etapas. Cada uma testa uma coisa que a anterior não testa.

| Etapa | Chave | O que prova | Risco fiscal |
|---|---|---|---|
| 1. Sandbox | `nfk_test_…` | O seu código: chamadas, validação, status, webhook, PDF, cancelamento. | Nenhum: nada vai à Sefin. |
| 2. Produção restrita | `nfk_…` de uma conta de homologação | O certificado A1 real de um CNPJ seu e a Sefin de verdade, no ambiente de testes dela. | Nenhum: nota sem validade jurídica. |
| 3. Produção | `nfk_…` da sua conta | Notas reais. | Nota fiscal de verdade. |

### 15.1 Sandbox (chave `nfk_test_`)

A chave sandbox é gerada pela nó para a sua conta e entregue por canal seguro. Ela usa **a mesma base**, **as mesmas
rotas** e **a mesma validação** da chave de produção, mas:

- **nada vai à Sefin**, nada usa certificado A1, nenhuma nota tem validade;
- a nota **não consome franquia**, não usa a numeração de DPS das empresas e **não aparece** no painel nem nos
  relatórios;
- a chave de produção **não enxerga** nota sandbox e a chave sandbox **não enxerga** nota real (`404`);
- as notas sandbox são das **empresas já cadastradas** na sua conta (o mesmo `cnpj_prestador`), com o código de
  serviço, o regime e a retenção padrão delas.

**O que é igual à produção:** o corpo do `POST /v1/nfse` (campos, `UNKNOWN_FIELD`, retenção, `external_id`
idempotente por empresa), a montagem da DPS no leiaute oficial (o erro de leiaute vira `rejected` com
`last_error_code: "DPS_INVALID"`, como na produção), o objeto `nfse`, os status, o cancelamento, o PDF, o XML e o
formato e a assinatura do webhook.

**O que muda:**

| | Sandbox |
|---|---|
| Objeto `nfse` | Traz `"ambiente": "sandbox"`. |
| Bloqueio por A1, procuração ou assinatura | Não barra: a nota sai e `avisos` diz o que barraria na produção (`Sandbox: em produção esta nota seria barrada agora (CERT_MISSING)…`). Falta de dados fiscais da empresa (`FISCAL_CONFIG_MISSING`) barra igual à produção. |
| Tempo | A "Sefin" do sandbox responde em cerca de **3 segundos**. |
| Chave de acesso e XML | Simulados, no formato da Sefin, ambiente de produção restrita (`tpAmb` 2), série da DPS `49999`. A DPS dentro do XML não é assinada. |
| PDF | DANFSe com a tarja **"NFS-e SEM VALIDADE JURÍDICA"**. |
| `GET`, `POST` e `PATCH /v1/empresas` | Só `GET` (consulta). `POST` e `PATCH` respondem `403 SANDBOX_SOMENTE_LEITURA`: cadastrar empresa ou declarar procuração muda a conta real, então isso se faz pelo painel ou com a chave de produção. |
| NF-e (`/v1/nfe`) | Ainda sem sandbox: `501 SANDBOX_SEM_NFE`. |
| Webhook | URL e segredo **próprios do sandbox** (ver 15.2). |

**Erros provocáveis por valor mágico** (campo `valor` do `POST /v1/nfse`):

| `valor` | O que acontece | Para testar |
|---|---|---|
| `"1.11"` | A Sefin recusa: `status: "rejected"`, `last_error_code: "E0718"` (assinatura sem o certificado do emitente; na vida real, procuração não achada). Webhook `nfse.recusada`. | Tela de nota recusada e reemissão com novo `external_id`. |
| `"2.22"` | A Sefin fica fora do ar por ~1 minuto: a nota continua `queued` com `last_error_code: "SEFIN_UNAVAILABLE"` e depois sai `issued`. | Nota que demora; consulta periódica; nenhum webhook até o fim. |
| `"3.33"` | A nota sai, mas o **cancelamento é recusado**: fica `cancel_requested` com `last_error_code: "SANDBOX_CANCELAMENTO_RECUSADO"`. Webhook `nfse.cancelamento_recusado`. | Tratamento de cancelamento recusado. |

Qualquer outro valor emite normalmente. Para provocar **erro de leiaute**, mande o tomador com o mesmo CNPJ da
empresa (`tomador.cnpj` = `cnpj_prestador`): a nota vem `rejected` com `DPS_INVALID` e
`last_error: "tomador é o próprio prestador"`.

### 15.2 Webhook do sandbox

A URL de produção (aba API do painel) não recebe nada do sandbox. A URL do sandbox se cadastra com a própria chave
sandbox:

```
GET /v1/sandbox/webhook                       → { "ambiente": "sandbox", "webhook": { "url": …, "tem_segredo": … } }
PUT /v1/sandbox/webhook  { "url": "https://…" } → { "ambiente": "sandbox", "webhook": { … }, "segredo": "whsec_test_…" | null }
PUT /v1/sandbox/webhook  { "url": null }        → tira a URL
```

- O segredo (`whsec_test_…`) volta **uma vez só**, no primeiro `PUT` (ou com `"novo_segredo": true`).
- Mesmo corpo, mesmos headers e mesma assinatura da produção ([8](#8-webhook-de-retorno)), com
  `"ambiente": "sandbox"` no corpo e o header `x-nofiscal-ambiente: sandbox`.
- Reenvio mais curto: até 3 tentativas. Se a sua URL falhar, as novas tentativas saem na próxima chamada sua à API
  sandbox depois de 1 e de 5 minutos (o sandbox não tem fila rodando o tempo todo).
- Com a chave de produção, `/v1/sandbox/…` responde `403 SO_SANDBOX`.

### 15.3 Produção restrita com o A1 real

Quando o sandbox estiver redondo, a nó prepara uma conta de **homologação** com **um CNPJ seu** e o **certificado A1
real** dele, apontada para a **produção restrita** da Sefin (o ambiente de testes oficial). Ali a nota é assinada e
transmitida de verdade, mas não tem validade jurídica (o DANFSe sai com a mesma tarja). Essa etapa prova o que o
sandbox não prova: certificado, procuração e a resposta real da Sefin. A chave dessa conta é uma `nfk_…` comum.

### 15.4 Chave de produção

Depois da rodada em produção restrita, gere a chave de produção no painel ([2](#2-do-zero-à-primeira-nota)),
cadastre o webhook de produção e troque a chave no seu servidor. A chave sandbox continua valendo para os seus testes
(e as notas sandbox continuam separadas); peça à nó para revogá-la quando não precisar mais.
