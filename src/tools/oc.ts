// Herramientas del agente de órdenes de compra. Cada export es una herramienta;
// el nombre que ve el modelo es "oc_<export>" (PRD 6.2).
//
// Reglas de diseño:
//  - Nunca lanzan: devuelven JSON serializado { ok: true, data } | { ok: false, error }.
//  - Son la única fuente de valores: siempre releen los fixtures; si el modelo envía un paquete
//    o payload, solo se acepta si coincide con lo que las herramientas calculan.
//  - No dependen del servidor HTTP: se importan igual desde demo.ts y desde modulo/.
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { leerMaestros, leerPaquete, listarCasos } from "../core/fixtures.ts"
import { validarPaquete } from "../core/controles.ts"
import { construirPayload } from "../core/payload.ts"
import { generarEvidencia, hashEvidencia } from "../core/evidencia.ts"
import { registrarControl } from "../core/registro.ts"
import { confirmacionDe } from "../core/confirmaciones.ts"
import { rutas, relativa } from "../core/rutas.ts"
import { SapMock } from "../sap/mock.ts"
import type { SapAdapter } from "../sap/adapter.ts"
import { type Paquete, type Maestros, type ResultadoValidacion, type ToolCtx, type Resultado, type OrdenCompra, ok, falla } from "../core/tipos.ts"

// ---------------------------------------------------------------- utilidades internas

type Shape = z.ZodRawShape
export type Herramienta<S extends Shape> = {
  description: string
  args: S
  execute(args: z.infer<z.ZodObject<S>>, ctx: ToolCtx): Promise<string>
}

/** Envuelve la lógica para garantizar que la herramienta nunca lanza. */
function herramienta<S extends Shape, T>(def: {
  description: string
  args: S
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolCtx): Promise<Resultado<T>>
}): Herramienta<S> {
  return {
    description: def.description,
    args: def.args,
    async execute(args, ctx) {
      try {
        return JSON.stringify(await def.run(args, ctx))
      } catch (e) {
        return JSON.stringify(falla(`Error interno de la herramienta: ${(e as Error).message}`))
      }
    },
  }
}

const sapPorDirectorio = new Map<string, SapAdapter>()
function sap(dir: string): SapAdapter {
  if (!sapPorDirectorio.has(dir)) sapPorDirectorio.set(dir, new SapMock(dir))
  return sapPorDirectorio.get(dir)!
}

type Preparado = { paquete: Paquete; maestros: Maestros; validacion: ResultadoValidacion }

/** Lee el paquete desde los archivos y lo valida. Es la fuente de verdad de todas las herramientas. */
async function preparar(dir: string, caso: string): Promise<Resultado<Preparado>> {
  const [p, m] = await Promise.all([leerPaquete(dir, caso), leerMaestros(dir)])
  if (!p.ok) return p
  if (!m.ok) return m
  return ok({ paquete: p.data, maestros: m.data, validacion: validarPaquete(p.data, m.data) })
}

/** Compara solo los campos que determinan la OC; el modelo no puede alterar montos ni maestros. */
function diferencias(enviado: unknown, real: Record<string, unknown>, campos: string[]): string[] {
  const leer = (o: unknown, ruta: string): unknown =>
    ruta.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), o)
  return campos.filter((c) => {
    const e = leer(enviado, c)
    return e !== undefined && JSON.stringify(e) !== JSON.stringify(leer(real, c))
  })
}

const CAMPOS_PAQUETE = [
  "solicitud.solicitud_id", "solicitud.valor_total", "solicitud.cantidad", "solicitud.valor_unitario", "solicitud.proveedor_nit",
  "solicitud.centro_costo", "solicitud.subarea", "solicitud.indicador_iva", "solicitud.condiciones_pago", "cotizacion.total", "aprobacion.de",
]
const CAMPOS_PAYLOAD = [
  "proveedor.codigo_sap", "proveedor.nit", "moneda", "condiciones_pago", "aprobador.email", "aprobador.evidencia_sha256",
  "posiciones.0.cantidad", "posiciones.0.precio_unitario", "posiciones.0.centro_costo", "posiciones.0.subarea", "posiciones.0.indicador_iva",
]

