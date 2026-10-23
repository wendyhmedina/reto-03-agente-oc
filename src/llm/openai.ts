// Implementación de LlmAdapter para Chat Completions de OpenAI y APIs compatibles (Google Gemini, Groq,
// Azure OpenAI, modelos locales). Cambiar de proveedor no toca el ciclo del agente.
import { type LlmAdapter, type Mensaje, type HerramientaSpec, type OpcionesEnvio, type RespuestaLlm, type ToolCall, errorHttp, fetchConTimeout, LlmError } from "./adapter.ts"

type MensajeOpenAi =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string }

type RespuestaApi = {
  choices: Array<{ message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function aMensajesOpenAi(system: string, mensajes: Mensaje[]): MensajeOpenAi[] {
  const out: MensajeOpenAi[] = [{ role: "system", content: system }]
  for (const m of mensajes) {
    if (m.role === "user") out.push({ role: "user", content: m.content })
    else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls.length
          ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function" as const, function: { name: t.name, arguments: JSON.stringify(t.args) } })) }
          : {}),
      })
    } else out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content })
  }
  return out
}

function parsearArgs(texto: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(texto || "{}")
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  } catch {
    return { __argumentos_invalidos: texto }
  }
}

/**
 * Gemini y otras APIs compatibles aceptan solo un subconjunto de JSON Schema: se quitan
 * `propertyNames` y `additionalProperties`, y una herramienta sin argumentos se envía sin `parameters`.
 */
export function esquemaCompatible(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(esquemaCompatible)
  if (!schema || typeof schema !== "object") return schema
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema)) {
    if (k === "propertyNames" || k === "additionalProperties" || k === "$schema") continue
    out[k] = esquemaCompatible(v)
  }
  return out
}

/** Quita argumentos opcionales de forma libre (objeto sin propiedades): Gemini los rechaza y el agente no los necesita. */
function sinObjetosLibres(p: Record<string, unknown>): Record<string, unknown> {
  const props = (p.properties ?? {}) as Record<string, Record<string, unknown>>
  const requeridos = (p.required ?? []) as string[]
  const filtradas = Object.fromEntries(
    Object.entries(props).filter(([k, v]) => requeridos.includes(k) || !(v.type === "object" && !v.properties)),
  )
  return { ...p, properties: filtradas }
}

const sinPropiedades = (p: Record<string, unknown>) =>
  !p.properties || Object.keys(p.properties as Record<string, unknown>).length === 0

/**
 * Segundos a esperar antes de reintentar: lo que indique el proveedor (header retry-after o el texto
 * "try again in 5.4s" de Groq), o 2, 4, 8… Con tope de 30 s por espera.
 */
async function segundosDeEspera(res: Response, intento: number): Promise<number> {
  const h = Number(res.headers.get("retry-after"))
  let base = Number.isFinite(h) && h > 0 ? h : 0
  try {
    const m = (await res.clone().text()).match(/try again in (?:(\d+)m)?([\d.]+)s/i)
    if (m) base = Math.max(base, Number(m[1] ?? 0) * 60 + Number(m[2]))
  } catch {
    // sin cuerpo legible: se usa la espera exponencial
  }
  return Math.min(Math.ceil(base || 2 ** intento) + 1, 30)
}

/** Detalle corto del error del proveedor para diagnosticar (el cuerpo no contiene la clave). */
async function detalleError(res: Response): Promise<string> {
  try {
    const t = (await res.text()).replace(/\s+/g, " ")
    const m = t.match(/"message"\s*:\s*"((?:[^"\\]|\\.){1,220})/)
    return ` Detalle: ${m ? m[1] : t.slice(0, 200)}`
  } catch {
    return ""
  }
}

export class OpenAiAdapter implements LlmAdapter {
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl = "https://api.openai.com/v1",
    readonly provider = "openai",
  ) {}

  private herramientas(herramientas: HerramientaSpec[]) {
    const compat = this.provider !== "openai"
    return herramientas.map((h) => {
      const parameters = compat ? sinObjetosLibres(esquemaCompatible(h.parameters) as Record<string, unknown>) : h.parameters
      const fn = compat && sinPropiedades(parameters) ? { name: h.name, description: h.description } : { name: h.name, description: h.description, parameters }
      return { type: "function", function: fn }
    })
  }

  async enviar(mensajes: Mensaje[], herramientas: HerramientaSpec[], op: OpcionesEnvio): Promise<RespuestaLlm> {
    const cuerpo = JSON.stringify({
      model: this.model,
      // OpenAI usa max_completion_tokens; las APIs compatibles (Gemini, Groq) aceptan max_tokens.
      ...(this.provider === "openai" ? { max_completion_tokens: op.maxTokens } : { max_tokens: op.maxTokens }),
      messages: aMensajesOpenAi(op.system, mensajes),
      tools: this.herramientas(herramientas),
    })
    const llamar = () => fetchConTimeout(this.provider, `${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: cuerpo,
    }, op.signal)
    // Reintentos ante límite de tasa o falla temporal (429 / 5xx). Los niveles gratuitos limitan
    // tokens por minuto: se espera lo que indica el proveedor (header retry-after o "try again in Xs").
    let res = await llamar()
    for (let intento = 1; intento <= 6 && (res.status === 429 || res.status >= 500); intento++) {
      const espera = await segundosDeEspera(res, intento)
      await new Promise((r) => setTimeout(r, espera * 1000))
      res = await llamar()
    }
    if (!res.ok) {
      const e = errorHttp(this.provider, res.status)
      throw new LlmError(e.message + (await detalleError(res)), res.status)
    }
    let data: RespuestaApi
    try {
      data = (await res.json()) as RespuestaApi
    } catch {
      throw new LlmError(`${this.provider}: la respuesta del modelo no es JSON válido.`)
    }
    const msg = data.choices[0]?.message
    if (!msg) throw new LlmError(`${this.provider}: respuesta vacía del modelo.`)
    // Algunos proveedores compatibles no envían id en la llamada: se genera uno para enlazar el resultado.
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((t, i) => ({ id: t.id || `call_${Date.now()}_${i}`, name: t.function.name, args: parsearArgs(t.function.arguments) }))
    return { texto: (msg.content ?? "").trim(), toolCalls, uso: { entrada: data.usage?.prompt_tokens ?? 0, salida: data.usage?.completion_tokens ?? 0 } }
  }
}
