// Pruebas del ciclo del agente con un modelo guionado (sin red ni clave).
import { describe, expect, test, beforeEach } from "bun:test"
import { cp, mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ejecutarTurno, esAfirmativa, esNegativa, type ConfigCiclo } from "../src/agent/ciclo.ts"
import type { LlmAdapter, Mensaje, RespuestaLlm } from "../src/llm/adapter.ts"
import { LlmError } from "../src/llm/adapter.ts"
import { exigirConfirmacionRegistrada } from "../src/core/confirmaciones.ts"
import type { Sesion } from "../src/agent/sesiones.ts"

/** Modelo falso: devuelve respuestas en orden, como si el LLM las hubiera decidido. */
class Guion implements LlmAdapter {
  readonly provider = "guion"
  readonly model = "test"
  vistos: Mensaje[][] = []
  constructor(private pasos: Array<RespuestaLlm | Error>) {}
  async enviar(m: Mensaje[]): Promise<RespuestaLlm> {
    this.vistos.push([...m])
    const p = this.pasos.shift() ?? { texto: "fin", toolCalls: [], uso: { entrada: 0, salida: 0 } }
    if (p instanceof Error) throw p
    return p
  }
}
const tool = (id: string, name: string, args: Record<string, unknown>): RespuestaLlm => ({ texto: "", toolCalls: [{ id, name, args }], uso: { entrada: 100, salida: 10 } })
const texto = (t: string): RespuestaLlm => ({ texto: t, toolCalls: [], uso: { entrada: 100, salida: 10 } })

let dir = ""
const sesion = (): Sesion => ({ id: "sesion-test", creada: "", mensajes: [], historial: [], tokens: { entrada: 0, salida: 0 }, pendientes: [] })
const cfg = (llm: LlmAdapter, extra: Partial<ConfigCiclo> = {}): ConfigCiclo => ({
  llm, system: "test", directory: dir, maxIteraciones: 25, maxTokensSesion: 1_000_000, maxTokensRespuesta: 512, timeoutMs: 5000, ...extra,
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agente-"))
  await cp(join(import.meta.dir, "..", "fixtures"), join(dir, "fixtures"), { recursive: true })
  exigirConfirmacionRegistrada(true)
})

describe("confirmación humana (CA3)", () => {
  test("el modelo no puede crear sol-004 con confirmado=true si la analista no confirmó", async () => {
    const s = sesion()
    const llm = new Guion([tool("1", "oc_validar", { caso: "sol-004" }), tool("2", "oc_crear", { caso: "sol-004", confirmado: true }), texto("¿Confirmas?")])
    const r = await ejecutarTurno(s, "procesa sol-004", cfg(llm))
    expect(r.toolCalls[1]!.ok).toBe(false)
    expect(r.needsConfirmation).toBe(true)
    expect(r.pendientes).toEqual(["sol-004"])
  })

  test("tras 'confirmo' de la analista, oc_crear procede", async () => {
    const s = sesion()
    await ejecutarTurno(s, "procesa sol-004", cfg(new Guion([tool("1", "oc_validar", { caso: "sol-004" }), texto("¿Confirmas?")])))
    const r = await ejecutarTurno(s, "Sí, confirmo", cfg(new Guion([tool("2", "oc_crear", { caso: "sol-004", confirmado: true }), texto("OC creada")])))
    expect(r.toolCalls[0]!.ok).toBe(true)
    expect((r.toolCalls[0]!.resultado as { data: { numero_oc: string } }).data.numero_oc).toBe("4500000001")
    expect(r.needsConfirmation).toBe(false)
  })

  test("si la analista dice que no, la confirmación no se registra", async () => {
    const s = sesion()
    await ejecutarTurno(s, "procesa sol-006", cfg(new Guion([tool("1", "oc_validar", { caso: "sol-006" }), texto("¿Confirmas?")])))
    const r = await ejecutarTurno(s, "No, no la crees", cfg(new Guion([tool("2", "oc_crear", { caso: "sol-006", confirmado: true }), texto("ok")])))
    expect(r.toolCalls[0]!.ok).toBe(false)
  })

  test("interpretación de respuestas", () => {
    expect(esAfirmativa("confirmo")).toBe(true)
    expect(esAfirmativa("Sí, créala")).toBe(true)
    expect(esAfirmativa("no la crees")).toBe(false)
    expect(esNegativa("No, espera")).toBe(true)
  })
})

describe("robustez del ciclo", () => {
  test("CA1: al llegar al tope responde con lo que tiene y lo que falta", async () => {
    const pasos = Array.from({ length: 5 }, (_, i) => tool(String(i), "oc_listar_casos", {}))
    const r = await ejecutarTurno(sesion(), "bucle", cfg(new Guion(pasos), { maxIteraciones: 3 }))
    expect(r.toolCalls.length).toBe(3)
    expect(r.reply).toContain("tope de 3 pasos")
  })

  test("CA5: un error del proveedor se informa y la sesión sigue", async () => {
    const s = sesion()
    const r1 = await ejecutarTurno(s, "hola", cfg(new Guion([new LlmError("Anthropic: el modelo no respondió a tiempo.")])))
    expect(r1.error).toBe(true)
    expect(r1.reply).toContain("no respondió a tiempo")
    const r2 = await ejecutarTurno(s, "hola otra vez", cfg(new Guion([texto("Aquí estoy")])))
    expect(r2.reply).toBe("Aquí estoy")
  })

  test("argumentos inválidos vuelven al modelo como error, no rompen el turno", async () => {
    const r = await ejecutarTurno(sesion(), "x", cfg(new Guion([tool("1", "oc_leer_paquete", { caso: 123 }), texto("ok")])))
    expect(r.toolCalls[0]!.ok).toBe(false)
    expect(r.toolCalls[0]!.resumen).toContain("Argumentos inválidos")
  })

  test("tope de tokens por sesión", async () => {
    const s = sesion()
    s.tokens = { entrada: 999, salida: 1 }
    const r = await ejecutarTurno(s, "x", cfg(new Guion([texto("no debería llegar")]), { maxTokensSesion: 1000 }))
    expect(r.reply).toContain("tope")
  })
})
