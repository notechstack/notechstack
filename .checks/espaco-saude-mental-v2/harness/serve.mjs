// Servidor estático local do harness (Node puro, sem dependências).
// Uso: node serve.mjs [porta]   (padrão 5317; só 127.0.0.1)
//   /            -> app/public
//   /__harness/  -> esta pasta
import http from 'node:http'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const PUBLIC = path.join(ROOT, 'app', 'public')
const PORT = Number(process.argv[2]) || 5317

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

function resolveTarget(urlPath) {
  let decoded
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('..') || decoded.includes('\0')) return null
  if (decoded.startsWith('/__harness/')) {
    return { base: HERE, rel: decoded.slice('/__harness/'.length) }
  }
  if (decoded === '/__harness') return { base: HERE, rel: '' }
  return { base: PUBLIC, rel: decoded.replace(/^\/+/, '') }
}

async function send(res, file) {
  const ext = path.extname(file).toLowerCase()
  const type = TYPES[ext] || 'application/octet-stream'
  const stat = await fs.stat(file)
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  })
  createReadStream(file).pipe(res)
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
    const target = resolveTarget(url.pathname)
    if (!target) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden')
      return
    }
    let file = path.resolve(target.base, target.rel)
    if (!file.startsWith(target.base)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden')
      return
    }
    let stat = await fs.stat(file).catch(() => null)
    if (stat?.isDirectory()) {
      file = path.join(file, 'index.html')
      stat = await fs.stat(file).catch(() => null)
    }
    if (!stat?.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
      return
    }
    await send(res, file)
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('error')
    console.error(error)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`harness em http://127.0.0.1:${PORT}/__harness/index.html`)
  console.log(`public: ${PUBLIC}`)
})
