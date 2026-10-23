// Sesiones en memoria con respaldo en out/sesiones/<id>.json (sin base de datos, PRD 3.2).
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Mensaje } from "../llm/adapter.ts"
import { rutas } from "../core/rutas.ts"

export type LlamadaVisible = {
  id: string
  nombre: string
  args: Record<string, unknown>
  ok: boolean
  resumen: string
  resultado: unknown
  ms: number
}

export type EntradaHistorial = {
  rol: "usuario" | "agente"
  texto: string
  ts: string
  toolCalls?: LlamadaVisible[]
  needsConfirmation?: boolean
  pendientes?: string[]
  error?: boolean
}

export type Sesion = {
  id: string
  creada: string
  mensajes: Mensaje[] // historial para el modelo
  historial: EntradaHistorial[] // historial visible para el front
  tokens: { entrada: number; salida: number }
  pendientes: string[] // casos esperando confirmación humana
}

const ID_VALIDO = /^[a-zA-Z0-9_-]{6,64}$/
const memoria = new Map<string, Sesion>()

export const idSesionValido = (id: string): boolean => ID_VALIDO.test(id)

export async function obtenerSesion(dir: string, id: string): Promise<Sesion> {
  const enMemoria = memoria.get(id)
  if (enMemoria) return enMemoria
  let s: Sesion
  try {
    s = JSON.parse(await readFile(join(rutas.sesiones(dir), `${id}.json`), "utf8")) as Sesion
  } catch {
    s = { id, creada: new Date().toISOString(), mensajes: [], historial: [], tokens: { entrada: 0, salida: 0 }, pendientes: [] }
  }
  memoria.set(id, s)
  return s
}

export async function guardarSesion(dir: string, s: Sesion): Promise<void> {
  try {
    await mkdir(rutas.sesiones(dir), { recursive: true })
    await writeFile(join(rutas.sesiones(dir), `${s.id}.json`), JSON.stringify(s), "utf8")
  } catch {
    // La sesión sigue viva en memoria aunque el disco falle.
  }
}

/** Serializa los turnos de una misma sesión para que dos peticiones simultáneas no mezclen el historial. */
const colas = new Map<string, Promise<unknown>>()
export function enCola<T>(id: string, tarea: () => Promise<T>): Promise<T> {
  const previa = colas.get(id) ?? Promise.resolve()
  const actual = previa.then(tarea, tarea)
  colas.set(id, actual.catch(() => undefined))
  return actual
}
