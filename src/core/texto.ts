// Utilidades de texto, montos y fechas. Funciones puras, sin E/S.

/** Minúsculas, sin tildes, sin puntuación ni sufijos societarios. "Mobiliario Andino S.A." → "mobiliario andino". */
export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(sas|sa|ltda|s en c|eu|sca)\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/** NIT sin puntos, espacios ni dígito de verificación. "900.555.111-2" → "900555111". */
export function normalizarNit(nit: string): string {
  return nit.split("-")[0]!.replace(/[^0-9]/g, "")
}

/** Monto en formato colombiano ("11.400.000" o "1.234,56") a número. Devuelve null si no es numérico. */
export function parsearMonto(texto: string): number | null {
  const limpio = texto.replace(/[^0-9.,]/g, "")
  if (!limpio) return null
  const n = Number(limpio.replace(/\./g, "").replace(",", "."))
  return Number.isFinite(n) ? n : null
}

/** Parte de fecha AAAA-MM-DD de un ISO con zona horaria, en la hora local que trae el propio texto. */
export function soloFecha(iso: string): string {
  return iso.slice(0, 10)
}

export function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${soloFecha(fecha)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

/** Formato de moneda para mensajes humanos. */
export function cop(valor: number): string {
  return `COP ${Math.round(valor).toLocaleString("es-CO")}`
}

/** Corta a `max` caracteres sin partir palabras (límite de 40 del texto breve SAP). */
export function recortar(texto: string, max: number): string {
  const t = texto.replace(/\s+/g, " ").trim()
  if (t.length <= max) return t
  const corte = t.slice(0, max + 1).lastIndexOf(" ")
  let r = corte > max * 0.6 ? t.slice(0, corte) : t.slice(0, max)
  // No terminar en conectores ("…para la mesa de"): se ven como texto cortado en SAP.
  while (/\s(de|del|la|el|los|las|para|con|y|en|a|por|al)$/i.test(r)) r = r.replace(/\s\S+$/, "")
  return r.replace(/[,:;\-\s]+$/, "")
}
