// Implementación de LlmAdapter para Chat Completions de OpenAI (o compatibles: Azure OpenAI, modelos locales
// con API compatible, vía LLM_BASE_URL). Existe para demostrar que cambiar de proveedor no toca el ciclo.
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
  readonly provider = "openai"
  constructor(private readonly apiKey: string, readonly model: string, private readonly baseUrl = "https://api.openai.com/v1") {}

  async enviar(mensajes: Mensaje[], herramientas: HerramientaSpec[], op: OpcionesEnvio): Promise<RespuestaLlm> {
    const res = await fetchConTimeout("OpenAI", `${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        max_completion_tokens: op.maxTokens,
        messages: aMensajesOpenAi(op.system, mensajes),
        tools: herramientas.map((h) => ({ type: "function", function: { name: h.name, description: h.description, parameters: h.parameters } })),
      }),
    }, op.signal)
    if (!res.ok) throw errorHttp("OpenAI", res.status)
    let data: RespuestaApi
    try {
      data = (await res.json()) as RespuestaApi
    } catch {
      throw new LlmError("OpenAI: la respuesta del modelo no es JSON válido.")
    }
    const msg = data.choices[0]?.message
    if (!msg) throw new LlmError("OpenAI: respuesta vacía del modelo.")
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((t) => ({ id: t.id, name: t.function.name, args: parsearArgs(t.function.arguments) }))
    return { texto: (msg.content ?? "").trim(), toolCalls, uso: { entrada: data.usage?.prompt_tokens ?? 0, salida: data.usage?.completion_tokens ?? 0 } }
  }
}
