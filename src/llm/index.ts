// Fábrica del adaptador según variables de entorno. La clave solo se lee aquí y nunca sale del backend.
import type { LlmAdapter } from "./adapter.ts"
import { AnthropicAdapter } from "./anthropic.ts"
import { OpenAiAdapter } from "./openai.ts"

type Proveedor = { clave: string; modelo: string; baseUrl?: string }

/** Proveedores soportados. Gemini y Groq usan su API compatible con OpenAI y tienen nivel gratuito. */
const PROVEEDORES: Record<string, Proveedor> = {
  gemini: { clave: "GEMINI_API_KEY", modelo: "gemini-3.8-flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  groq: { clave: "GROQ_API_KEY", modelo: "openai/gpt-oss-120b", baseUrl: "https://api.groq.com/openai/v1" },
  anthropic: { clave: "ANTHROPIC_API_KEY", modelo: "claude-haiku-4-5" },
  openai: { clave: "OPENAI_API_KEY", modelo: "gpt-4.1-mini", baseUrl: "https://api.openai.com/v1" },
}

export function crearAdaptador(env: Record<string, string | undefined>): { llm: LlmAdapter | null; motivo: string } {
  const nombre = (env.LLM_PROVIDER ?? "gemini").toLowerCase()
  const p = PROVEEDORES[nombre]
  if (!p) return { llm: null, motivo: `Proveedor "${nombre}" no soportado. Usa: ${Object.keys(PROVEEDORES).join(", ")}.` }
  const clave = env[p.clave]
  if (!clave) return { llm: null, motivo: `Falta ${p.clave} en el entorno del backend.` }
  const modelo = env.LLM_MODEL || p.modelo
  const baseUrl = env.LLM_BASE_URL || p.baseUrl
  if (nombre === "anthropic") return { llm: new AnthropicAdapter(clave, modelo, env.LLM_BASE_URL || undefined), motivo: "" }
  return { llm: new OpenAiAdapter(clave, modelo, baseUrl, nombre), motivo: "" }
}
