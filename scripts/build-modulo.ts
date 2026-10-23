// Genera modulo/agent.md y modulo/skill/ordenes-compra/SKILL.md a partir de las MISMAS fuentes que usa la app
// (agent/prompt.md y src/knowledge/ordenes-compra.md). modulo/tools/oc.ts re-exporta src/tools/oc.ts.
// tests/modulo.test.ts falla si alguien edita una copia y no la fuente.
//   bun run modulo
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"

const RAIZ = join(import.meta.dir, "..")

export const FRONTMATTER_AGENTE = `---
description: Agente de órdenes de compra SAP — lee el paquete de la solicitud, valida RC1–RC10 contra maestros, construye la OC con trazabilidad, genera la evidencia de aprobación y crea la OC con confirmación humana para excepciones.
mode: primary
permission:
  edit: deny
  bash: deny
---

`

export const FRONTMATTER_SKILL = `---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia — matriz de controles RC1–RC10, qué hacer ante cada excepción, glosario SAP (indicadores de IVA, condiciones de pago, unidades) y evidencias que se generan.
---

`

export async function contenidoEsperado() {
  const [prompt, conocimiento] = await Promise.all([
    readFile(join(RAIZ, "agent", "prompt.md"), "utf8"),
    readFile(join(RAIZ, "src", "knowledge", "ordenes-compra.md"), "utf8"),
  ])
  return { agente: FRONTMATTER_AGENTE + prompt, skill: FRONTMATTER_SKILL + conocimiento }
}

if (import.meta.main) {
  const { agente, skill } = await contenidoEsperado()
  await mkdir(join(RAIZ, "modulo", "skill", "ordenes-compra"), { recursive: true })
  await writeFile(join(RAIZ, "modulo", "agent.md"), agente, "utf8")
  await writeFile(join(RAIZ, "modulo", "skill", "ordenes-compra", "SKILL.md"), skill, "utf8")
  console.log("modulo/ regenerado desde agent/prompt.md y src/knowledge/ordenes-compra.md")
}
