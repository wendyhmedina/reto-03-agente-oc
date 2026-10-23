// Matriz de controles RC1–RC10 (PRD 7.3). Cada regla es una función pura que recibe
// el contexto y agrega hallazgos. Cambiar una regla de negocio no toca el servidor ni el agente.
import { normalizarNit, normalizarNombre, soloFecha, cop } from "./texto.ts"
import type { Paquete, Maestros, Hallazgo, Derivados, ResultadoValidacion, Proveedor, CentroCosto } from "./tipos.ts"

export const TOLERANCIA_COTIZACION = 0.02 // RC5: 2 %
export const TOLERANCIA_ARITMETICA = 1 // RC10: ± 1 unidad monetaria

type Ctx = {
  p: Paquete
  m: Maestros
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  advertencias: Hallazgo[]
  derivados: Derivados
  proveedor: Proveedor | null
  centro: CentroCosto | null
  retroactiva: boolean
}

const h = (codigo: string, detalle: string, accion_sugerida: string): Hallazgo => ({ codigo, detalle, accion_sugerida })

export function buscarProveedor(m: Maestros, nit: string | undefined, nombre: string): { proveedor: Proveedor | null; via: "nit" | "nombre" | null } {
  if (nit) {
    const n = normalizarNit(nit)
    return { proveedor: m.proveedores.find((x) => normalizarNit(x.nit) === n) ?? null, via: "nit" }
  }
  const nn = normalizarNombre(nombre)
  return { proveedor: m.proveedores.find((x) => normalizarNombre(x.nombre) === nn) ?? null, via: "nombre" }
}

/** RC1 — proveedor existe (por NIT, o por nombre normalizado si no hay NIT) y está activo. */
function rc1Proveedor(c: Ctx): void {
  const s = c.p.solicitud
  const { proveedor, via } = buscarProveedor(c.m, s.proveedor_nit, s.proveedor_nombre)
  if (!proveedor) {
    const clave = via === "nit" ? `NIT ${s.proveedor_nit}` : `nombre "${s.proveedor_nombre}"`
    c.bloqueos.push(h("RC1", `El proveedor "${s.proveedor_nombre}" (${clave}) no existe en el maestro de proveedores.`,
      "Solicitar a Compras la creación del proveedor en SAP (RUT, cámara de comercio, certificación bancaria) o elegir un proveedor ya registrado."))
    return
  }
  if (!proveedor.activo) {
    c.bloqueos.push(h("RC1", `El proveedor ${proveedor.nombre} (código ${proveedor.codigo_sap}) está inactivo.`,
      "Solicitar a Compras la reactivación del proveedor o elegir otro proveedor activo."))
    return
  }
  c.proveedor = proveedor
  c.derivados.proveedor = { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre }
  if (via === "nombre") {
    c.advertencias.push(h("RC1-NIT", `La solicitud no trae NIT; el proveedor se identificó por nombre como ${proveedor.nombre} (NIT ${proveedor.nit}).`,
      "Verificar que el NIT de la cotización coincida."))
  }
  const nitCot = c.p.cotizacion?.nit
  if (nitCot && normalizarNit(nitCot) !== normalizarNit(proveedor.nit)) {
    c.confirmaciones.push(h("RC1-COT", `El NIT de la cotización (${nitCot}) no coincide con el del proveedor de la solicitud (${proveedor.nit}).`,
      "Confirmar con el solicitante cuál es el proveedor correcto antes de crear la OC."))
  }
}

/** RC2 — aprobación existe, dice "Aprobado" y viene de un aprobador del centro de costo. */
function rc2Aprobacion(c: Ctx): void {
  const a = c.p.aprobacion
  const s = c.p.solicitud
  if (!a) {
    c.bloqueos.push(h("RC2", "No llegó el correo de aprobación del líder.", "Pedir al solicitante que reenvíe el correo de aprobación de su líder."))
    return
  }
  if (!a.aprobado) {
    c.bloqueos.push(h("RC2", `El correo de ${a.de} no contiene una aprobación explícita ("Aprobado").`,
      "Pedir al líder una respuesta explícita con la palabra \"Aprobado\"."))
    return
  }
  if (!c.centro) return // RC4 ya reporta el centro inexistente
  const aprobador = c.centro.aprobadores.find((x) => x.email.toLowerCase() === a.de.toLowerCase())
  if (!aprobador) {
    const dondeSi = c.m.centros.filter((cc) => cc.aprobadores.some((x) => x.email.toLowerCase() === a.de.toLowerCase())).map((cc) => cc.centro_costo)
    const validos = c.centro.aprobadores.map((x) => `${x.nombre ?? x.email} <${x.email}> (tope ${cop(x.tope)})`).join(", ")
    const extra = dondeSi.length ? ` Es aprobador de ${dondeSi.join(", ")}, no de ${s.centro_costo}.` : ""
    c.bloqueos.push(h("RC2", `${a.de} no está autorizado para aprobar gastos del centro ${s.centro_costo}.${extra}`,
      `Solicitar la aprobación a un aprobador de ${s.centro_costo}: ${validos}.`))
    return
  }
  c.derivados.aprobador = { email: aprobador.email, nombre: aprobador.nombre ?? aprobador.email, tope: aprobador.tope }
}

