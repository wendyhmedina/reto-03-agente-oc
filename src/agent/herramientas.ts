// Registro de herramientas: convierte cada export de src/tools/oc.ts en "oc_<export>",
// genera su JSON Schema desde zod y valida los argumentos antes de ejecutar.
import { z } from "zod"
import * as oc from "../tools/oc.ts"
import type { HerramientaSpec } from "../llm/adapter.ts"
import type { ToolCtx } from "../core/tipos.ts"

type Definicion = { description: string; args: z.ZodRawShape; execute(args: never, ctx: ToolCtx): Promise<string> }

function esHerramienta(v: unknown): v is Definicion {
  return typeof v === "object" && v !== null && "description" in v && "args" in v && "execute" in v
}

type Registrada = { spec: HerramientaSpec; esquema: z.ZodObject; def: Definicion }

function registrar(prefijo: string, modulo: Record<string, unknown>): Map<string, Registrada> {
  const mapa = new Map<string, Registrada>()
  for (const [exportName, valor] of Object.entries(modulo)) {
    if (!esHerramienta(valor)) continue
    const nombre = `${prefijo}_${exportName}`
    const esquema = z.object(valor.args)
    const parameters = z.toJSONSchema(esquema) as Record<string, unknown>
    delete parameters.$schema
    mapa.set(nombre, { spec: { name: nombre, description: valor.description, parameters }, esquema, def: valor })
  }
  return mapa
}

const registro = registrar("oc", oc)

export const especificaciones: HerramientaSpec[] = [...registro.values()].map((r) => r.spec)

/** Valida con zod y ejecuta. Un error de validación vuelve al modelo como resultado, no rompe el turno. */
export async function ejecutarHerramienta(nombre: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const r = registro.get(nombre)
  if (!r) return JSON.stringify({ ok: false, error: `La herramienta "${nombre}" no existe. Disponibles: ${[...registro.keys()].join(", ")}.` })
  const parsed = r.esquema.safeParse(args)
  if (!parsed.success) {
    const detalle = parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ")
    return JSON.stringify({ ok: false, error: `Argumentos inválidos para ${nombre}: ${detalle}` })
  }
  return r.def.execute(parsed.data as never, ctx)
}
