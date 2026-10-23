// Registros de auditoría: out/control.csv (HU-5, para Contabilidad) y out/log.jsonl (CA4, cada llamada a herramienta).
import { appendFile, mkdir, readFile, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { rutas } from "./rutas.ts"

export type ResultadoControl = "creada" | "idempotente" | "bloqueada" | "pendiente_confirmacion" | "rechazada"

export type FilaControl = {
  solicitud_id: string
  resultado: ResultadoControl
  numero_oc: string
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
  ts: string
  origen: "oc_validar" | "oc_crear"
}

const COLUMNAS = ["solicitud_id", "resultado", "numero_oc", "retroactiva", "bloqueos", "confirmaciones", "ts", "origen"] as const

const csv = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

async function existe(ruta: string): Promise<boolean> {
  try {
    await stat(ruta)
    return true
  } catch {
    return false
  }
}

export async function registrarControl(dir: string, fila: Omit<FilaControl, "ts">): Promise<void> {
  const ruta = rutas.control(dir)
  await mkdir(dirname(ruta), { recursive: true })
  const completa: FilaControl = { ...fila, ts: new Date().toISOString() }
  const valores = [
    completa.solicitud_id, completa.resultado, completa.numero_oc, String(completa.retroactiva),
    completa.bloqueos.join("|"), completa.confirmaciones.join("|"), completa.ts, completa.origen,
  ]
  const encabezado = (await existe(ruta)) ? "" : COLUMNAS.join(",") + "\n"
  await appendFile(ruta, encabezado + valores.map(csv).join(",") + "\n", "utf8")
}

/** Lee control.csv y resume el último estado por solicitud (para medir % de OC retroactivas). */
export async function resumenControl(dir: string) {
  let txt = ""
  try {
    txt = await readFile(rutas.control(dir), "utf8")
  } catch {
    return { filas: 0, solicitudes: 0, creadas: 0, retroactivas: 0, pct_retroactivas_sobre_creadas: 0, ultimo_estado: {} as Record<string, string> }
  }
  const lineas = txt.trim().split("\n").slice(1)
  const ultimo: Record<string, { resultado: string; retroactiva: boolean }> = {}
  for (const l of lineas) {
    const [id, resultado, , retro] = l.split(",")
    if (id && resultado) ultimo[id] = { resultado: resultado === "idempotente" ? ultimo[id]?.resultado ?? "creada" : resultado, retroactiva: retro === "true" }
  }
  const estados = Object.values(ultimo)
  const creadas = estados.filter((e) => e.resultado === "creada")
  const retro = creadas.filter((e) => e.retroactiva).length
  return {
    filas: lineas.length,
    solicitudes: estados.length,
    creadas: creadas.length,
    retroactivas: retro,
    pct_retroactivas_sobre_creadas: creadas.length ? Math.round((retro / creadas.length) * 1000) / 10 : 0,
    ultimo_estado: Object.fromEntries(Object.entries(ultimo).map(([k, v]) => [k, v.resultado])),
  }
}

/** CA4: toda llamada a herramienta queda en out/log.jsonl. */
export async function registrarLog(dir: string, evento: Record<string, unknown>): Promise<void> {
  try {
    const ruta = rutas.log(dir)
    await mkdir(dirname(ruta), { recursive: true })
    await appendFile(ruta, JSON.stringify({ ts: new Date().toISOString(), ...evento }) + "\n", "utf8")
  } catch {
    // El log es best-effort: un fallo de disco no debe tumbar la sesión del usuario.
  }
}
