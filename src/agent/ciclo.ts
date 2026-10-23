// Ciclo del agente (PRD 6.3): usuario → modelo → herramientas → modelo … → respuesta.
//  CA1 tope de iteraciones por turno · CA2 valores solo desde herramientas (prompt + diseño)
//  CA3 confirmación humana registrada por el backend · CA4 toda llamada visible y en out/log.jsonl
//  CA5 errores en lenguaje claro sin matar la sesión.
import type { LlmAdapter, ToolCall } from "../llm/adapter.ts"
import { LlmError } from "../llm/adapter.ts"
import { especificaciones, ejecutarHerramienta } from "./herramientas.ts"
import { registrarConfirmacion, revocarConfirmacion } from "../core/confirmaciones.ts"
import { registrarLog } from "../core/registro.ts"
import type { Sesion, LlamadaVisible } from "./sesiones.ts"

export type ConfigCiclo = {
  llm: LlmAdapter
  system: string
  directory: string
  maxIteraciones: number
  maxTokensSesion: number
  maxTokensRespuesta: number
  timeoutMs: number
}

export type ResultadoTurno = { reply: string; toolCalls: LlamadaVisible[]; needsConfirmation: boolean; pendientes: string[]; error?: boolean }

// ------------------------------------------------------------ confirmación humana (CA3)

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()

export function esNegativa(texto: string): boolean {
  const t = sinTildes(texto)
  return /^(no\b|nop\b|cancel|rechaz|espera\b|todavia no|aun no)/.test(t) || /\bno (la |las )?(crees|crear|creen|proceda|procedas)\b/.test(t)
}

export function esAfirmativa(texto: string): boolean {
  const t = sinTildes(texto)
  if (esNegativa(t)) return false
  return /^(si\b|si,|ok\b|okay\b|dale\b|listo\b|de acuerdo|adelante|procede|proceda|confirm|creala|crealas|crear\b|aprobado|aprueb)/.test(t) || /\bconfirm(o|ado|ada|amos)\b/.test(t)
}

/** Si el turno anterior pidió confirmación, interpreta el mensaje de la analista y lo registra. */
function procesarRespuestaHumana(s: Sesion, mensaje: string): void {
  if (!s.pendientes.length) return
  const mencionados = s.pendientes.filter((c) => sinTildes(mensaje).includes(c.toLowerCase()))
  const objetivo = mencionados.length ? mencionados : s.pendientes
  if (esAfirmativa(mensaje)) for (const caso of objetivo) registrarConfirmacion(s.id, caso, `analista (sesión ${s.id.slice(0, 8)})`)
  else for (const caso of objetivo) revocarConfirmacion(s.id, caso)
  s.pendientes = []
}

/** Casos que quedaron esperando confirmación al cierre del turno. */
function casosPendientes(llamadas: LlamadaVisible[]): string[] {
  const pendientes = new Set<string>()
  for (const l of llamadas) {
    const caso = typeof l.args.caso === "string" ? l.args.caso : null
    if (!caso) continue
    const r = l.resultado as { ok?: boolean; data?: { apta?: boolean; confirmaciones?: unknown[]; numero_oc?: string }; error?: string }
    if (l.nombre === "oc_crear" && r.ok) pendientes.delete(caso)
    else if (l.nombre === "oc_crear" && r.error?.includes("confirmación explícita")) pendientes.add(caso)
    else if ((l.nombre === "oc_validar" || l.nombre === "oc_construir_payload") && r.ok && r.data?.confirmaciones?.length && r.data.apta !== false) pendientes.add(caso)
  }
  return [...pendientes]
}

// ------------------------------------------------------------ resumen visible de cada llamada

const cop = (n: unknown) => (typeof n === "number" ? `COP ${n.toLocaleString("es-CO")}` : "")
const lista = (xs: unknown) => (Array.isArray(xs) && xs.length ? xs.map((x: { codigo?: string }) => x.codigo ?? "?").join(", ") : "—")

export function resumir(nombre: string, resultado: unknown): string {
  const r = resultado as { ok?: boolean; error?: string; data?: Record<string, unknown> }
  if (!r || r.ok === false) return `Error: ${r?.error ?? "resultado ilegible"}`
  const d = r.data ?? {}
  switch (nombre) {
    case "oc_listar_casos": return `Casos: ${(d.casos as string[]).join(", ")}`
    case "oc_leer_paquete": {
      const s = d.solicitud as Record<string, unknown>
      const f = d.faltantes as string[]
      return `${s.solicitud_id} · ${s.proveedor_nombre} · ${cop(s.valor_total)}${d.factura ? " · trae factura" : ""} · faltantes: ${f.length ? f.join(", ") : "ninguno"}`
    }
    case "oc_validar": return `apta=${d.apta} · bloqueos: ${lista(d.bloqueos)} · confirmaciones: ${lista(d.confirmaciones)} · retroactiva=${d.retroactiva}`
    case "oc_construir_payload": return `OC lista para SAP · confirmaciones: ${lista(d.confirmaciones)} · trazabilidad: ${d.trazabilidad}`
    case "oc_generar_evidencia": return `${d.ruta_pdf} · sha256 ${String(d.sha256).slice(0, 12)}…`
    case "oc_crear": return d.idempotente ? `OC ${d.numero_oc} ya existía (idempotente)` : `OC ${d.numero_oc} creada${d.retroactiva ? " · RETROACTIVA" : ""}`
    default: return "ok"
  }
}

