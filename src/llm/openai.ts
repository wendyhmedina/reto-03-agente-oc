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

export class OpenAiAdapter implements LlmAdapter {
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl = "https://api.openai.com/v1",
    readonly provider = "openai",
  ) {}

  async enviar(mensajes: Mensaje[], herramientas: HerramientaSpec[], op: OpcionesEnvio): Promise<RespuestaLlm> {
    const res = await fetchConTimeout(this.provider, `${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        // OpenAI usa max_completion_tokens; las APIs compatibles (Gemini, Groq) aceptan max_tokens.
        ...(this.provider === "openai" ? { max_completion_tokens: op.maxTokens } : { max_tokens: op.maxTokens }),
        messages: aMensajesOpenAi(op.system, mensajes),
        tools: herramientas.map((h) => ({ type: "function", function: { name: h.name, description: h.description, parameters: h.parameters } })),
      }),
    }, op.signal)
    if (!res.ok) throw errorHttp(this.provider, res.status)
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
