// IP da borda e hash, copiados de auditor-acesso e diagnostico-auditor (o auditor não muda).

// Ordem: cf-connecting-ip → x-real-ip → último salto do x-forwarded-for (o primeiro o cliente forja).
export function ipDaBorda(h: Headers): string {
  const direto = h.get("cf-connecting-ip") ?? h.get("x-real-ip");
  if (direto && direto.trim()) return direto.trim();
  const saltos = (h.get("x-forwarded-for") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return saltos.at(-1) ?? "";
}

// IPv4 inteiro ou prefixo IPv6 /64.
export function chaveIp(ip: string): string {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (!s) return "sem-ip";
  const m4 = s.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (m4) return m4[1];
  if (!s.includes(":")) return s;
  const partes = s.split("::");
  if (partes.length > 2) return s;
  const esq = partes[0] ? partes[0].split(":") : [];
  const dir = partes.length === 2 && partes[1] ? partes[1].split(":") : [];
  const faltam = partes.length === 2 ? 8 - esq.length - dir.length : 0;
  if (faltam < 0) return s;
  const todos = [...esq, ...Array(faltam).fill("0"), ...dir];
  if (todos.length !== 8 || !todos.every((h) => /^[0-9a-f]{1,4}$/.test(h))) return s;
  return todos.slice(0, 4).map((h) => h.padStart(4, "0")).join(":") + "::/64";
}

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
