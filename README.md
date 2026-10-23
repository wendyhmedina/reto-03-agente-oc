# Agente de Órdenes de Compra SAP — Reto 03

Agente conversacional que lee el paquete de una solicitud de compra, lo valida contra maestros y controles (RC1–RC10), muestra la OC tal como quedaría en SAP, genera la evidencia de aprobación (TXT + PDF con sha256) y crea la OC en un SAP simulado, pidiendo confirmación humana para las excepciones. El planteamiento completo está en [`SOLUCION.md`](SOLUCION.md).

**Link de prueba:** `https://<pendiente>.onrender.com` · **Clave de acceso:** `<si se configura APP_ACCESS_KEY>`

## Levantar en local (un comando)

Requisitos: [Bun](https://bun.sh) 1.1 o superior.

```bash
cp .env.example .env        # y escribe tu GEMINI_API_KEY (gratis en https://aistudio.google.com/apikey)
bun install && bun run dev  # http://localhost:3000
```

Bun carga `.env` automáticamente. Sin clave el chat abre y avisa que el modelo no está configurado; las herramientas y `demo.ts` funcionan igual.

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `LLM_PROVIDER` | No (`gemini`) | `gemini` (nivel gratuito), `groq` (nivel gratuito), `anthropic` u `openai`. |
| `LLM_MODEL` | No | Por defecto `gemini-2.5-flash` / `llama-3.3-70b-versatile` / `claude-haiku-4-5` / `gpt-4.1-mini`. |
| `GEMINI_API_KEY` / `GROQ_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Sí (solo la del proveedor elegido) | Solo vive en el backend. Nunca va al front, al repositorio ni a los logs. |
| `LLM_BASE_URL` | No | Para otras APIs compatibles con OpenAI (Azure OpenAI, modelos locales). |
| `LLM_TIMEOUT_MS` | No (`60000`) | Timeout por llamada al modelo. |
| `MAX_ITERACIONES` | No (`25`) | Tope de pasos herramienta → modelo por turno. |
| `MAX_TOKENS_SESION` | No (`300000`) | Tope de tokens por sesión. |
| `APP_ACCESS_KEY` | No | Si se define, el chat pide esta clave (protege el link público). |
| `PORT` | No (`3000`) | Puerto HTTP. |

## Verificación sin modelo

```bash
bun install && bun run demo.ts   # procesa los 6 casos llamando directo a las herramientas
bun test                         # 26 pruebas: reglas, robustez, ciclo del agente con modelo guionado, módulo
bun run typecheck                # TypeScript estricto, sin any
```

`demo.ts` limpia `out/`, procesa los 6 casos, repite `sol-001` (idempotencia), muestra que el modelo no puede auto-confirmar y confirma explícitamente `sol-004`, `sol-005` y `sol-006`. Resultado esperado:

| Caso | apta | Bloqueos | Confirmaciones | Retroactiva | Resultado |
|---|---|---|---|---|---|
| sol-001 | true | — | — | false | OC 4500000001 (y luego idempotente) |
| sol-002 | false | RC1 | — | false | Bloqueada: proveedor inexistente |
| sol-003 | false | RC2, RC3 | — | false | Bloqueada: aprobador de otro centro, monto sobre el tope |
| sol-004 | true | — | RC5 | false | Pendiente → confirmada → OC 4500000002 |
| sol-005 | true | — | RC8 | **true** | Pendiente → confirmada → OC 4500000003 |
| sol-006 | true | — | RC6 | false | Pendiente → confirmada → OC 4500000004 |

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, pendientes[], tokens }` |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión (mensajes y llamadas a herramientas). |
| `GET` | `/api/health` | `{ ok, provider, model, configurado }` sin exponer claves. |
| `GET` | `/api/casos` | Casos disponibles en `fixtures/`. |
| `GET` | `/api/control` | Resumen de `out/control.csv` (OC creadas, retroactivas, % retroactivas). |
| `GET` | `/api/evidencia/:caso/{aprobacion.pdf, aprobacion.txt, payload.json, trazabilidad.json}` | Archivos generados del caso. |

Si `APP_ACCESS_KEY` está definida, las rutas `/api/*` (salvo `health`) exigen el header `x-access-key` (o `?k=` en los enlaces de evidencia).

## Desplegar el link público (Render, gratis)

1. Sube el repositorio a GitHub.
2. En [render.com](https://render.com): **New → Blueprint** y selecciona el repositorio (usa `render.yaml` y el `Dockerfile`).
3. Escribe `GEMINI_API_KEY` (y opcionalmente `APP_ACCESS_KEY`) en el panel de variables.
4. Cuando termine el build, copia la URL en la parte superior de este README.

Cualquier plataforma que corra Docker sirve igual (Railway, Fly.io, Azure Container Apps). El plan gratuito de Render se duerme tras 15 min sin uso: abre el link unos minutos antes de la defensa.

## Estructura

```
agent/prompt.md                 comportamiento del agente (system prompt)
src/knowledge/ordenes-compra.md conocimiento del proceso
src/tools/oc.ts                 herramientas (cada export → oc_<export>)
src/core/                       reglas RC1–RC10, parsers, payload, evidencia, log de control
src/sap/adapter.ts · mock.ts    interfaz SapAdapter y SAP simulado sobre out/sap/
src/llm/                        interfaz LlmAdapter + Anthropic + compatibles OpenAI (Gemini, Groq, OpenAI)
src/agent/                      ciclo del agente, registro de herramientas, sesiones
src/server.ts                   API HTTP + front estático
web/                            chat (HTML + JS sin build)
modulo/                         bonus: agente empaquetado (se regenera con `bun run modulo`)
demo.ts                         verificación sin modelo
tests/                          pruebas
fixtures/                       entregados por Periferia (sin modificar)
```
