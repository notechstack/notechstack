// Lista do lote P (municipios-padrao-nacional.json) embutida no bundle da função: import estático, sem
// leitura em tempo de execução. Landing "Lista de municípios embutida no código" (lote A).
import dados from "./municipios-padrao-nacional.json" with { type: "json" };
import { type ListaMunicipios, lerListaMunicipios } from "./cnpj.ts";

export const LISTA_MUNICIPIOS: ListaMunicipios = lerListaMunicipios(JSON.stringify(dados));
