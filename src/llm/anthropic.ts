// Implementación de LlmAdapter para la Messages API de Anthropic (sin SDK: fetch directo).
import { type LlmAdapter, type Mensaje, type HerramientaSpec, type OpcionesEnvio, type RespuestaLlm, type ToolCall, errorHttp, fetchConTimeout, LlmError } from "./adapter.ts"

type Bloque =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string }

type MensajeAnthropic = { role: "user" | "assistant"; content: string | Bloque[] }

type RespuestaApi = {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
}

/** Convierte el historial neutro al formato de Anthropic: los resultados de herramientas van en un mensaje "user". */
export function aMensajesAnthropic(mensajes: Mensaje[]): MensajeAnthropic[] {
  const out: MensajeAnthropic[] = []
  for (const m of mensajes) {
    if (m.role === "user") {
      const ultimo = out[out.length - 1]
      // La API exige alternar roles: texto de usuario tras resultados de herramientas va en el mismo mensaje.
      if (ultimo?.role === "user" && Array.isArray(ultimo.content)) ultimo.content.push({ type: "text", text: m.content })
      else out.push({ role: "user", content: m.content })
    } else if (m.role === "assistant") {
      const bloques: Bloque[] = []
      if (m.content) bloques.push({ type: "text", text: m.content })
      for (const t of m.toolCalls) bloques.push({ type: "tool_use", id: t.id, name: t.name, input: t.args })
      out.push({ role: "assistant", content: bloques.length ? bloques : "(sin texto)" })
    } else {
      const ultimo = out[out.length - 1]
      const bloque: Bloque = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content }
      if (ultimo?.role === "user" && Array.isArray(ultimo.content)) ultimo.content.push(bloque)
      else out.push({ role: "user", content: [bloque] })
    }
  }
  return out
}

export class AnthropicAdapter implements LlmAdapter {
  readonly provider = "anthropic"
  constructor(private readonly apiKey: string, readonly model: string, private readonly baseUrl = "https://api.anthropic.com") {}

  async enviar(mensajes: Mensaje[], herramientas: HerramientaSpec[], op: OpcionesEnvio): Promise<RespuestaLlm> {
    const cuerpo = {
      model: this.model,
      max_tokens: op.maxTokens,
      // El system prompt es estable entre llamadas: se marca para caché y baja el costo por caso.
      system: [{ type: "text", text: op.system, cache_control: { type: "ephemeral" } }],
      tools: herramientas.map((h) => ({ name: h.name, description: h.description, input_schema: h.parameters })),
      messages: aMensajesAnthropic(mensajes),
    }
    const res = await fetchConTimeout("Anthropic", `${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(cuerpo),
    }, op.signal)
    if (!res.ok) throw errorHttp("Anthropic", res.status)
    let data: RespuestaApi
    try {
      data = (await res.json()) as RespuestaApi
    } catch {
      throw new LlmError("Anthropic: la respuesta del modelo no es JSON válido.")
    }
    const texto = data.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim()
    const toolCalls: ToolCall[] = data.content
      .filter((b) => b.type === "tool_use" && b.id && b.name)
      .map((b) => ({ id: b.id!, name: b.name!, args: b.input ?? {} }))
    const u = data.usage ?? {}
    return {
      texto,
      toolCalls,
      uso: { entrada: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), salida: u.output_tokens ?? 0 },
    }
  }
}
