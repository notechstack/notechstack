# Verificação da frente D — resumo (rodada 3)

Relatório completo: `.checks/agentes-escritorio.verified.md` (Round 3, verificado em `bd2b2073`; re-verificação de `c54fbd54..bd2b2073` e do que não passou na rodada 2; perfil `light` + passo 1).

**Veredito: FAIL** · 46/46 `PASS` nas três provas, rodadas inteiras e uma de cada vez (EXIT 0) · nenhuma asserção enfraquecida · faults não rodaram (`light`)

## Lacunas, por gravidade

1. **Alta — R23 falha em 1024×768:** o painel (x=460–1000) cobre a mesa aproximada, que fica em x≈517, e a câmera se afasta ×1,80. O `C31-desktop` só mede 1440. Ver `final3-tela2-1024.png` e `final3-tela2-auditor-1024.png`.
2. **Média-alta — 1440:** a mesa fica à esquerda do painel, mas a câmera não aproxima (×0,98). O critério 12 ("aproxima essa mesa") não é afirmado na página.
3. **Média — C33:** não afirma a ausência de dado pessoal e de `content_*`, embora o código confira. Também não exercita o envio em produção. `event_source_url` leva a query string inteira.
4. **Média-baixa:** o checklist não tem linhas para R17–R23, C31-desktop e C33, e o corpo dos checks segue com valores antigos. No Unresolved 4, 6 e 7, só o status mudou.
5. **Baixa:** halo da R4 sem asserção; faixa de 769–1100 px do `.agency-partner` não copiada; arquivo de origem do logo ausente; `h1` acima da navbar na Tela 2; provas regravando PNGs.

## Fechado desde a rodada 2

- 1440: mesa e pessoa à esquerda do painel.
- R4 (círculo), R9 e R10 afirmados a partir da textura real.
- R3 substituída pela R8, com aprovação registrada.

## Conferido sem achado

- R17–R19: textos exatos; o card repete a estrutura e o CSS do `.agency-partner` com tokens, sem hex.
- R20–R21: o mesmo `event_id` chega ao dataLayer, ao Pixel e ao corpo da CAPI (o mesmo objeto do `fetch`), e a CAPI fica presa fora da produção.
- R22: o JSON do GTM é coerente. Os IDs 1001–1024 não colidem com `gtm-nofiscal-funil` nem com `gtm-compra-diagnostico`, as referências existem e o GA4 é `G-1YEB89RVER`.
- `agentes/fiscal/`, `agentes/auditor/` e `shared/` intactos.
