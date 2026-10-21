# Agente Fiscal v2 — Lote P: pesquisas e dados

Consultado em **21/10/2026**. Escopo: P1–P4 e Unresolved 1–3. Fontes primárias; nenhuma chamada autenticada, emissão ou operação de pagamento foi realizada. Esta cópia versionada corresponde ao relatório solicitado em `C:/Users/lucca/projetos/.design/agente-fiscal-v2-pesquisas.md`. Os testes conferem os dados e a estrutura documental, não provam integração em produção.

## (a) Série e numeração da DPS; municípios e códigos nacionais

**Resposta:** para aplicativo próprio, usar uma série entre **00001 e 49999**. Para um emitente que só usou web/app nacional, a sugestão de integração é `serie: "1"`, `proximo_numero: 1`; essa escolha está em faixa diferente da usada por aqueles emissores. Isso não garante ausência de colisão com outros aplicativos próprios que já tenham emitido para o mesmo CPF/CNPJ e município. Nesse caso, reservar uma série ainda não usada ou reconciliar o histórico antes de iniciar. Não há série nacional exclusiva da Nó.

Fonte: [Anexo I v1.01 de 09/02/2026](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/anexo_i-sefin_adn-dps_nfse-snnfse-v1-01-20260209.xlsx), aba `LEIAUTE DPS_NFS-e`, célula I106; aba `RN DPS_NFS-e`, regras E0010 e E0014.

> 00001 a 49999 - Emissão com aplicativo pŕoprio;

Grafia preservada da planilha. As outras faixas são 50000–69999 (móvel), 70000–79999 (web) e 80000–89999 (transcrição manual). E0010 rejeita série incompatível com o emissor. E0014 verifica a combinação série, número, município emissor e inscrição federal contra NFS-e já gerada. A numeração da DPS é controlada pelo aplicativo; não é o número da NFS-e atribuído pelo servidor. O motor lido em `app/api/_lib/dps-builder.ts` já valida a faixa própria e número de 1 a 999999999999999. A escolha de iniciar em 1 é **inferência operacional**, condicionada a série não utilizada; não há recomendação oficial de uma série específica por software. Não encontrei endpoint oficial que forneça o próximo número livre. Não alterar o contador após timeout sem reconciliar o resultado da emissão.

### Dados entregues e método de extração (P1–P3)