/** RC3 — valor_total ≤ tope del aprobador para ese centro. */
function rc3Tope(c: Ctx): void {
  const s = c.p.solicitud
  if (!c.centro) return
  const ap = c.derivados.aprobador
  if (ap) {
    if (s.valor_total > ap.tope) {
      const superior = c.centro.aprobadores.filter((x) => x.tope >= s.valor_total).map((x) => x.email)
      c.bloqueos.push(h("RC3", `El valor ${cop(s.valor_total)} supera el tope de ${ap.email} (${cop(ap.tope)}) en ${s.centro_costo}.`,
        superior.length ? `Solicitar aprobación a ${superior.join(" o ")}.` : "Escalar a la dirección financiera: ningún aprobador del centro cubre el monto."))
    }
    return
  }
  // Aprobador no válido (RC2): se informa si, además, ningún aprobador del centro alcanzaría el monto.
  const topeMax = Math.max(0, ...c.centro.aprobadores.map((x) => x.tope))
  if (c.p.aprobacion?.aprobado && s.valor_total > topeMax) {
    c.bloqueos.push(h("RC3", `El valor ${cop(s.valor_total)} supera el tope máximo de los aprobadores de ${s.centro_costo} (${cop(topeMax)}).`,
      "Escalar a la dirección financiera o dividir la compra con el centro de costo correcto."))
  }
}

/** RC4 — la subárea pertenece al centro de costo. */
function rc4Subarea(c: Ctx): void {
  const s = c.p.solicitud
  const centro = c.m.centros.find((x) => x.centro_costo.toUpperCase() === s.centro_costo.toUpperCase()) ?? null
  if (!centro) {
    c.bloqueos.push(h("RC4", `El centro de costo ${s.centro_costo} no existe en el maestro.`, "Pedir al solicitante el centro de costo correcto."))
    return
  }
  c.centro = centro
  const ok = centro.subareas.some((x) => normalizarNombre(x) === normalizarNombre(s.subarea))
  if (!ok) {
    c.bloqueos.push(h("RC4", `La subárea "${s.subarea}" no pertenece a ${s.centro_costo} (${centro.subareas.join(", ")}).`,
      "Pedir al solicitante la subárea correcta o el centro de costo al que corresponde."))
  }
}

/** RC5 — cotización vs solicitud dentro de ±2 %. Sin cotización: confirmación. */
function rc5Cotizacion(c: Ctx): void {
  const s = c.p.solicitud
  const cot = c.p.cotizacion
  if (!cot) {
    c.confirmaciones.push(h("RC5", "El paquete no trae cotización del proveedor.", "Confirmar que se acepta crear la OC sin cotización (queda como excepción)."))
    return
  }
  const desvio = Math.abs(cot.total - s.valor_total) / s.valor_total
  if (desvio > TOLERANCIA_COTIZACION) {
    c.confirmaciones.push(h("RC5", `La cotización ${cot.referencia ?? ""} suma ${cop(cot.total)} y la solicitud ${cop(s.valor_total)}: diferencia de ${cop(cot.total - s.valor_total)} (${(desvio * 100).toFixed(1)} %), por encima del 2 %.`.replace("  ", " "),
      `Confirmar si se crea la OC por el valor de la solicitud (${cop(s.valor_total)}, el aprobado) o devolver al solicitante para ajustar.`))
  }
  if (cot.validez_hasta && cot.validez_hasta < s.fecha_solicitud) {
    c.advertencias.push(h("RC5-VIG", `La cotización venció el ${cot.validez_hasta}, antes de la fecha de solicitud (${s.fecha_solicitud}).`, "Pedir al proveedor una cotización vigente."))
  }
}