function rechazarAlterado(cambiados: string[], que: string): Resultado<never> {
  return falla(`El ${que} enviado no coincide con lo leído de los documentos en: ${cambiados.join(", ")}. ` +
    "Los valores solo pueden venir de las herramientas; vuelve a llamar sin ese argumento.")
}

const codigos = (xs: { codigo: string }[]) => xs.map((x) => x.codigo)

// ---------------------------------------------------------------- argumentos comunes

const argCaso = z.string().describe('Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo "sol-001"')
const argPaquete = z.record(z.string(), z.unknown()).optional()
  .describe("Opcional. Paquete devuelto por oc_leer_paquete. Si se omite, la herramienta relee los documentos (recomendado)")

// ---------------------------------------------------------------- herramientas

export const listar_casos = herramienta({
  description: "Lista los casos (carpetas de solicitudes) disponibles para procesar.",
  args: {},
  async run(_args, ctx) {
    return ok({ casos: await listarCasos(ctx.directory) })
  },
})

export const leer_paquete = herramienta({
  description: "Lee y normaliza el paquete de un caso (correo, solicitud, cotización, aprobación y factura si existe), reportando los adjuntos faltantes.",
  args: { caso: argCaso },
  async run({ caso }, ctx) {
    return leerPaquete(ctx.directory, caso)
  },
})

export const validar = herramienta({
  description: "Aplica las reglas de control RC1–RC10 contra los maestros y devuelve si la OC es apta, sus bloqueos, confirmaciones requeridas, valores derivados y si es retroactiva.",
  args: { caso: argCaso, paquete: argPaquete },
  async run({ caso, paquete }, ctx) {
    const prep = await preparar(ctx.directory, caso)
    if (!prep.ok) return prep
    const cambiados = diferencias(paquete, prep.data.paquete, CAMPOS_PAQUETE)
    if (cambiados.length) return rechazarAlterado(cambiados, "paquete")
    const v = prep.data.validacion
    const resultado = !v.apta ? "bloqueada" : v.confirmaciones.length ? "pendiente_confirmacion" : null
    if (resultado) {
      await registrarControl(ctx.directory, {
        solicitud_id: prep.data.paquete.solicitud.solicitud_id, resultado, numero_oc: "", retroactiva: v.retroactiva,
        bloqueos: codigos(v.bloqueos), confirmaciones: codigos(v.confirmaciones), origen: "oc_validar",
      })
    }
    return ok({ solicitud_id: prep.data.paquete.solicitud.solicitud_id, ...v })
  },
})

export const construir_payload = herramienta({
  description: "Construye la orden de compra exactamente como quedaría en SAP (validada con zod) y guarda la trazabilidad de cada campo.",
  args: {
    caso: argCaso,
    paquete: argPaquete,
    derivados: z.record(z.string(), z.unknown()).optional().describe("Opcional. Derivados devueltos por oc_validar; si se omite se recalculan"),
  },
  async run({ caso, paquete }, ctx) {
    const prep = await preparar(ctx.directory, caso)
    if (!prep.ok) return prep
    const cambiados = diferencias(paquete, prep.data.paquete, CAMPOS_PAQUETE)
    if (cambiados.length) return rechazarAlterado(cambiados, "paquete")
    const sha = await hashEvidencia(ctx.directory, caso)
    if (!sha.ok) return sha
    const r = construirPayload(prep.data.paquete, prep.data.validacion, sha.data)
    if (!r.ok) return r
    const carpeta = rutas.outCaso(ctx.directory, caso)
    await mkdir(carpeta, { recursive: true })
    const rutaTraza = join(carpeta, "trazabilidad.json")
    await writeFile(rutaTraza, JSON.stringify(r.data.trazabilidad, null, 2), "utf8")
    await writeFile(join(carpeta, "payload.json"), JSON.stringify(r.data.orden, null, 2), "utf8")
    const v = prep.data.validacion
    return ok({
      orden: r.data.orden,
      valor_total: prep.data.paquete.solicitud.valor_total,
      trazabilidad: relativa(ctx.directory, rutaTraza),
      requiere_confirmacion: v.confirmaciones.length > 0,
      confirmaciones: v.confirmaciones,
      retroactiva: v.retroactiva,
    })
  },
})

