export type ServicoRtc = { nbs: string[]; cIndOp: string[]; cClassTrib: string[] }
export type TabelaRtc = {
  fontes: Record<string, string>
  nbs_validas: string[]
  servicos: Record<string, ServicoRtc>
}