/** RC6 — IVA ausente → se deriva del proveedor y se pide confirmación. */
function rc6Iva(c: Ctx): void {
  const s = c.p.solicitud
  if (s.indicador_iva) {
    if (!c.m.iva.some((x) => x.codigo === s.indicador_iva)) {
      c.bloqueos.push(h("RC6", `El indicador de IVA "${s.indicador_iva}" no existe en el maestro (${c.m.iva.map((x) => x.codigo).join(", ")}).`, "Pedir al solicitante el indicador correcto."))
      return
    }
    c.derivados.indicador_iva = { codigo: s.indicador_iva, fuente: "solicitud" }
    return
  }
  if (!c.proveedor) return
  const cod = c.proveedor.indicador_iva_default
  const desc = c.m.iva.find((x) => x.codigo === cod)?.descripcion ?? "?"
  c.derivados.indicador_iva = { codigo: cod, fuente: "maestro.proveedores.indicador_iva_default" }
  c.confirmaciones.push(h("RC6", `La solicitud no informa indicador de IVA. Se propone ${cod} (${desc}), predeterminado del proveedor en el maestro (${c.proveedor.nombre}).`,
    `Confirmar el indicador ${cod} o indicar otro.`))
}

/** RC7 — condiciones de pago ausentes → se derivan del proveedor. Solo se informa. */
function rc7CondicionesPago(c: Ctx): void {
  const s = c.p.solicitud
  if (s.condiciones_pago) {
    if (!c.m.condiciones.some((x) => x.codigo === s.condiciones_pago)) {
      c.bloqueos.push(h("RC7", `La condición de pago "${s.condiciones_pago}" no existe en el maestro.`, "Pedir al solicitante una condición válida."))
      return
    }
    c.derivados.condiciones_pago = { codigo: s.condiciones_pago, fuente: "solicitud" }
    return
  }
  if (!c.proveedor) return
  c.derivados.condiciones_pago = { codigo: c.proveedor.condiciones_pago_default, fuente: "maestro.proveedores.condiciones_pago_default" }
}

/** RC8 — factura con fecha anterior a la solicitud → retroactiva. */
function rc8Retroactiva(c: Ctx): void {
  const f = c.p.factura
  const s = c.p.solicitud
  if (f && soloFecha(f.fecha) < s.fecha_solicitud) {
    c.retroactiva = true
    c.confirmaciones.push(h("RC8", `OC retroactiva: la factura ${f.numero} (${soloFecha(f.fecha)}, ${cop(f.total)}) es anterior a la solicitud (${s.fecha_solicitud}). La compra se hizo antes de pedir la OC.`,
      "Confirmar la creación; quedará marcada retroactiva = true en el log de control para la medición de la dirección."))
  }
}

/** RC9 — la aprobación es igual o posterior a la solicitud. */
function rc9FechaAprobacion(c: Ctx): void {
  const a = c.p.aprobacion
  const s = c.p.solicitud
  if (a && soloFecha(a.fecha) < s.fecha_solicitud) {
    c.confirmaciones.push(h("RC9", `La aprobación (${soloFecha(a.fecha)}) es anterior a la fecha de la solicitud (${s.fecha_solicitud}).`,
      "Confirmar que la aprobación corresponde a esta solicitud."))
  }
}

/** RC10 — cantidad × valor_unitario = valor_total (± 1). */
function rc10Aritmetica(c: Ctx): void {
  const s = c.p.solicitud
  const calculado = s.cantidad * s.valor_unitario
  if (Math.abs(calculado - s.valor_total) > TOLERANCIA_ARITMETICA) {
    c.bloqueos.push(h("RC10", `cantidad × valor unitario = ${cop(calculado)}, pero el valor total de la solicitud es ${cop(s.valor_total)}.`,
      "Devolver la solicitud al solicitante para corregir cantidades o valores."))
  }
}

/** Orden de ejecución: RC4 antes de RC2/RC3 porque estas necesitan el centro de costo resuelto. */
const REGLAS = [rc10Aritmetica, rc1Proveedor, rc4Subarea, rc2Aprobacion, rc3Tope, rc5Cotizacion, rc6Iva, rc7CondicionesPago, rc8Retroactiva, rc9FechaAprobacion]

export function validarPaquete(p: Paquete, m: Maestros): ResultadoValidacion {
  const c: Ctx = {
    p, m, bloqueos: [], confirmaciones: [], advertencias: [],
    derivados: { proveedor: null, indicador_iva: null, condiciones_pago: null, aprobador: null },
    proveedor: null, centro: null, retroactiva: false,
  }
  for (const regla of REGLAS) regla(c)
  if (p.faltantes.length) {
    c.advertencias.push(h("PAQUETE", `Adjuntos ausentes o ilegibles: ${p.faltantes.join(", ")}.`, "Pedir al solicitante los adjuntos faltantes."))
  }
  const orden = (x: Hallazgo) => Number(x.codigo.replace(/\D/g, "")) || 99
  const ordenar = (xs: Hallazgo[]) => [...xs].sort((a, b) => orden(a) - orden(b))
  return {
    apta: c.bloqueos.length === 0,
    bloqueos: ordenar(c.bloqueos),
    confirmaciones: ordenar(c.confirmaciones),
    advertencias: c.advertencias,
    derivados: c.derivados,
    retroactiva: c.retroactiva,
  }
}
