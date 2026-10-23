// Resolución de rutas. Todo se resuelve desde ctx.directory (raíz del proyecto);
// nunca se aceptan rutas absolutas ni "..": el nombre del caso se valida con una regex.
import { join } from "node:path"

const CASO_VALIDO = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export function casoValido(caso: string): boolean {
  return CASO_VALIDO.test(caso)
}

export const rutas = {
  maestros: (dir: string) => join(dir, "fixtures", "reto-03", "maestros"),
  solicitudes: (dir: string) => join(dir, "fixtures", "reto-03", "solicitudes"),
  caso: (dir: string, caso: string) => join(dir, "fixtures", "reto-03", "solicitudes", caso),
  out: (dir: string) => join(dir, "out"),
  outCaso: (dir: string, caso: string) => join(dir, "out", caso),
  sap: (dir: string) => join(dir, "out", "sap"),
  control: (dir: string) => join(dir, "out", "control.csv"),
  log: (dir: string) => join(dir, "out", "log.jsonl"),
  sesiones: (dir: string) => join(dir, "out", "sesiones"),
}

/** Ruta relativa a la raíz, para mostrar en respuestas sin exponer el disco del servidor. */
export function relativa(dir: string, ruta: string): string {
  return ruta.startsWith(dir) ? ruta.slice(dir.length).replace(/^[/\\]/, "") : ruta
}
