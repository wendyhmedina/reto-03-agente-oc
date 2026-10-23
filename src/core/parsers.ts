// Lectura de los documentos de texto (cotización, factura, aprobación).
// En producción estos textos vendrían de OCR/extracción de PDF; el reto los entrega ya como texto.
import { z } from "zod"
import { parsearMonto, sumarDias, normalizarNit } from "./texto.ts"

type Cotizacion = {
  referencia: string | null
  fecha: string | null
  proveedor: string
  nit: string | null
  total: number
  moneda: string
  validez_hasta: string | null
  items: { descripcion: string; cantidad: number; precio_unitario: number }[]
  texto: string
}

const campo = (texto: string, etiqueta: RegExp): string | null => {
  const m = texto.match(etiqueta)
  return m?.[1]?.trim() ?? null
}

/** Cotización en texto → estructura. Devuelve un error legible si no encuentra el total. */
export function parsearCotizacion(texto: string): { ok: true; data: Cotizacion } | { ok: false; error: string } {
  const totalTxt = campo(texto, /^TOTAL[^:\n]*:\s*([A-Z]{3}\s*[\d.,]+)/im)
  const total = totalTxt ? parsearMonto(totalTxt) : null
  if (total === null) return { ok: false, error: "La cotización no tiene una línea TOTAL con un monto numérico." }

  const fecha = campo(texto, /^Fecha:\s*(\d{4}-\d{2}-\d{2})/im)
  const diasValidez = campo(texto, /^Validez[^:\n]*:\s*(\d+)\s*d[ií]as/im)
  const nit = campo(texto, /^NIT:\s*([\d.\-\s]+)/im)

  const items = [...texto.matchAll(/^\d+\.\s*(.+?)\s*\|\s*Cantidad:\s*([\d.,]+)\s*\|\s*Precio unitario[^:]*:\s*[A-Z]{3}\s*([\d.,]+)/gim)].map(
    (m) => ({
      descripcion: m[1]!.trim(),
      cantidad: parsearMonto(m[2]!) ?? 0,
      precio_unitario: parsearMonto(m[3]!) ?? 0,
    }),
  )

  return {
    ok: true,
    data: {
      referencia: campo(texto, /^COTIZACI[ÓO]N\s+(\S+)/im),
      fecha,
      proveedor: campo(texto, /^Proveedor:\s*(.+)$/im) ?? "",
      nit: nit ? normalizarNit(nit) : null,
      total,
      moneda: totalTxt!.slice(0, 3).toUpperCase(),
      validez_hasta: fecha && diasValidez ? sumarDias(fecha, Number(diasValidez)) : null,
      items,
      texto,
    },
  }
}

/** Factura en texto → { numero, fecha, total }. */
export function parsearFactura(texto: string): { ok: true; data: { numero: string; fecha: string; total: number } } | { ok: false; error: string } {
  const numero = campo(texto, /No\.\s*(\S+)/i)
  const fecha = campo(texto, /Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i)
  const totalTxt = campo(texto, /^TOTAL[^:\n]*:\s*([A-Z]{3}\s*[\d.,]+)/im)
  const total = totalTxt ? parsearMonto(totalTxt) : null
  if (!numero || !fecha || total === null) {
    return { ok: false, error: "La factura no tiene número, fecha de emisión o total legibles." }
  }
  return { ok: true, data: { numero, fecha, total } }
}

const AprobacionCrudaSchema = z.object({
  de: z.string().min(1),
  para: z.string().optional(),
  fecha: z.string().min(10),
  asunto: z.string().optional(),
  cuerpo: z.string(),
})

/**
 * "Aprobado" como palabra, sin negación delante ("no aprobado", "sin aprobar").
 * Se evalúa la primera línea con contenido y el resto del cuerpo.
 */
export function contieneAprobado(cuerpo: string): boolean {
  const t = cuerpo.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  if (/\b(no|sin|rechazad[oa]|negad[oa])\s+(esta\s+|queda\s+)?aprobad[oa]\b/.test(t)) return false
  return /\baprobad[oa]\b/.test(t)
}

export function normalizarAprobacion(crudo: unknown) {
  const r = AprobacionCrudaSchema.safeParse(crudo)
  if (!r.success) return { ok: false as const, error: `aprobacion.json no tiene la forma esperada: ${r.error.issues.map((i) => i.path.join(".") || i.message).join(", ")}` }
  const a = r.data
  return {
    ok: true as const,
    data: { de: a.de.toLowerCase(), para: a.para ?? null, fecha: a.fecha, asunto: a.asunto ?? null, aprobado: contieneAprobado(a.cuerpo), texto: a.cuerpo },
  }
}