function parsear(texto: string): unknown {
  try {
    return JSON.parse(texto)
  } catch {
    return { ok: false, error: "La herramienta devolvió una respuesta ilegible." }
  }
}

async function ejecutarLlamada(t: ToolCall, cfg: ConfigCiclo, s: Sesion): Promise<{ visible: LlamadaVisible; contenido: string }> {
  const inicio = Date.now()
  const contenido = await ejecutarHerramienta(t.name, t.args, { directory: cfg.directory, sessionId: s.id })
  const resultado = parsear(contenido)
  const visible: LlamadaVisible = {
    id: t.id, nombre: t.name, args: t.args, ok: (resultado as { ok?: boolean }).ok === true,
    resumen: resumir(t.name, resultado), resultado, ms: Date.now() - inicio,
  }
  await registrarLog(cfg.directory, { sessionId: s.id, tool: t.name, args: t.args, ok: visible.ok, resumen: visible.resumen, ms: visible.ms })
  return { visible, contenido }
}

function mensajeTope(llamadas: LlamadaVisible[], max: number): string {
  const hechas = llamadas.map((l) => `- ${l.nombre}: ${l.resumen}`).join("\n")
  return `Alcancé el tope de ${max} pasos para este turno sin terminar.\n\n**Lo que tengo:**\n${hechas || "- (sin resultados)"}\n\n` +
    "**Lo que falta:** completar el proceso. Escríbeme \"continúa\" para seguir desde aquí."
}

// ------------------------------------------------------------ turno

export async function ejecutarTurno(s: Sesion, mensaje: string, cfg: ConfigCiclo): Promise<ResultadoTurno> {
  procesarRespuestaHumana(s, mensaje)
  s.mensajes.push({ role: "user", content: mensaje })
  const llamadas: LlamadaVisible[] = []

  for (let i = 0; i < cfg.maxIteraciones; i++) {
    if (s.tokens.entrada + s.tokens.salida >= cfg.maxTokensSesion) {
      return cerrar(s, llamadas, `Esta sesión alcanzó su tope de ${cfg.maxTokensSesion.toLocaleString("es-CO")} tokens. Abre una sesión nueva para continuar.`, true)
    }
    let respuesta
    try {
      respuesta = await cfg.llm.enviar(s.mensajes, especificaciones, {
        system: cfg.system, signal: AbortSignal.timeout(cfg.timeoutMs), maxTokens: cfg.maxTokensRespuesta,
      })
    } catch (e) {
      const texto = e instanceof LlmError ? e.message : "Ocurrió un error inesperado al consultar el modelo."
      await registrarLog(cfg.directory, { sessionId: s.id, error: texto })
      return cerrar(s, llamadas, `No pude completar la respuesta: ${texto} Tu sesión sigue activa; puedes reintentar.`, true)
    }
    s.tokens.entrada += respuesta.uso.entrada
    s.tokens.salida += respuesta.uso.salida
    s.mensajes.push({ role: "assistant", content: respuesta.texto, toolCalls: respuesta.toolCalls })

    if (!respuesta.toolCalls.length) return cerrar(s, llamadas, respuesta.texto || "(sin respuesta)")

    for (const t of respuesta.toolCalls) {
      const { visible, contenido } = await ejecutarLlamada(t, cfg, s)
      llamadas.push(visible)
      s.mensajes.push({ role: "tool", toolCallId: t.id, name: t.name, content: contenido })
    }
  }
  // CA1: se agotó el tope. El historial queda consistente (cada tool_use tiene su resultado).
  return cerrar(s, llamadas, mensajeTope(llamadas, cfg.maxIteraciones))
}

function cerrar(s: Sesion, llamadas: LlamadaVisible[], reply: string, error = false): ResultadoTurno {
  const pendientes = error ? [] : casosPendientes(llamadas)
  s.pendientes = pendientes
  // Si el turno terminó por error o por tope, el historial no cierra con el asistente:
  // se agrega su respuesta para que el historial siga siendo válido para el proveedor en el siguiente turno.
  const ultimo = s.mensajes[s.mensajes.length - 1]
  if (ultimo && ultimo.role !== "assistant") s.mensajes.push({ role: "assistant", content: reply, toolCalls: [] })
  return { reply, toolCalls: llamadas, needsConfirmation: pendientes.length > 0, pendientes, error }
}