**Municípios:** 2.875 códigos IBGE em strings de sete dígitos. Fonte principal: [planilha oficial de adesões de 28/09/2026](https://www.gov.br/nfse/pt-br/municipios/monitoramento-adesoes/municipios-aderentes-20260928.xlsx), vinculada no [monitoramento oficial](https://www.gov.br/nfse/pt-br/municipios/monitoramento-adesoes). Trechos dos cabeçalhos da planilha:

> StatusConvenioSEFIN | AderenteEmissorNacional

Filtro exato: coluna E = `Conveniado Ativo` **e** G = `Sim`. A planilha tem 5.571 registros; não foram usados simplesmente todos os conveniados nem a coluna F (`AderenteAmbienteNacional`). Quando preenchida, a data de início de vigência deve ser até a consulta: nenhum registro selecionável tinha data futura. Muquém do São Francisco/BA e Graccho Cardoso/SE têm vigência vazia, mas adesão `Sim` e convênio ativo; foram incluídos com base nesses indicadores explícitos. O arquivo é um retrato da publicação de setembro consultada em outubro, não uma consulta cadastral em tempo real nem garantia de autorização individual do contribuinte. MEI e adesões parciais por regime podem exigir tratamento próprio: uma lista binária municipal não representa essas exceções. Não incluí municípios por notícia de obrigação futura nem por inferência sobre o Simples.

A fonte não contém IBGE. O código foi obtido por UF + nome no [Anexo A oficial](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/anexo_a-municipio_ibge-paises_iso2-v1-00-snnfse-20251210.xlsx), aba `TAB.MUN_IBGE`, coluna D. Algumas siglas da coluna B estão vazias; resolvidas pelos dois primeiros dígitos do código e pela [API de estados do IBGE](https://servicodados.ibge.gov.br/api/v1/localidades/estados). Essa estrutura é descrita na [tabela de códigos do IBGE](https://www.ibge.gov.br/explica/codigos-dos-municipios.php). Normalização: caixa, acentos e pontuação; sem aproximação automática de nomes.

Dez divergências foram conciliadas explicitamente com os nomes/códigos do Anexo A; a [API de municípios do IBGE](https://servicodados.ibge.gov.br/api/v1/localidades/municipios) também foi consultada para conferir grafias atuais:

| UF | Nome na adesão | Nome no Anexo A | IBGE |
| --- | --- | --- | --- |
| GO | Bom Jesus | Bom Jesus de Goiás | 5203500 |
| BA | Lagedo do Tabocal | Lajedo do Tabocal | 2919058 |
| RN | Assu | Açu | 2400208 |
| RN | Boa Saúde | Januário Cicco | 2405306 |
| TO | São Valério da Natividade | São Valério | 1720499 |
| MG | Barão do Monte Alto | Barão de Monte Alto | 3105509 |
| MG | Dona Euzebia | Dona Eusébia | 3122900 |
| SP | São Luiz do Paraitinga | São Luís do Paraitinga | 3550001 |
| PR | Munhoz de Mello | Munhoz de Melo | 4116307 |
| SE | Graccho Cardoso | Gracho Cardoso | 2802601 |

As equivalências históricas não triviais estão no IBGE: [Bom Jesus/Bom Jesus de Goiás](https://www.ibge.gov.br/biblioteca/visualizacao/dtb/goias/bomjesusdegoias.pdf), [Boa Saúde/Januário Cicco](https://www.ibge.gov.br/biblioteca/visualizacao/dtb/riograndedonorte/januariocicco.pdf) e [São Valério e Graccho Cardoso, tabela de alterações toponímicas, p. 11](https://geoftp.ibge.gov.br/cartas_e_mapas/bases_cartograficas_continuas/bcim/versao2016/informacoes_tecnicas/documentacao_tecnica/DocTecnica_BCIM_VOL_I_03nov16.pdf). As demais diferenças são grafias das fontes conciliadas, não códigos criados por similaridade.

**Serviços:** 338 registros da aba `LISTA.SERV.NAC.` do [Anexo B v1.01 de 22/01/2026](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/anexo_b-nbs2-lista_servico_nacional-snnfse-v1-01-20260122.xlsx), colunas A e E. Entraram somente linhas com código de tributação nacional preenchido; títulos de item/subitem e a aba de NBS não entraram. Códigos numéricos de cinco dígitos foram completados à esquerda para seis; descrições preservadas, retirando somente espaços nas extremidades. Exemplo confirmado: `040101`, `Medicina.`. A listagem oficial vigente foi encontrada na [Documentação Atual](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual).

**CNAE:** não encontrei uma correlação **nacional oficial CNAE → cTribNac** utilizável. `cnae-servico.json` contém `fonte: null` e `cnae: {}`. Pesquisei `site:gov.br/nfse CNAE correlação tabela`, a documentação atual, o Anexo B e o [Anexo VIII v1.01.00](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc/anexoviii-correlacaoitemnbsindopcclasstrib_ibscbs_v1-01-00.xlsx); não há CNAE nas strings dessas duas planilhas. O VIII correlaciona item de serviço, NBS, cClassTrib e cIndOp. A [página RTC](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc) ressalva:

> Este Anexo é apenas um trabalho inicial, ainda em desenvolvimento;

Há correlações municipais, como [CNAE-BH × CTISS](https://bhissdigital.pbh.gov.br/atde/pages/correlacaoTributacaoMunicipal.jsf), mas elas não constituem tabela nacional CNAE → cTribNac. Não transformei o exemplo `8630503 → 040101` em dado oficial. Para a etapa 5, permanece a busca textual de serviço, sem sugestão por CNAE. Isso registra o resultado da busca, não uma prova universal de inexistência.

**Reprodução:** `python tests/agente-fiscal-v2-dados/extrair-dados.py` confere as fontes sem gravar; `--gravar` atualiza somente os dois JSON extraídos e a data. O script aborta antes de gravar se houver correspondência municipal pendente ou código duplicado. O JSON de CNAE vazio exige pesquisa nova para ser alterado. SHA-256 dos downloads desta consulta:

| Documento | SHA-256 |
| --- | --- |
| Municípios 20260928 | `53620c40387aefcc4ff48c26667dca16513550a1f036999b0208a51066ea912a` |
| Anexo A 20251210 | `238b715ab2dcc2c9e0857c44d69048e0af806b45ec8499568342de4a37f4419d` |
| Anexo B 20260122 | `e74b0be8ad204e458932efb1716225a3fb5703a84e5475ce5c4c6789d1c61b1a` |

## (b) API de distribuição do ADN para o contribuinte

**Resposta:** o [manual atual dos contribuintes, versão 1.0 de 12/02/2026, p. 3](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/manual-contribuintes-apis-adn-sistema-nacional-nfse.pdf) confirma acesso aos documentos em que o contribuinte aparece como emitente, tomador ou intermediário:

> serviços em que figure como emitente, tomador ou intermediário.

Portanto, contempla notas do próprio CNPJ como emitente. O mesmo manual permite certificado com a mesma raiz de CNPJ e menciona parâmetro adicional para consultar outra inscrição dessa raiz, mas **não informa o nome desse parâmetro**. Não assumir que seja `cnpj` sem consultar o contrato autenticado. Para importar clientes, filtrar as notas em que o CNPJ do tenant é prestador; notas recebidas não identificam necessariamente clientes.

Bases derivadas dos caminhos dos Swagger publicados no [diretório oficial de APIs](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/apis-prod-restrita-e-producao):

| Ambiente | Base | Documentação |
| --- | --- | --- |
| Produção | `https://adn.nfse.gov.br/contribuintes` | https://adn.nfse.gov.br/contribuintes/docs/index.html |
| Produção restrita | `https://adn.producaorestrita.nfse.gov.br/contribuintes` | https://adn.producaorestrita.nfse.gov.br/contribuintes/docs/index.html |

O manual atual lista **GET `/DFe/{NSU}`** e **GET `/NFSe/{ChaveAcesso}/Eventos`**. Não usar a API de municípios para essa finalidade.

**Autenticação e formato:** o [Manual Integrado v1.00.02, §§6.1.1–6.1.3, pp. 23–24](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/leiaute-e-esquemas-antigos/manualintegradosnnfse_v1-00-02-producao.pdf) descreve mTLS, certificado ICP-Brasil A1 ou A3 com autenticação de cliente, mensagens JSON e documentos XML UTF-8 compactados:

> GZip com representação base64binary.

O A1 do emitente é compatível com esse mecanismo; a autorização por raiz é confirmada pelo manual atual. Não encontrei exigência de Bearer token nesse fluxo. O JSON exato de resposta, nome do campo de conteúdo e envelope de erros **não foram confirmados no Swagger atual**; não assumir que o campo se chame `nfseXmlGZipB64` só porque esse é o nome na Sefin.

**Paginação e limites:** o manual antigo, §17.2.2, pp. 112–113, descreve lotes crescentes de até 50 DF-e, avanço pelo último NSU retornado e espera mínima de uma hora quando não há mais documentos. Contudo, contém uma exclusão de notas emitidas pela própria empresa, incompatível com o escopo descrito em 2026. Não tratá-lo integralmente como contrato vigente.

A [FAQ oficial de Belo Horizonte, §16.8, p. 76](https://fazenda.pbh.gov.br/BHISSDigital/PerguntasRespostas.pdf) confirma lotes de até 50 para contribuintes, mas descreve NSU inicial inclusivo e próxima consulta com último NSU **+ 1**. Já o manual nacional antigo descreve envio do último NSU conhecido. O manual nacional de 2026 não resolve essa diferença nem detalha o seletor entre consulta pontual e lote.

**Pendências delimitadas:** tentei ambos os Swagger oficiais pelo navegador de pesquisa e por HTTPS sem certificado; não obtive o contrato (falha TLS `DECRYPTION_FAILED_OR_BAD_RECORD_MAC` no acesso direto). Não consultei A1 nem arquivos de credenciais. Permanecem sem confirmação atual: seletor da consulta em lote, inclusividade do cursor, nome do parâmetro de CNPJ, envelope/campos JSON, janela de retenção e limite de requisições por tempo. O limite de 50 tem fonte municipal oficial recente; a espera de uma hora tem apenas fonte nacional antiga nesta pesquisa. Não inventar quotas nem prometer histórico completo. Para o lote de integração: validar esses detalhes em produção restrita, persistir cursor por CNPJ/ambiente somente após processar a página e deduplicar documentos; o fallback por PDF continua necessário. Essa validação não foi executada no Lote P.

## (c) Pagar.me API v5: cartão, plano/itens, cancelamento e tokenização

**Cartão:** [editar cartão da assinatura](https://docs.pagar.me/reference/editar-cart%C3%A3o-da-assinatura-1) documenta **PATCH `https://api.pagar.me/core/v5/subscriptions/{subscription_id}/card`**, com `card_id` ou `card`; sucesso 200, erros documentados 404 e 422.

> é possível atualizar o cartão utilizado para pagamento da assinatura.

Não encontrei `card_token` no contrato desse PATCH. O fluxo comprovado documentalmente para aproveitar o token do checkout é:

1. Backend chama **POST `/core/v5/customers/{customer_id}/cards`** com `{"token":"<token recebido>","billing_address":{...}}`; esse `customer_id` deve ser o da assinatura. [Criar cartão](https://docs.pagar.me/reference/criar-cart%C3%A3o) documenta `token` como alternativa aos dados do cartão. Ler `id` da resposta.
2. Backend chama o PATCH de assinatura com `{"card_id":"<id retornado>"}`. O token não é um `card_id`. Os endpoints administrativos usam Basic Auth da conta; a chave secreta fica no backend.

**Plano e itens:** não encontrei rota v5 para reatribuir `plan_id` a uma assinatura existente. A rota de atualização de assinatura com `plan_id` encontrada nas versões v3/v4 não é prova para v5. Para mudar valor/serviço da recorrência existente, a referência v5 oferece:

| Operação | Caminho relativo a `https://api.pagar.me/core/v5` | Fonte |
| --- | --- | --- |
| Incluir item | POST `/subscriptions/{subscription_id}/items` | [Incluir item](https://docs.pagar.me/reference/incluir-item-1) |
| Editar item | PUT `/subscriptions/{subscription_id}/items/{item_id}` | [Editar item](https://docs.pagar.me/reference/editar-item) |
| Remover item | DELETE `/subscriptions/{subscription_id}/items/{item_id}` | [Remover item](https://docs.pagar.me/reference/remover-item) |

No PUT, usar o identificador `si_...` do item da assinatura, `quantity`, `name`, `description` e `pricing_scheme` conforme a [precificação oficial](https://docs.pagar.me/reference/precifica%C3%A7%C3%A3o). Exemplo derivado dos preços da tarefa (não executado): `{"name":"Plano Pro","description":"Assinatura nó.fiscal Pro","quantity":1,"pricing_scheme":{"scheme_type":"unit","price":12900}}`. A mudança dos itens não comprova alteração do `plan.id` retornado pelo provedor. O plano comercial local e seus limites devem ser atualizados somente após sucesso remoto. Não encontrei garantia de prorrata nem de ajuste automático da fatura já aberta; validar o efeito no próximo ciclo. Editar `/plans/.../items/...` é outra operação, sobre o modelo de plano.

**Cancelar:** [cancelar assinatura](https://docs.pagar.me/reference/cancelar-assinatura-1) documenta **DELETE `/core/v5/subscriptions/{subscription_id}`**, sucesso 200. O corpo aceita `cancel_pending_invoices` boolean, padrão `true`, que controla faturas/cobranças pendentes. Não é agendamento. Não encontrei campo `cancel_at_period_end` nem data futura de cancelamento nessa referência. Para a decisão do projeto de manter acesso até o período pago terminar, gravar a data local e executar o DELETE pelo ciclo na data agendada; durante o teste, cancelar imediatamente. Isso é desenho da aplicação, não funcionalidade nativa comprovada do Pagar.me. O [objeto assinatura](https://docs.pagar.me/reference/assinaturas-1) expõe `current_cycle` e `next_billing_at`; conferir o ciclo real, sem calcular um mês como 30 dias fixos.

**Tokenização:** [criar token de cartão](https://docs.pagar.me/reference/criar-token-cart%C3%A3o-1) documenta **POST `https://api.pagar.me/core/v5/tokens?appId=<public_key>`** direto do navegador. Usar `Content-Type: application/json`, sem `Authorization`; domínio cadastrado na dashboard. Corpo: `type: "card"` e objeto `card` com `number`, `holder_name`, `exp_month`, `exp_year`, `cvv` (e campos opcionais documentados). A resposta 200 contém o token a ser usado pelo backend; não enviar PAN/CVV ao servidor da Nó. O endereço de cobrança não é tokenizado e precisa ser informado separadamente. Não use a secret key em `appId`.

## (d) Supabase GoTrue: verificar o email_otp de generateLink

**Resposta:** usar **`type: "email"`**, com o e-mail e o `properties.email_otp` retornado por `auth.admin.generateLink({type:'magiclink', email})`. A documentação de [verifyOtp](https://supabase.com/docs/reference/javascript/auth-verifyotp) mostra:

> const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'email'})

O [guia de autenticação por e-mail](https://supabase.com/docs/guides/auth/auth-email-passwordless) explica que OTP e magic link compartilham implementação. A confirmação específica vem do código-fonte oficial do GoTrue, consultado no commit `c3348e8f1cb31454e9783e4eb9eab1e71ad9652f`:

- [mail.go — adminGenerateLink](https://github.com/supabase/auth/blob/c3348e8f1cb31454e9783e4eb9eab1e71ad9652f/internal/api/mail.go): magiclink de usuário existente grava o hash como recovery token e devolve `email_otp`; para usuário inexistente, pode converter a operação em signup.
- [verify.go — verifyUserAndToken](https://github.com/supabase/auth/blob/c3348e8f1cb31454e9783e4eb9eab1e71ad9652f/internal/api/verify.go): o tipo `email` verifica tanto confirmation token quanto recovery token e direciona internamente para signup ou magiclink. `magiclink` também é aceito para o recovery token, mas não cobre o caso convertido em signup. Portanto `email` é a opção adequada para o fluxo unificado.

Requisição REST ilustrativa (valores substituíveis, nenhuma credencial real):

```http
POST https://<projeto>.supabase.co/auth/v1/verify
apikey: <chave pública do projeto>
Content-Type: application/json

{"type":"email","email":"pessoa@example.com","token":"<email_otp>"}
```

Enviar `token` como string para preservar zeros à esquerda; não usar `email_otp` como nome de campo do corpo. Não confundir o OTP com `hashed_token`, que usa o campo alternativo `token_hash`. A chave administrativa usada para gerar o link não vai para o navegador.

No sucesso, POST retorna **200 com sessão JSON na raiz**: `access_token`, `token_type`, `expires_in`, `expires_at`, `refresh_token`, `user`. Fonte: [AccessTokenResponse](https://github.com/supabase/auth/blob/c3348e8f1cb31454e9783e4eb9eab1e71ad9652f/internal/tokens/service.go) e o retorno de `verifyPost` em `verify.go`. O wrapper `{data:{session,user},error}` pertence ao SDK; não é o corpo REST. Código inválido/expirado é erro, não sessão. Não atribuir ao GoTrue a regra própria de cinco tentativas sem implementá-la: esta pesquisa não encontrou essa garantia para o fluxo proposto. O tamanho e a validade do OTP dependem da configuração do projeto; não foram lidos secrets ou configurações privadas nem realizado login de teste.

## (e) BrasilAPI: consulta de CNPJ e limites de uso

**Resposta:** **GET `https://brasilapi.com.br/api/cnpj/v1/{cnpj}`**, resposta JSON, sem chave de API indicada pela documentação. Fonte: [documentação BrasilAPI](https://brasilapi.com.br/docs#tag/CNPJ) e [OpenAPI CNPJ no repositório oficial](https://github.com/BrasilAPI/BrasilAPI/blob/0c229b4e56d0c8f789e1162b6a71d6ea1d54fc8b/pages/docs/doc/cnpj.json), commit consultado `0c229b4e56d0c8f789e1162b6a71d6ea1d54fc8b`.

> Código da Atividade Econômica PRINCIPAL do estabelecimento

Esse trecho descreve `cnae_fiscal`. Mapeamento para o contrato de `consultar_cnpj`:

| Campo da BrasilAPI | Tipo documentado | Uso no fiscal |
| --- | --- | --- |
| `razao_social` | string | razão social, não `nome_fantasia` |
| `municipio` | string ou null | nome do município |
| `codigo_municipio_ibge` | integer | converter/validar como string de 7 dígitos |
| `uf` | string | UF; pode ser `EX` para exterior |
| `cnae_fiscal` | integer | CNAE principal; normalizar em 7 dígitos, preservando zeros à esquerda |
| `cnae_fiscal_descricao` | string | descrição da atividade principal |

`codigo_municipio` é outro campo: não usar como IBGE. CNAEs secundários não substituem automaticamente o principal. Validar valores ausentes ou inválidos antes de consultar as listas locais. A BrasilAPI é uma fonte oficial do **próprio serviço**, não um endpoint governamental da Receita Federal; o provedor informado é Minha Receita.

O [handler oficial](https://github.com/BrasilAPI/BrasilAPI/blob/0c229b4e56d0c8f789e1162b6a71d6ea1d54fc8b/pages/api/cnpj/v1/%5Bcnpj%5D.js) e o OpenAPI documentam 200, 400 (entrada inválida), 404 (não encontrado) e 503 (indisponibilidade). O OpenAPI menciona timeout de 5 segundos do provedor; isso não é quota de chamadas. O fiscal pode traduzir a validação local para seu próprio 422 conforme a tarefa. A documentação atual admite CNPJ alfanumérico; o escopo desta tarefa continua sendo validação dos 14 dígitos, sem alteração no motor.

**Limites:** não encontrei quota numérica pública por minuto/dia nem SLA nas fontes consultadas. Os [Termos de Uso no README oficial](https://github.com/BrasilAPI/BrasilAPI/blob/0c229b4e56d0c8f789e1162b6a71d6ea1d54fc8b/README.md#termos-de-uso) dizem:

> O volume de consultas deve ter a natureza de uma pessoa real requisitando um determinado dado.

O projeto pede que não se faça crawling automatizado. Para este onboarding, consultar sob demanda, usar cache e tratar indisponibilidade; isso é recomendação de implementação, não uma franquia de uso concedida. Não foi feita consulta a CNPJ pessoal ou de cliente durante a pesquisa.