export const generar_evidencia = herramienta({
  description: "Genera la evidencia del correo de aprobación del líder en out/<caso>/aprobacion.txt y .pdf, con su hash sha256.",
  args: { caso: argCaso },
  async run({ caso }, ctx) {
    return generarEvidencia(ctx.directory, caso)
  },
})

export const crear = herramienta({
  description: "Crea la orden de compra en SAP si la solicitud es apta y, cuando hay confirmaciones pendientes, solo después de que la analista confirmó en el chat; es idempotente por solicitud.",
  args: {
    caso: argCaso,
    payload: z.record(z.string(), z.unknown()).optional().describe("Opcional. Orden devuelta por oc_construir_payload; si se omite se reconstruye (recomendado)"),
    confirmado: z.boolean().optional().describe("true solo si la analista confirmó explícitamente las excepciones en su último mensaje"),
  },
  async run({ caso, payload, confirmado }, ctx) {
    const dir = ctx.directory
    const prep = await preparar(dir, caso)
    if (!prep.ok) return prep
    const { paquete, validacion: v } = prep.data
    const sid = paquete.solicitud.solicitud_id
    const base = { solicitud_id: sid, retroactiva: v.retroactiva, bloqueos: codigos(v.bloqueos), confirmaciones: codigos(v.confirmaciones), origen: "oc_crear" as const }

    // Idempotencia: una solicitud ya creada devuelve su número, nunca una segunda OC.
    const existente = await sap(dir).buscarOrdenPorReferencia(sid)
    if (existente) {
      await registrarControl(dir, { ...base, resultado: "idempotente", numero_oc: existente.numero_oc })
      return ok({ numero_oc: existente.numero_oc, fecha: existente.fecha ?? null, idempotente: true, retroactiva: v.retroactiva })
    }

    if (!v.apta) {
      await registrarControl(dir, { ...base, resultado: "rechazada", numero_oc: "" })
      return falla(`No se crea la OC: bloqueos ${base.bloqueos.join(", ")}. ${v.bloqueos.map((b) => b.accion_sugerida).join(" ")}`)
    }

    const conf = v.confirmaciones.length ? confirmacionDe(ctx.sessionId, caso, confirmado === true) : { por: "" }
    if (!conf) {
      await registrarControl(dir, { ...base, resultado: "pendiente_confirmacion", numero_oc: "" })
      return falla(`La OC requiere confirmación explícita de la analista en el chat por: ${base.confirmaciones.join(", ")}. ` +
        "Termina el turno con una pregunta y espera su respuesta.")
    }

    const ev = await generarEvidencia(dir, caso)
    if (!ev.ok) return ev
    const r = construirPayload(paquete, v, ev.data.sha256)
    if (!r.ok) return r
    const cambiados = diferencias(payload, r.data.orden, CAMPOS_PAYLOAD)
    if (cambiados.length) return rechazarAlterado(cambiados, "payload")

    const orden: OrdenCompra = {
      ...r.data.orden,
      excepciones: r.data.orden.excepciones.map((e) => ({ ...e, confirmado_por: conf.por || null })),
    }
    const creada = await sap(dir).crearOrden(orden)
    await registrarControl(dir, { ...base, resultado: "creada", numero_oc: creada.numero_oc })
    const carpeta = rutas.outCaso(dir, caso)
    await writeFile(join(carpeta, "orden.json"), JSON.stringify({ ...creada, orden }, null, 2), "utf8")
    return ok({
      numero_oc: creada.numero_oc,
      fecha: creada.fecha,
      idempotente: false,
      retroactiva: v.retroactiva,
      excepciones_confirmadas: orden.excepciones,
      evidencia: { txt: ev.data.ruta, pdf: ev.data.ruta_pdf, sha256: ev.data.sha256 },
    })
  },
})
