// Conferência de dono da NFS-e devolvida pela Sefin (E0014 ou consulta por Id da DPS). Sem banco.
// Caso real (23/11/2026): LESLEI SPECIE, série 1 nº 1 e 2 já usados em 20/08/2026 pelo sistema da prefeitura.
import { describe, expect, it } from 'vitest'
import { MARGEM_DONO_MS, nfseDestaNota } from './emission.js'

const nfse = (dhEmi: string, prefixo = '') =>
  `<${prefixo}NFSe><${prefixo}infNFSe><${prefixo}nNFSe>2</${prefixo}nNFSe><${prefixo}DPS><${prefixo}infDPS>` +
  `<${prefixo}dhEmi>${dhEmi}</${prefixo}dhEmi></${prefixo}infDPS></${prefixo}DPS></${prefixo}infNFSe></${prefixo}NFSe>`

describe('nfseDestaNota', () => {
  const criadaEm = new Date('2026-11-23T13:00:54.699Z')

  it('nota de agosto com o mesmo Id de DPS não é desta nota', () => {
    expect(nfseDestaNota(nfse('2026-08-20T14:37:41+00:00'), criadaEm)).toBe(false)
  })

  it('DPS montada depois da criação é desta nota (inclusive com fuso de Brasília)', () => {
    expect(nfseDestaNota(nfse('2026-11-23T10:01:10-03:00'), criadaEm)).toBe(true)
  })

  it('aceita pequeno desvio de relógio, recusa além da folga', () => {
    const dentro = new Date(criadaEm.getTime() - MARGEM_DONO_MS + 1000).toISOString()
    const fora = new Date(criadaEm.getTime() - MARGEM_DONO_MS - 1000).toISOString()
    expect(nfseDestaNota(nfse(dentro), criadaEm)).toBe(true)
    expect(nfseDestaNota(nfse(fora), criadaEm)).toBe(false)
  })

  it('lê dhEmi com prefixo de namespace', () => {
    expect(nfseDestaNota(nfse('2026-08-20T14:32:06+00:00', 'ns2:'), criadaEm)).toBe(false)
  })

  it('sem dhEmi legível mantém o comportamento anterior (aceita)', () => {
    expect(nfseDestaNota('<NFSe><infNFSe/></NFSe>', criadaEm)).toBe(true)
    expect(nfseDestaNota(nfse('lixo'), criadaEm)).toBe(true)
  })
})
