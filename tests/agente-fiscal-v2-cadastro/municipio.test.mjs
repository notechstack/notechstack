// Regra de município do cadastro, sem banco: MEI e Simples ME/EPP passam em qualquer município
// (Anexo I v1.01 E0037-E0039 para o MEI; Res. CGSN 191/2026 para a ME/EPP desde 01/11/2026).
import test from "node:test";
import assert from "node:assert/strict";
import { municipioAtendido, padraoNacional } from "../../supabase/functions/_shared/fiscal/cnpj.ts";
import { LISTA_MUNICIPIOS } from "../../supabase/functions/_shared/fiscal/municipios.ts";

const BRAGANCA = "3507605"; // conveniado, com emissor próprio: fora da lista de 28/09/2026
const SAO_PAULO = "3550308";

test("a lista real continua sem Bragança Paulista", () => {
  assert.equal(padraoNacional(BRAGANCA, LISTA_MUNICIPIOS), false);
  assert.equal(padraoNacional(SAO_PAULO, LISTA_MUNICIPIOS), true);
});

test("MEI e Simples ME/EPP são atendidos em qualquer município, dentro ou fora da lista", () => {
  for (const regime of ["mei", "simples"]) {
    for (const ibge of [BRAGANCA, SAO_PAULO, "4106902"]) {
      assert.equal(municipioAtendido({ regime, codigo_municipio_ibge: ibge }, LISTA_MUNICIPIOS), true, `${regime} ${ibge}`);
    }
  }
});
