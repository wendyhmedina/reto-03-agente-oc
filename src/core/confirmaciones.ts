// Confirmación humana (CA3). El backend registra aquí que la analista confirmó un caso
// en su propio mensaje; oc_crear con confirmado=true solo procede si ese registro existe.
// Así el modelo no puede "auto-confirmar" pasando confirmado=true por su cuenta.
//
// Fuera del servidor (demo.ts o el módulo reutilizable en otra plataforma) la política es
// configurable: la plataforma anfitriona decide cómo obtiene la confirmación humana.

type Confirmacion = { caso: string; por: string; ts: string }

const registro = new Map<string, Map<string, Confirmacion>>()
let exigirRegistro = false

/** El servidor activa la verificación estricta al arrancar. */
export function exigirConfirmacionRegistrada(valor: boolean): void {
  exigirRegistro = valor
}

export function registrarConfirmacion(sessionId: string, caso: string, por: string): Confirmacion {
  const c: Confirmacion = { caso, por, ts: new Date().toISOString() }
  if (!registro.has(sessionId)) registro.set(sessionId, new Map())
  registro.get(sessionId)!.set(caso, c)
  return c
}

export function revocarConfirmacion(sessionId: string, caso: string): void {
  registro.get(sessionId)?.delete(caso)
}

/** Devuelve quién confirmó, o null si no hay confirmación válida para el caso en esa sesión. */
export function confirmacionDe(sessionId: string, caso: string, confirmadoFlag: boolean): { por: string } | null {
  if (!confirmadoFlag) return null
  const c = registro.get(sessionId)?.get(caso)
  if (c) return { por: c.por }
  return exigirRegistro ? null : { por: `confirmado vía herramienta (sesión ${sessionId})` }
}
