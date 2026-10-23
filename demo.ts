// demo.ts — Verificación sin modelo de lenguaje (PRD 6.6).
// Procesa los 6 casos llamando directamente a las herramientas. No necesita clave de ningún proveedor.
//   bun install && bun run demo.ts
import { rm } from "node:fs/promises"
import * as oc from "./src/tools/oc.ts"
import { listarCasos } from "./src/core/fixtures.ts"
import { exigirConfirmacionRegistrada, registrarConfirmacion } from "./src/core/confirmaciones.ts"
import { resumenControl } from "./src/core/registro.ts"
import { rutas } from "./src/core/rutas.ts"
import type { ToolCtx } from "./src/core/tipos.ts"

const directory = import.meta.dir
const ctx: ToolCtx = { directory, sessionId: "demo" }

type R = { ok: boolean; error?: string; data?: Record<string, unknown> }
const llamar = async (h: { execute(a: never, c: ToolCtx): Promise<string> }, args: object): Promise<R> =>
  JSON.parse(await h.execute(args as never, ctx)) as R

const codigos = (v: unknown): string => (Array.isArray(v) && v.length ? v.map((x: { codigo: string }) => x.codigo).join(", ") : "—")
const linea = (s = "") => console.log(s)
const titulo = (s: string) => linea(`\n\x1b[1m${s}\x1b[0m\n${"─".repeat(s.length)}`)

type Fila = { caso: string; apta: string; bloqueos: string; confirmaciones: string; retroactiva: string; resultado: string }
const tabla: Fila[] = []

async function procesar(caso: string, confirmado = false): Promise<Fila> {
  const v = await llamar(oc.validar, { caso })
  if (!v.ok) return { caso, apta: "error", bloqueos: "—", confirmaciones: "—", retroactiva: "—", resultado: v.error ?? "" }
  const d = v.data!
  const fila: Fila = {
    caso, apta: String(d.apta), bloqueos: codigos(d.bloqueos), confirmaciones: codigos(d.confirmaciones),
    retroactiva: String(d.retroactiva), resultado: "",
  }
  if (!d.apta) {
    const bs = d.bloqueos as { codigo: string; detalle: string; accion_sugerida: string }[]
    fila.resultado = "BLOQUEADA, no se crea OC\n" + bs.map((b) => `           ${b.codigo}: ${b.detalle}\n             acción: ${b.accion_sugerida}`).join("\n")
    return fila
  }
  await llamar(oc.generar_evidencia, { caso })
  const p = await llamar(oc.construir_payload, { caso })
  if (!p.ok) {
    fila.resultado = `ERROR payload: ${p.error}`
    return fila
  }
  const c = await llamar(oc.crear, { caso, confirmado })
  fila.resultado = c.ok
    ? `OC ${c.data!.numero_oc}${c.data!.idempotente ? " (idempotente)" : ""}`
    : `PENDIENTE — ${c.error}`
  return fila
}

async function main() {
  await rm(rutas.out(directory), { recursive: true, force: true }) // determinismo: out/ limpio
  exigirConfirmacionRegistrada(true) // misma política estricta que el servidor

  titulo("1. Primera pasada: los 6 casos sin confirmación humana")
  for (const caso of await listarCasos(directory)) {
    const f = await procesar(caso)
    tabla.push(f)
    linea(`${caso}  apta=${f.apta}  bloqueos=[${f.bloqueos}]  confirmaciones=[${f.confirmaciones}]  retroactiva=${f.retroactiva}`)
    linea(`         → ${f.resultado}`)
  }

  titulo("2. Idempotencia: sol-001 por segunda vez")
  const again = await llamar(oc.crear, { caso: "sol-001" })
  linea(`sol-001 → OC ${again.data?.numero_oc}  idempotente=${again.data?.idempotente}`)

  titulo("3. El modelo no puede auto-confirmar: crear(sol-004, confirmado=true) sin confirmación registrada")
  const auto = await llamar(oc.crear, { caso: "sol-004", confirmado: true })
  linea(`sol-004 → ok=${auto.ok}  ${auto.error ?? ""}`)

  titulo("4. Confirmación explícita de la analista y creación")
  for (const caso of ["sol-004", "sol-005", "sol-006"]) {
    registrarConfirmacion("demo", caso, "analista@periferia (demo.ts)")
    const c = await llamar(oc.crear, { caso, confirmado: true })
    const ev = c.data?.evidencia as { pdf: string } | undefined
    linea(c.ok
      ? `${caso} → OC ${c.data!.numero_oc}  retroactiva=${c.data!.retroactiva}  excepciones=[${codigos(c.data!.excepciones_confirmadas)}]  evidencia=${ev?.pdf}`
      : `${caso} → ${c.error}`)
  }

  titulo("5. Robustez: caso inexistente y nombre de caso malicioso")
  linea(`sol-999        → ${(await llamar(oc.leer_paquete, { caso: "sol-999" })).error}`)
  linea(`../../etc      → ${(await llamar(oc.leer_paquete, { caso: "../../etc" })).error}`)

  titulo("6. Log de control (out/control.csv)")
  const r = await resumenControl(directory)
  linea(`Solicitudes: ${r.solicitudes} · OC creadas: ${r.creadas} · retroactivas: ${r.retroactivas} (${r.pct_retroactivas_sobre_creadas} % de las creadas)`)
  linea(`Último estado: ${JSON.stringify(r.ultimo_estado)}`)
  linea("\nArchivos: out/sap/ordenes.jsonl · out/control.csv · out/<caso>/{aprobacion.txt,aprobacion.pdf,payload.json,trazabilidad.json,orden.json}")
}

await main()
