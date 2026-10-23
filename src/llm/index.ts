// Fábrica del adaptador según variables de entorno. La clave solo se lee aquí y nunca sale del backend.
import type { LlmAdapter } from "./adapter.ts"
import { AnthropicAdapter } from "./anthropic.ts"
import { OpenAiAdapter } from "./openai.ts"

const MODELO_POR_DEFECTO: Record<string, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4.1-mini",
}

export function crearAdaptador(env: Record<string, string | undefined>): { llm: LlmAdapter | null; motivo: string } {
  const proveedor = (env.LLM_PROVIDER ?? "anthropic").toLowerCase()
  const modelo = env.LLM_MODEL || MODELO_POR_DEFECTO[proveedor] || ""
  if (proveedor === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) return { llm: null, motivo: "Falta ANTHROPIC_API_KEY en el entorno del backend." }
    return { llm: new AnthropicAdapter(env.ANTHROPIC_API_KEY, modelo, env.LLM_BASE_URL || undefined), motivo: "" }
  }
  if (proveedor === "openai") {
    if (!env.OPENAI_API_KEY) return { llm: null, motivo: "Falta OPENAI_API_KEY en el entorno del backend." }
    return { llm: new OpenAiAdapter(env.OPENAI_API_KEY, modelo, env.LLM_BASE_URL || undefined), motivo: "" }
  }
  return { llm: null, motivo: `Proveedor "${proveedor}" no soportado. Usa anthropic u openai.` }
}
