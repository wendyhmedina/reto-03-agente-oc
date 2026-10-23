// HU-3: construcción del payload de la OC con trazabilidad campo por campo.
// Ningún valor sale del modelo: todo viene de la solicitud, la cotización, los maestros o una derivación explícita.
import { recortar } from "./texto.ts"
import { OrdenCompraSchema, type OrdenCompra, type Paquete, type ResultadoValidacion, type Resultado, ok, falla } from "./tipos.ts"

export type Fuente = "solicitud" | "cotizacion" | "correo" | "aprobacion" | "evidencia" | "constante" | "derivado" | `maestro.${string}`
export type Trazabilidad = Record<string, { valor: unknown; fuente: Fuente; nota?: string }>

/** Unidad SAP a partir del texto del ítem: horas → H, mensualidades → MES, resto → UN. */
export function inferirUnidad(...textos: (string | undefined)[]): { unidad: "UN" | "H" | "MES"; regla: string } {
  const t = textos.filter(Boolean).join(" ").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  if (/\b(hora|horas)\b/.test(t)) return { unidad: "H", regla: "el texto menciona horas" }
  if (/\b(mensualidad|por mes|mes de servicio|meses de servicio)\b/.test(t)) return { unidad: "MES", regla: "el texto menciona mensualidad" }
  return { unidad: "UN", regla: "unidad por defecto" }
}

export function construirPayload(
  p: Paquete,
  v: ResultadoValidacion,
  evidenciaSha: string,
): Resultado<{ orden: OrdenCompra; trazabilidad: Trazabilidad }> {
  if (!v.apta) return falla(`La solicitud tiene bloqueos (${v.bloqueos.map((b) => b.codigo).join(", ")}); no se construye la OC.`)
  const { proveedor, indicador_iva, condiciones_pago } = v.derivados
  if (!proveedor || !indicador_iva || !condiciones_pago || !p.aprobacion) {
    return falla("Faltan datos derivados (proveedor, IVA, condiciones de pago o aprobación); ejecuta oc_validar primero.")
  }
  const s = p.solicitud
  const item = p.cotizacion?.items[0]
  const unidad = inferirUnidad(item?.descripcion, s.descripcion)
  const descripcion = recortar(s.descripcion, 40)

  const orden: OrdenCompra = {
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo?.id ?? `${p.caso}-correo`, cotizacion_ref: p.cotizacion?.referencia ?? null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor,
    moneda: s.moneda,
    condiciones_pago: condiciones_pago.codigo,
    aprobador: { email: p.aprobacion.de, fecha_aprobacion: p.aprobacion.fecha, evidencia_sha256: evidenciaSha },
    posiciones: [{
      numero: 10,
      descripcion,
      cantidad: s.cantidad,
      unidad: unidad.unidad,
      precio_unitario: s.valor_unitario,
      centro_costo: s.centro_costo,
      subarea: s.subarea,
      indicador_iva: indicador_iva.codigo,
    }],
    excepciones: v.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: null })),
  }

  const r = OrdenCompraSchema.safeParse(orden)
  if (!r.success) return falla(`El payload no cumple el esquema SAP: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`)

  const fuenteIva = indicador_iva.fuente === "solicitud" ? "solicitud" : "maestro.proveedores"
  const fuenteCp = condiciones_pago.fuente === "solicitud" ? "solicitud" : "maestro.proveedores"
  const trazabilidad: Trazabilidad = {
    "referencia.solicitud_id": { valor: s.solicitud_id, fuente: "solicitud" },
    "referencia.correo_id": { valor: orden.referencia.correo_id, fuente: p.correo ? "correo" : "derivado" },
    "referencia.cotizacion_ref": { valor: orden.referencia.cotizacion_ref, fuente: "cotizacion" },
    sociedad: { valor: "1000", fuente: "constante", nota: "Sociedad única de Periferia en el reto" },
    organizacion_compras: { valor: "1000", fuente: "constante" },
    "proveedor.codigo_sap": { valor: proveedor.codigo_sap, fuente: "maestro.proveedores" },
    "proveedor.nit": { valor: proveedor.nit, fuente: "maestro.proveedores" },
    "proveedor.nombre": { valor: proveedor.nombre, fuente: "maestro.proveedores" },
    moneda: { valor: s.moneda, fuente: "solicitud" },
    condiciones_pago: { valor: condiciones_pago.codigo, fuente: fuenteCp, nota: fuenteCp === "solicitud" ? undefined : "RC7: derivado del proveedor" },
    "aprobador.email": { valor: p.aprobacion.de, fuente: "aprobacion" },
    "aprobador.fecha_aprobacion": { valor: p.aprobacion.fecha, fuente: "aprobacion" },
    "aprobador.evidencia_sha256": { valor: evidenciaSha, fuente: "evidencia" },
    "posiciones[0].numero": { valor: 10, fuente: "constante", nota: "Numeración SAP 10, 20, 30…" },
    "posiciones[0].descripcion": { valor: descripcion, fuente: "solicitud", nota: descripcion !== s.descripcion ? `Recortada a 40 caracteres. Original: "${s.descripcion}"` : undefined },
    "posiciones[0].cantidad": { valor: s.cantidad, fuente: "solicitud" },
    "posiciones[0].unidad": { valor: unidad.unidad, fuente: "derivado", nota: unidad.regla },
    "posiciones[0].precio_unitario": { valor: s.valor_unitario, fuente: "solicitud", nota: "Valor aprobado por el líder (IVA incluido)" },
    "posiciones[0].centro_costo": { valor: s.centro_costo, fuente: "solicitud", nota: "Validado contra maestro.centros-costo" },
    "posiciones[0].subarea": { valor: s.subarea, fuente: "solicitud", nota: "Validada contra maestro.centros-costo (RC4)" },
    "posiciones[0].indicador_iva": { valor: indicador_iva.codigo, fuente: fuenteIva, nota: fuenteIva === "solicitud" ? undefined : "RC6: derivado del proveedor, requiere confirmación" },
    excepciones: { valor: orden.excepciones.map((e) => e.codigo), fuente: "derivado", nota: "Confirmaciones de oc_validar" },
  }
  return ok({ orden: r.data, trazabilidad })
}
