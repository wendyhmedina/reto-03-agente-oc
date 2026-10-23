// Interfaz propia del proveedor de modelo (PRD 6.1). El ciclo del agente solo conoce estos tipos:
// cambiar de Anthropic a OpenAI (o a otro) es agregar un archivo que implemente LlmAdapter.

export type ToolCall = { id: string; name: string; args: Record<string, unknown> }

export type Mensaje =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string }

export type HerramientaSpec = { name: string; description: string; parameters: Record<string, unknown> }

export type RespuestaLlm = {
  texto: string
  toolCalls: ToolCall[]
  uso: { entrada: number; salida: number }
}

export type OpcionesEnvio = { system: string; signal: AbortSignal; maxTokens: number }

export interface LlmAdapter {
  readonly provider: string
  readonly model: string
  enviar(mensajes: Mensaje[], herramientas: HerramientaSpec[], opciones: OpcionesEnvio): Promise<RespuestaLlm>
}

/** Error del proveedor con un mensaje apto para mostrar en el chat (sin claves ni cuerpos crudos). */
export class LlmError extends Error {
  constructor(mensaje: string, readonly status?: number) {
    super(mensaje)
    this.name = "LlmError"
  }
}

/** Traduce errores HTTP del proveedor a lenguaje claro (CA5). */
export function errorHttp(proveedor: string, status: number): LlmError {
  const motivo =
    status === 401 || status === 403 ? "la clave del modelo no es válida o no tiene permisos"
    : status === 429 ? "el proveedor limitó la tasa de peticiones; intenta de nuevo en unos segundos"
    : status === 400 ? "el proveedor rechazó la petición (revisa el nombre del modelo configurado)"
    : status >= 500 ? "el proveedor tiene una falla temporal"
    : `respuesta inesperada (HTTP ${status})`
  return new LlmError(`${proveedor}: ${motivo}.`, status)
}

/** fetch con timeout que distingue "se acabó el tiempo" de otros fallos de red. */
export async function fetchConTimeout(proveedor: string, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal })
  } catch (e) {
    const nombre = (e as Error).name
    if (nombre === "TimeoutError" || nombre === "AbortError") {
      throw new LlmError(`${proveedor}: el modelo no respondió a tiempo. Intenta de nuevo.`)
    }
    throw new LlmError(`${proveedor}: no se pudo conectar con el proveedor del modelo.`)
  }
}
