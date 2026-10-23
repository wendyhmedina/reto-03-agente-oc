// Servidor HTTP: API del chat + front estático. Un solo comando: `bun run dev`.
import { readFile } from "node:fs/promises"
import { join, extname } from "node:path"
import { crearAdaptador } from "./llm/index.ts"
import { ejecutarTurno, type ConfigCiclo } from "./agent/ciclo.ts"
import { obtenerSesion, guardarSesion, idSesionValido, enCola } from "./agent/sesiones.ts"
import { exigirConfirmacionRegistrada } from "./core/confirmaciones.ts"
import { resumenControl } from "./core/registro.ts"
import { listarCasos } from "./core/fixtures.ts"
import { casoValido, rutas } from "./core/rutas.ts"

const DIR = join(import.meta.dir, "..")
const env = process.env
const num = (v: string | undefined, def: number) => (v && Number.isFinite(Number(v)) ? Number(v) : def)

const PUERTO = num(env.PORT, 3000)
const MAX_MENSAJE = 2000
const ACCESS_KEY = env.APP_ACCESS_KEY ?? ""
const { llm, motivo } = crearAdaptador(env)
exigirConfirmacionRegistrada(true) // en el servidor, oc_crear(confirmado) exige que la analista lo haya dicho en el chat

/** System prompt = comportamiento (agent/prompt.md) + conocimiento (src/knowledge). Se lee en cada turno: editar el .md no exige reiniciar. */
async function systemPrompt(): Promise<string> {
  const [prompt, conocimiento] = await Promise.all([
    readFile(join(DIR, "agent", "prompt.md"), "utf8"),
    readFile(join(DIR, "src", "knowledge", "ordenes-compra.md"), "utf8"),
  ])
  return `${prompt}\n\n---\n\n${conocimiento}`
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } })

const TIPOS: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" }

async function estatico(ruta: string): Promise<Response> {
  const nombre = ruta === "/" ? "index.html" : ruta.replace(/^\/+/, "")
  if (!/^[a-z0-9_-]+\.(html|js|css|svg)$/i.test(nombre)) return new Response("No encontrado", { status: 404 })
  try {
    return new Response(await readFile(join(DIR, "web", nombre)), { headers: { "content-type": TIPOS[extname(nombre)] ?? "text/plain" } })
  } catch {
    return new Response("No encontrado", { status: 404 })
  }
}

async function chat(req: Request): Promise<Response> {
  if (!llm) return json({ error: `El agente no tiene modelo configurado: ${motivo}` }, 503)
  let body: { sessionId?: unknown; message?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return json({ error: "El cuerpo debe ser JSON: { sessionId, message }." }, 400)
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : ""
  const message = typeof body.message === "string" ? body.message.trim() : ""
  if (!idSesionValido(sessionId)) return json({ error: "sessionId inválido (6–64 caracteres alfanuméricos, - o _)." }, 400)
  if (!message) return json({ error: "El mensaje está vacío." }, 400)
  if (message.length > MAX_MENSAJE) return json({ error: `El mensaje supera ${MAX_MENSAJE} caracteres.` }, 400)

  const cfg: ConfigCiclo = {
    llm, system: await systemPrompt(), directory: DIR,
    maxIteraciones: num(env.MAX_ITERACIONES, 25),
    maxTokensSesion: num(env.MAX_TOKENS_SESION, 300_000),
    maxTokensRespuesta: num(env.MAX_TOKENS_RESPUESTA, 2048),
    timeoutMs: num(env.LLM_TIMEOUT_MS, 60_000),
  }
  const resultado = await enCola(sessionId, async () => {
    const s = await obtenerSesion(DIR, sessionId)
    const ts = new Date().toISOString()
    s.historial.push({ rol: "usuario", texto: message, ts })
    const r = await ejecutarTurno(s, message, cfg)
    s.historial.push({ rol: "agente", texto: r.reply, ts: new Date().toISOString(), toolCalls: r.toolCalls, needsConfirmation: r.needsConfirmation, pendientes: r.pendientes, error: r.error })
    await guardarSesion(DIR, s)
    return { ...r, tokens: s.tokens }
  })
  return json(resultado)
}

function autorizado(req: Request): boolean {
  // Header para la API; parámetro ?k= para los enlaces de evidencia que abre el navegador.
  return !ACCESS_KEY || req.headers.get("x-access-key") === ACCESS_KEY || new URL(req.url).searchParams.get("k") === ACCESS_KEY
}

async function rutear(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const p = url.pathname
  if (p === "/api/health") {
    return json({ ok: true, provider: llm?.provider ?? null, model: llm?.model ?? null, configurado: Boolean(llm), motivo: llm ? undefined : motivo, requiereClave: Boolean(ACCESS_KEY) })
  }
  if (p.startsWith("/api/") && !autorizado(req)) return json({ error: "Clave de acceso inválida." }, 401)

  if (p === "/api/chat" && req.method === "POST") return chat(req)
  const sesion = p.match(/^\/api\/sessions\/([^/]+)$/)
  if (sesion && req.method === "GET") {
    const id = decodeURIComponent(sesion[1]!)
    if (!idSesionValido(id)) return json({ error: "sessionId inválido." }, 400)
    const s = await obtenerSesion(DIR, id)
    return json({ id: s.id, creada: s.creada, historial: s.historial, tokens: s.tokens, pendientes: s.pendientes })
  }
  if (p === "/api/casos") return json({ casos: await listarCasos(DIR) })
  if (p === "/api/control") return json(await resumenControl(DIR))
  const ev = p.match(/^\/api\/evidencia\/([^/]+)\/(aprobacion\.(pdf|txt)|payload\.json|trazabilidad\.json)$/)
  if (ev) {
    const caso = decodeURIComponent(ev[1]!)
    if (!casoValido(caso)) return json({ error: "Caso inválido." }, 400)
    try {
      const tipo = ev[3] === "pdf" ? "application/pdf" : ev[3] === "txt" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8"
      return new Response(await readFile(join(rutas.outCaso(DIR, caso), ev[2]!)), { headers: { "content-type": tipo } })
    } catch {
      return json({ error: "Ese archivo aún no se ha generado." }, 404)
    }
  }
  if (p.startsWith("/api/")) return json({ error: "Ruta no encontrada." }, 404)
  return estatico(p)
}

Bun.serve({
  port: PUERTO,
  idleTimeout: 255, // un turno con varias herramientas puede tardar
  async fetch(req) {
    try {
      return await rutear(req)
    } catch (e) {
      console.error("Error no controlado:", (e as Error).message)
      return json({ error: "Error interno del servidor." }, 500)
    }
  },
})

console.log(`Agente OC escuchando en http://localhost:${PUERTO} · modelo: ${llm ? `${llm.provider}/${llm.model}` : `sin configurar (${motivo})`}`)
