// A1 de teste para a demonstração: PKCS#12 autoassinado, gerado na hora, com o CN no formato ICP-Brasil
// "NOME:CNPJ" (é o que a rota do certificado confere). Nenhum A1 real entra no repositório. node-forge vem do app/.
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exigir = createRequire(resolve(raiz, 'app', 'package.json'));

export const SENHA_A1_DEMO = 'demo1234';

export function gerarA1({ cnpj, nome = 'EMPRESA DEMO', senha = SENHA_A1_DEMO, validadeDias = 365, forge = exigir('node-forge') }) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });
  const chave = forge.pki.privateKeyFromPem(privateKey);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = '01' + randomBytes(8).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + validadeDias * 86400000);
  const attrs = [
    { name: 'commonName', value: `${nome}:${String(cnpj).replace(/\D/g, '')}` },
    { name: 'countryName', value: 'BR' },
    { name: 'organizationName', value: 'ICP-Brasil (demonstração)' }
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, keyEncipherment: true }]);
  cert.sign(chave, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(chave, [cert], senha, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}
