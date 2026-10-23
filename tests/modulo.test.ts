// El bonus exige que modulo/ use las mismas piezas que la app, no copias divergentes.
import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { contenidoEsperado } from "../scripts/build-modulo.ts"
import * as appTools from "../src/tools/oc.ts"
import * as moduloTools from "../modulo/tools/oc.ts"

const RAIZ = join(import.meta.dir, "..")

test("modulo/agent.md y SKILL.md están sincronizados con sus fuentes", async () => {
  const esperado = await contenidoEsperado()
  expect(await readFile(join(RAIZ, "modulo", "agent.md"), "utf8")).toBe(esperado.agente)
  expect(await readFile(join(RAIZ, "modulo", "skill", "ordenes-compra", "SKILL.md"), "utf8")).toBe(esperado.skill)
})

test("modulo/tools/oc.ts expone los mismos objetos que la app", () => {
  for (const nombre of ["leer_paquete", "validar", "construir_payload", "generar_evidencia", "crear"] as const) {
    expect(moduloTools[nombre]).toBe(appTools[nombre])
  }
})
