// Lectura de maestros y del paquete de un caso. Solo lectura sobre fixtures/.
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { rutas, casoValido } from "./rutas.ts"
import { parsearCotizacion, parsearFactura, normalizarAprobacion } from "./parsers.ts"
import {
  SolicitudSchema, ProveedorSchema, CentroCostoSchema, IndicadorIvaSchema, CondicionPagoSchema,
  type Maestros, type Paquete, type Resultado, ok, falla,
} from "./tipos.ts"

/** Lee un archivo; null si no existe (un adjunto ausente no es una excepción). */
async function leerOpcional(ruta: string): Promise<string | null> {
  try {
    return await readFile(ruta, "utf8")
  } catch {
    return null
  }
}

function parsearJson(texto: string, nombre: string): Resultado<unknown> {
  try {
    return ok(JSON.parse(texto))
  } catch (e) {
    return falla(`${nombre} no es un JSON válido (${(e as Error).message}). Pedir al solicitante que reenvíe el archivo.`)
  }
}

function describirIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
}

let cacheMaestros: { dir: string; data: Maestros } | null = null

export async function leerMaestros(dir: string): Promise<Resultado<Maestros>> {
  if (cacheMaestros?.dir === dir) return ok(cacheMaestros.data)
  const base = rutas.maestros(dir)
  const leer = async <T>(archivo: string, schema: z.ZodType<T>): Promise<Resultado<T[]>> => {
    const txt = await leerOpcional(join(base, archivo))
    if (txt === null) return falla(`No se encontró el maestro ${archivo}.`)
    const json = parsearJson(txt, archivo)
    if (!json.ok) return json
    const r = z.array(schema).safeParse(json.data)
    return r.success ? ok(r.data) : falla(`Maestro ${archivo} inválido: ${describirIssues(r.error)}`)
  }
  const [p, c, i, cp] = await Promise.all([
    leer("proveedores.json", ProveedorSchema),
    leer("centros-costo.json", CentroCostoSchema),
    leer("indicadores-iva.json", IndicadorIvaSchema),
    leer("condiciones-pago.json", CondicionPagoSchema),
  ])
  if (!p.ok) return p
  if (!c.ok) return c
  if (!i.ok) return i
  if (!cp.ok) return cp
  const data: Maestros = { proveedores: p.data, centros: c.data, iva: i.data, condiciones: cp.data }
  cacheMaestros = { dir, data }
  return ok(data)
}

export async function listarCasos(dir: string): Promise<string[]> {
  try {
    const entradas = await readdir(rutas.solicitudes(dir), { withFileTypes: true })
    return entradas.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return []
  }
}

const CorreoCrudoSchema = z.object({ id: z.string(), de: z.string(), asunto: z.string(), fecha: z.string() })

/** HU-1: lee y normaliza el paquete. Adjuntos ausentes → null + nombre en `faltantes`. */
export async function leerPaquete(dir: string, caso: string): Promise<Resultado<Paquete>> {
  if (!casoValido(caso)) return falla(`Nombre de caso inválido: "${caso}". Usa el nombre de la carpeta, por ejemplo "sol-001".`)
  const base = rutas.caso(dir, caso)
  const leer = (f: string) => leerOpcional(join(base, f))
  const [correoTxt, solicitudTxt, cotizacionTxt, aprobacionTxt, facturaTxt] = await Promise.all([
    leer("correo.json"), leer("solicitud.json"), leer("cotizacion.txt"), leer("aprobacion.json"), leer("factura.txt"),
  ])
  if ([correoTxt, solicitudTxt, cotizacionTxt, aprobacionTxt].every((x) => x === null)) {
    const casos = await listarCasos(dir)
    return falla(`No existe el caso "${caso}". Casos disponibles: ${casos.join(", ") || "ninguno"}.`)
  }
  const faltantes: string[] = []

  // Solicitud: sin ella no hay OC posible.
  if (solicitudTxt === null) return falla("Falta solicitud.json (Excel de solicitud). Pedir al solicitante que lo adjunte.")
  const solJson = parsearJson(solicitudTxt, "solicitud.json")
  if (!solJson.ok) return solJson
  const sol = SolicitudSchema.safeParse(solJson.data)
  if (!sol.success) return falla(`La solicitud tiene datos inválidos: ${describirIssues(sol.error)}. Pedir al solicitante que corrija el Excel.`)

  let correo: Paquete["correo"] = null
  if (correoTxt === null) faltantes.push("correo.json")
  else {
    const j = parsearJson(correoTxt, "correo.json")
    const c = j.ok ? CorreoCrudoSchema.safeParse(j.data) : null
    if (c?.success) correo = c.data
    else faltantes.push("correo.json (ilegible)")
  }

  let cotizacion: Paquete["cotizacion"] = null
  if (cotizacionTxt === null) faltantes.push("cotizacion.txt")
  else {
    const c = parsearCotizacion(cotizacionTxt)
    if (c.ok) cotizacion = c.data
    else faltantes.push(`cotizacion.txt (${c.error})`)
  }

  let aprobacion: Paquete["aprobacion"] = null
  if (aprobacionTxt === null) faltantes.push("aprobacion.json")
  else {
    const j = parsearJson(aprobacionTxt, "aprobacion.json")
    const a = j.ok ? normalizarAprobacion(j.data) : null
    if (a?.ok) aprobacion = a.data
    else faltantes.push(`aprobacion.json (${a && !a.ok ? a.error : "JSON inválido"})`)
  }

  let factura: Paquete["factura"] = null
  if (facturaTxt !== null) {
    const f = parsearFactura(facturaTxt)
    if (f.ok) factura = f.data
    else faltantes.push(`factura.txt (${f.error})`)
  }

  return ok({ caso, correo, solicitud: sol.data, cotizacion, aprobacion, factura, faltantes })
}

/** Texto crudo del correo de aprobación, para la evidencia (headers completos incluidos `cc`). */
export async function leerAprobacionCruda(dir: string, caso: string): Promise<Resultado<Record<string, unknown>>> {
  if (!casoValido(caso)) return falla(`Nombre de caso inválido: "${caso}".`)
  const txt = await leerOpcional(join(rutas.caso(dir, caso), "aprobacion.json"))
  if (txt === null) return falla("No hay aprobacion.json en el caso: no se puede generar evidencia. Pedir el correo de aprobación del líder.")
  const j = parsearJson(txt, "aprobacion.json")
  if (!j.ok) return j
  return typeof j.data === "object" && j.data !== null ? ok(j.data as Record<string, unknown>) : falla("aprobacion.json no es un objeto.")
}
