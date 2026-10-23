# SOLUCIÓN — Reto 03 · Agente conversacional "Órdenes de Compra SAP"

**Candidata:** Wendy Hernández Medina · Periferia IT Group · Equipo Perxia 2.0

---

## 1. Problema en una frase

La analista administrativa digita a mano cada orden de compra en SAP y valida de memoria que el proveedor, el aprobador, el monto y el centro de costo sean correctos; eso cuesta tiempo, deja pasar errores que se corrigen en el cierre contable y no permite medir cuántas OC se crean después de que llega la factura.

**A quién le duele:** a la analista (tiempo y errores), a Contabilidad/Auditoría (control y evidencia) y a la dirección (no sabe qué porcentaje de compras se salta el proceso).

---

## 2. Arquitectura

```
┌───────────────────────┐   POST /api/chat    ┌────────────────────────────────────────────────────┐
│ web/ (HTML + JS)      │ ──────────────────▶ │ src/server.ts  (Bun.serve)                         │
│ · historial           │ ◀────────────────── │   └─ src/agent/ciclo.ts   ciclo del agente         │
│ · tarjetas de tools   │  reply, toolCalls,  │        ├─ src/llm/adapter.ts  interfaz enviar()    │
│ · banner confirmación │  needsConfirmation  │        │    ├─ anthropic.ts   (por defecto)         │
│ · log de control      │                     │        │    └─ openai.ts      (alternativa)         │
└───────────────────────┘                     │        ├─ src/agent/herramientas.ts  registro + zod │
                                              │        └─ src/agent/sesiones.ts  memoria + archivo  │
                                              └───────────────┬────────────────────────────────────┘
                                                              │ execute(args, ctx)
                                              ┌───────────────▼────────────────────────────────────┐
                                              │ src/tools/oc.ts   (oc_leer_paquete, oc_validar,    │
                                              │   oc_construir_payload, oc_generar_evidencia,      │
                                              │   oc_crear, oc_listar_casos)                       │
                                              │    ├─ src/core/  reglas RC1–RC10, parsers, payload,│
                                              │    │             evidencia, registro de control    │
                                              │    └─ src/sap/adapter.ts → mock.ts (archivos)      │
                                              └───────┬───────────────────────────┬────────────────┘
                                                      │ solo lectura              │ escritura
                                              fixtures/reto-03/            out/ (sap/, control.csv,
                                                                           log.jsonl, <caso>/, sesiones/)
```

| Capa | Dónde vive | Qué cambia ahí |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Cómo conversa el agente, cuándo pregunta, formato de respuesta. |
| **Conocimiento** | `src/knowledge/ordenes-compra.md` | El proceso, la matriz de controles, qué hacer ante cada excepción, glosario SAP. |
| **Ejecución** | `src/tools/oc.ts` + `src/core/` | Lectura, reglas, payload, evidencia, creación en SAP. |

El servidor concatena prompt + conocimiento en cada turno (se leen del disco, así que editar un `.md` no exige reiniciar). Un cambio de reglas de negocio se hace en `src/core/controles.ts` y no toca el servidor ni el ciclo.

---

## 3. Ciclo del agente

`src/agent/ciclo.ts → ejecutarTurno()`:

1. **Entrada del usuario.** Si el turno anterior quedó esperando confirmación, el backend interpreta el mensaje de la analista (`esAfirmativa` / `esNegativa`) y registra o revoca la confirmación de esos casos **antes** de llamar al modelo.
2. **Bucle** (máximo `MAX_ITERACIONES`, por defecto 25 — CA1):
   - Verifica el tope de tokens de la sesión (`MAX_TOKENS_SESION`).
   - Llama `llm.enviar(mensajes, herramientas, { system, signal: AbortSignal.timeout(...) })`.
   - Si el modelo no pide herramientas → fin del turno.
   - Si pide herramientas: cada llamada se valida con `zod`; si los argumentos no cumplen, el error vuelve al modelo como resultado (no rompe el turno). Se ejecuta, se resume para el front y se registra en `out/log.jsonl` (CA4).
3. **Tope alcanzado:** se responde con un resumen determinista de lo obtenido y lo que falta, y se deja el historial consistente para continuar.
4. **Errores del proveedor** (timeout, 401, 429, 5xx) se traducen a lenguaje claro (`errorHttp`) y la sesión sigue viva (CA5).
5. **Cierre:** el backend calcula qué casos quedaron pendientes de confirmación (una validación con `confirmaciones` sin `oc_crear` exitoso) y responde `{ reply, toolCalls, needsConfirmation, pendientes }`. El front resalta la burbuja en ámbar y muestra el banner con *Confirmo / No crear*.

**Confirmación humana (CA3) en dos capas:**

- *Prompt:* el agente debe terminar el turno con una pregunta y no pasar `confirmado: true` sin respuesta explícita.
- *Diseño (lo que la hace segura):* `oc_crear` con `confirmado: true` solo procede si el backend registró la confirmación **en el mensaje de la analista** para ese caso y esa sesión (`src/core/confirmaciones.ts`). Si el modelo intenta auto-confirmar, la herramienta lo rechaza. `demo.ts` y `tests/agente.test.ts` lo demuestran.

**CA2 (el modelo no afirma valores propios):** además de la regla del prompt, las herramientas siempre releen los documentos. Si el modelo envía un `paquete` o `payload` con montos, NIT, centro de costo o IVA distintos a los reales, la herramienta lo rechaza (`rechazarAlterado`). El modelo no tiene forma de "arreglar" un monto.

---

## 4. Elección del modelo

| | |
|---|---|
| **Proveedor / modelo** | Anthropic · `claude-haiku-4-5` (configurable con `LLM_PROVIDER` y `LLM_MODEL`). Alternativa implementada: OpenAI (`gpt-4.1-mini`) o cualquier API compatible vía `LLM_BASE_URL`. |
| **Por qué** | El trabajo pesado (lectura, reglas, cálculos, payload) es determinista y vive en las herramientas. El modelo solo orquesta el flujo, decide cuándo preguntar y redacta. Para eso un modelo rápido y económico con buen uso de herramientas es suficiente; si en la defensa se requiere más razonamiento, se cambia a un modelo mayor con una variable de entorno, sin tocar código. |
| **Optimización de costo** | El system prompt (prompt + conocimiento, ~2.000 tokens) se marca con `cache_control` para caché de Anthropic. Las herramientas reciben solo `caso`, no el paquete completo, lo que evita que el modelo reenvíe JSON grandes. |
| **Costo estimado por caso** | Medido con el historial real de una sesión: un caso completo usa ~5 llamadas al modelo y ~23.000 tokens de entrada acumulados + ~1.500 de salida. A precio de lista de Haiku 4.5 (USD 1 / 5 por millón de tokens de entrada / salida, a verificar al momento de la defensa) son **≈ USD 0,03 por caso**, menos con la caché. Con un modelo de gama media (USD 3 / 15) serían ≈ USD 0,09. |
| **Topes de gasto** | `MAX_ITERACIONES` por turno, `MAX_TOKENS_SESION` por sesión, `MAX_TOKENS_RESPUESTA` por llamada, mensajes de máximo 2.000 caracteres y clave de acceso opcional (`APP_ACCESS_KEY`) para el link público. |

---

## 5. Matriz de controles

Implementada en `src/core/controles.ts`: cada regla es una función pura `(contexto) → hallazgos`. El orden importa: RC4 (centro de costo) se evalúa antes que RC2/RC3 porque estas necesitan el centro resuelto.

| # | Implementación | Tipo | Caso que la dispara |
|---|---|---|---|
| RC1 | Busca por NIT normalizado (sin puntos ni dígito de verificación); si no hay NIT, por nombre normalizado (sin tildes, puntuación ni sufijos S.A.S./Ltda./S.A.). Verifica `activo`. Extra: si el NIT de la cotización no coincide con el proveedor → confirmación `RC1-COT`. | Bloqueo | sol-002 |
| RC2 | Aprobación presente, contiene "Aprobado" como palabra **sin negación** ("no aprobado" no cuenta) y el remitente está en `aprobadores` del centro. Si es aprobador de otro centro, lo dice y lista los aprobadores válidos. | Bloqueo | sol-003 |
| RC3 | `valor_total ≤ tope` del aprobador. Si el aprobador no es válido, igual informa si el monto supera el tope máximo del centro (para que la acción sugerida sea escalar, no solo cambiar de aprobador). | Bloqueo | sol-003 |
| RC4 | Centro existe y la subárea pertenece a él (comparación normalizada). | Bloqueo | — |
| RC5 | `|cotización − solicitud| / solicitud > 2 %` → confirmación con ambos valores, diferencia absoluta y porcentaje. Sin cotización → confirmación. Extra: cotización vencida → advertencia `RC5-VIG`. | Confirmación | sol-004 (6,0 %) |
| RC6 | IVA ausente → `indicador_iva_default` del proveedor + confirmación. IVA presente pero inexistente en el maestro → bloqueo. | Confirmación + derivado | sol-006 |
| RC7 | Condiciones de pago ausentes → `condiciones_pago_default`. Solo se informa en `derivados`. | Derivado | sol-006 |
| RC8 | `factura.fecha < fecha_solicitud` → `retroactiva = true` + confirmación. Queda en `out/control.csv`. | Confirmación | sol-005 |
| RC9 | Fecha (día) de la aprobación < fecha de solicitud → confirmación. | Confirmación | — |
| RC10 | `|cantidad × valor_unitario − valor_total| > 1` → bloqueo. | Bloqueo | probado en tests |

**La más difícil: RC2 + RC3.** No por el código sino por la semántica. En sol-003 el aprobador (Felipe Vargas) existe y su tope (80 M) cubriría los 74 M, pero es aprobador de CC-3030 y la compra se carga a CC-2020, cuyo único aprobador tiene tope de 30 M. Una implementación ingenua ("¿el aprobador existe y su tope alcanza?") la dejaría pasar. Hubo que decidir: (1) el tope se evalúa *en el centro de la compra*, (2) un aprobador de otro centro no cuenta aunque tenga tope, y (3) la acción sugerida debe decir que ni siquiera el aprobador correcto alcanza el monto, porque eso cambia lo que la analista le pide al solicitante (escalar, no solo reenviar). Segundo lugar: RC8, porque "retroactiva" se define por la factura, no por la cotización; en sol-005 la cotización sí existía (5 ago), lo que se saltó fue la OC.

---

## 6. Diseño del adaptador SAP real

La interfaz `SapAdapter` (`src/sap/adapter.ts`) es lo único que conoce el resto del sistema. Pasar de `SapMock` a SAP real es escribir una nueva clase que la implemente.

### 6.1 Opción de integración

| Opción | Cuándo | Veredicto |
|---|---|---|
| **OData `API_PURCHASEORDER_PROCESS_SRV`** | SAP S/4HANA (on-premise o cloud) | **Primera opción.** API estándar liberada por SAP, REST/JSON, soporta crear OC con posiciones e imputación en un solo deep insert, se gobierna con *communication arrangements* y no requiere desarrollo ABAP. |
| RFC/BAPI `BAPI_PO_CREATE1` | SAP ECC, o S/4 sin OData habilitado | Segunda opción. Robusta y conocida, pero exige conector RFC (SAP JCo/NCo o `node-rfc`) y red privada al servidor SAP; más difícil de operar desde un backend en la nube. |
| SAP Integration Suite (CPI) | Si Periferia ya tiene BTP | Como capa intermedia: el agente llama a un iFlow propio y CPI llama OData/BAPI. Agrega reintentos, monitoreo y desacopla credenciales. |
| Carga por archivo | Mientras la viabilidad no se confirme | **Plan B** (ver 6.5). |

Como la viabilidad no está confirmada, propongo un camino por etapas: **(1)** salir con Plan B (archivo/“OC lista para pegar”) que ya ahorra la validación y la digitación de datos maestros; **(2)** en paralelo, con TI de SAP, confirmar versión (ECC vs S/4) y habilitar OData o BAPI en QA; **(3)** reemplazar el adaptador sin tocar agente ni herramientas.

### 6.2 Mapeo del payload a OData (`A_PurchaseOrder` + `to_PurchaseOrderItem` + `to_AccountAssignment`)

| Payload (7.4) | Campo OData | Nota |
|---|---|---|
| `sociedad` | `CompanyCode` | "1000" |
| `organizacion_compras` | `PurchasingOrganization` | "1000" |
| — | `PurchaseOrderType` | "NB" (OC estándar). Supuesto a validar con Compras. |
| — | `PurchasingGroup` | Parametrizable por centro de costo (no viene en el payload). |
| `proveedor.codigo_sap` | `Supplier` | |
| `moneda` | `DocumentCurrency` | |
| `condiciones_pago` | `PaymentTerms` | Z000/Z015/Z030/Z060 |
| `referencia.solicitud_id` | `CorrespncExternalReference` (o campo Z) | **Clave de idempotencia** (ver 6.4). |
| `posiciones[].numero` | `PurchaseOrderItem` | 10, 20… |
| `posiciones[].descripcion` | `PurchaseOrderItemText` | ≤ 40 caracteres (ya recortado). |
| `posiciones[].cantidad` / `unidad` | `OrderQuantity` / `PurchaseOrderQuantityUnit` | UN→`EA` o `ST`, H→`H`, MES→`MON` según la tabla de unidades de Periferia. |
| `posiciones[].precio_unitario` | `NetPriceAmount` | **Ojo:** SAP espera precio **neto**; el payload trae precio con IVA incluido (lo aprobado). El adaptador real convierte `precio / (1 + tasa del indicador)`, p. ej. 95.000 / 1,19 = 79.831,93. |
| `posiciones[].indicador_iva` | `TaxCode` | |
| `posiciones[].centro_costo` | `AccountAssignmentCategory = "K"` + `to_AccountAssignment.CostCenter` | Requiere además `GLAccount` (cuenta de gasto) parametrizada por grupo de artículo y `Plant`. |
| `posiciones[].subarea` | Campo de imputación adicional (orden interna, centro de beneficio o campo Z) | Depende de cómo Periferia modela la subárea en SAP; se define con Contabilidad. |
| `aprobador.*` + PDF | Adjunto vía `API_CV_ATTACHMENT_SRV` sobre el objeto `BUS2012` (OC) | El hash sha256 va en la descripción del adjunto para verificar integridad. |
| `excepciones[]` | Texto de cabecera (`to_PurchaseOrderNote`) | Deja trazado en SAP qué se confirmó y quién. |

Con BAPI el mapeo es equivalente: `POHEADER`/`POHEADERX`, `POITEM`/`POITEMX`, `POACCOUNT`/`POACCOUNTX`, seguido de `BAPI_TRANSACTION_COMMIT`; los errores llegan en la tabla `RETURN`.

### 6.3 Autenticación y credenciales

- OData: **OAuth 2.0 client credentials** (S/4HANA Cloud / BTP) o usuario técnico de comunicación con certificado X.509 (on-premise), con permisos solo para crear/consultar OC y adjuntos.
- Las credenciales viven en un gestor de secretos (Azure Key Vault o AWS Secrets Manager) y las lee **solo el adaptador** en el backend. Nunca están en el prompt, en las herramientas, en el front ni en los logs; el modelo ni siquiera sabe que existen.
- Para auditoría, el adaptador envía el usuario de la analista como dato de creación (o *principal propagation* si BTP lo permite), de modo que SAP registre quién confirmó.

### 6.4 Idempotencia y errores parciales

1. **Antes de crear**, `buscarOrdenPorReferencia(solicitud_id)` consulta `A_PurchaseOrder?$filter=CorrespncExternalReference eq 'SOL-…'`. Si existe, se devuelve ese número (igual que el mock).
2. **Outbox local:** cada intento queda como `pendiente → enviado → confirmado/fallido` antes de llamar a SAP. Si la llamada se corta por *timeout*, no se reintenta a ciegas: primero se consulta por referencia (la OC pudo crearse).
3. **Reintentos** con backoff exponencial solo para errores transitorios (5xx, 429, red). Los 4xx de negocio (proveedor bloqueado en SAP, período contable cerrado, presupuesto) no se reintentan: se traducen a bloqueos con acción sugerida para la analista.
4. **Error parcial** (la OC se creó pero el adjunto falló): la OC no se borra; se registra `adjunto_pendiente` y un proceso de reintento sube solo el PDF. La analista ve el número de OC con la advertencia.
5. Con OData se maneja el token CSRF (`x-csrf-token: fetch`) y el ETag para reintentos seguros.

### 6.5 Plan B si no hay conexión

El agente ya hace el 80 % del valor sin SAP: lectura, validación de controles, derivaciones y evidencia. Sin conexión, el adaptador `SapArchivo` implementaría la misma interfaz y:

- Generaría **la OC lista para pegar** en el orden de pantalla de `ME21N` (proveedor, org. compras, grupo, posiciones, imputación), para que la digitación sea copiar/pegar campo a campo.
- Generaría un **archivo de carga masiva** (CSV/XLSX con la plantilla del *Migration Cockpit* o LSMW) que la analista sube una vez al día con todas las OC aptas.
- Recibiría de vuelta el número de OC que asigna SAP (la analista lo escribe en el chat o se lee del log de carga) para cerrar el caso y mantener el log de control.

---

## 7. Lectura del proceso: OC retroactivas

> Mensaje para la dirección (media página).

En los casos analizados, **1 de cada 6 solicitudes (sol-005) llegó con la factura ya emitida**: la factura es del 10 de agosto, la solicitud del 27 y la aprobación del 28, con el texto *"Ya llegó la factura, por favor crear la OC para poder radicarla"*. Es decir, la compra se comprometió con el proveedor 17 días antes de que alguien la aprobara. En este caso sí existía cotización (5 de agosto); lo que se saltó no fue la cotización sino **el control previo**: la OC y la aprobación se volvieron un trámite para poder pagar.

Esto importa por tres razones: (1) la aprobación deja de controlar el gasto, solo lo legaliza; (2) el área pierde poder de negociación y la posibilidad de verificar presupuesto, proveedor y precio antes de comprometerse; y (3) si se repite, Contabilidad registra gastos sin compromiso previo, lo que distorsiona los cierres.

**Lo que ya se puede medir:** el agente marca `retroactiva = true` en `out/control.csv` para cada OC creada con factura anterior a la solicitud y el chat muestra el porcentaje sobre las OC creadas. En la muestra: 1 de 4 OC creadas (25 %).

**Cambio de proceso que propondría:**

1. **Medir 4–6 semanas antes de decidir** (por centro de costo, proveedor y aprobador, y días entre factura y solicitud) para saber si es un problema general o de pocos equipos.
2. **Compras recurrentes → OC abierta o contrato marco.** La papelería trimestral es el ejemplo típico: una OC marco anual con entregas parciales elimina la retroactividad sin agregar trámites.
3. **Política "sin OC no se radica factura" (No PO, No Pay)** con período de transición: las retroactivas se aceptan con la marca y la justificación, y luego requieren aprobación de un nivel superior.
4. **Bajar la fricción de pedir antes:** si crear la OC toma minutos con el agente en lugar de horas de digitación, desaparece buena parte de la razón para comprar primero.

La decisión de tolerar o rechazar retroactivas es de la dirección; el agente la deja medible.

---

## 8. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | Las herramientas **releen siempre los documentos**; `paquete`, `derivados` y `payload` son opcionales y solo se aceptan si coinciden con lo real. | Que el modelo pase el paquete completo entre herramientas (literal del contrato). | Pasar JSON grandes cuesta tokens y abre la puerta a que el modelo altere un monto. Se mantiene la firma del contrato, pero la fuente de verdad son los archivos. |
| 2 | La **confirmación humana la registra el backend** a partir del mensaje de la analista; `confirmado: true` sin ese registro se rechaza. | Confiar en que el modelo solo pase `confirmado: true` cuando corresponde. | Un prompt es una instrucción, no un control. Crear una OC es una acción con efecto contable: el control debe estar en el código. |
| 3 | **`fetch` directo** a la API del proveedor con una interfaz propia `LlmAdapter`. | Vercel AI SDK o LangChain. | El reto evalúa el ciclo del agente: implementarlo explícito (≈150 líneas) lo hace auditable y explicable línea por línea, y evita dependencias pesadas. Cambiar de proveedor es agregar un archivo. |
| 4 | **Front en HTML + JS plano**, sin build, con un renderizador de Markdown propio y seguro (escapa HTML). | React + Vite; `marked` desde CDN. | Un solo comando para levantar, cero pasos de compilación y el chat funciona aunque no haya CDN. |
| 5 | **Precio de la OC = valor de la solicitud** (lo aprobado), aunque la cotización difiera; la diferencia queda como excepción confirmada. | Usar el valor de la cotización. | El líder aprobó un monto (en sol-004 lo dice: "Aprobado por 25 millones"). Crear la OC por más sería exceder la aprobación; si se necesita el valor de la cotización, debe re-aprobarse. |
| 6 | `out/control.csv` registra **eventos** desde `oc_validar` (bloqueada / pendiente) y `oc_crear` (creada / idempotente / rechazada). | Registrar solo en `oc_crear`. | Una solicitud bloqueada nunca llega a `oc_crear`; si solo se registrara ahí, los bloqueos no se medirían. El resumen toma el último estado por solicitud. |
| 7 | Respuesta completa por turno, **sin streaming**. | Server-Sent Events. | Era opcional; se priorizó robustez y el indicador "pensando" con cronómetro. Es la siguiente mejora de UX. |

---

## 9. Supuestos

1. Los montos de solicitud y cotización incluyen IVA (así lo indican las cotizaciones). La OC simulada lleva el precio con IVA; el adaptador real lo convierte a neto (6.2).
2. "Aprobado" debe aparecer como palabra y sin negación; "Aprobado por 25 millones" es aprobación válida.
3. La comparación de fechas (RC8, RC9) se hace por día calendario en la zona horaria que trae cada documento (Colombia, UTC-5).
4. Si la solicitud no trae NIT, el proveedor se identifica por nombre normalizado y se informa como advertencia.
5. La unidad de la posición se infiere del texto (horas → H, mensualidad → MES, resto → UN), porque la solicitud no la trae.
6. La descripción se recorta a 40 caracteres sin partir palabras ni terminar en conector; la completa queda en `trazabilidad.json`.
7. Cada solicitud genera una sola posición (los fixtures tienen un ítem); el esquema soporta varias.
8. Sociedad y organización de compras son "1000" para todos los casos.
9. Un caso sin `solicitud.json` no es procesable (error), mientras que la ausencia de cotización, aprobación o correo se reporta en `faltantes` y la evalúan las reglas.
10. La analista confirma escribiendo en el chat ("confirmo", "sí", "adelante"…) o con el botón; una respuesta negativa revoca la confirmación.

---

## 10. Cobertura

| Historia | Estado | Evidencia | Qué falta para producción |
|---|---|---|---|
| HU-1 Leer el paquete | **Hecho** | `oc_leer_paquete`, faltantes como `null` + lista | Lectura de `.xlsx`, PDF y `.eml` reales (P1 `oc_leer_excel` no implementado). |
| HU-2 Validar | **Hecho** | RC1–RC10 + extras, `tests/controles.test.ts` | Maestros consultados en SAP en tiempo real. |
| HU-3 Payload | **Hecho** | zod, `out/<caso>/trazabilidad.json` | Campos SAP adicionales (grupo de compras, cuenta, planta). |
| HU-4 Evidencia | **Hecho (P0 + P1)** | `aprobacion.txt` y `aprobacion.pdf` con sha256 | Firma digital si Auditoría la exige. |
| HU-5 Crear en SAP simulado | **Hecho** | numeración 4500000001+, idempotencia, `control.csv` | Adaptador real (sección 6). |
| HU-6 Errores | **Hecho** | JSON malformado, monto no numérico, caso inexistente, ruta maliciosa | Alertas operativas. |
| Front con tools y confirmación | **Hecho** | `web/` | Streaming, autenticación real. |
| `demo.ts` sin modelo | **Hecho** | `bun run demo.ts` | — |
| Bonus `modulo/` | **Hecho** | `bun run modulo`, `tests/modulo.test.ts` verifica que no diverja | Empaquetar como paquete npm. |
| Link público | Ver README | Dockerfile + `render.yaml` | — |

---

## 11. Uso de IA

> Declaración requerida por el PRD. **Wendy: revisa y ajusta esta sección para que refleje exactamente cómo trabajaste.**

| Asistente | Para qué lo usé |
|---|---|
| Claude (Anthropic) | Lectura del PRD y de los fixtures para armar la matriz de casos esperados; generación del andamiaje TypeScript (herramientas, ciclo del agente, adaptadores, front); pruebas automatizadas; borrador de esta documentación. |
| — | (Agregar aquí cualquier otro asistente que hayas usado.) |

**Lo que revisé y decidí yo:** la interpretación de cada regla frente a los casos (en especial RC2/RC3 en sol-003 y el valor a usar en sol-004), los supuestos de la sección 9, el análisis del proceso retroactivo y el diseño del adaptador SAP.

**Lo que descarté de lo propuesto:**
- Usar el valor de la cotización en la OC cuando difiere de la solicitud: se descartó porque excede lo aprobado.
- Dejar la confirmación solo en el prompt: se movió al backend como control.
- Cargar `marked` desde un CDN para el Markdown del chat: se reemplazó por un renderizador propio que escapa HTML.
- Usar un framework de agentes: se prefirió un ciclo explícito que se pueda explicar línea por línea.

---

## 12. Riesgos de llevar esto a producción

| Riesgo | Mitigación |
|---|---|
| La conexión a SAP no es viable en el corto plazo. | Plan B (6.5): OC lista para pegar y carga masiva; la interfaz `SapAdapter` permite cambiar sin tocar el agente. |
| El modelo "arregla" un monto o inventa un valor. | Las herramientas son la única fuente; rechazan paquetes/payloads alterados; el prompt lo prohíbe; la OC se construye en código y se valida con zod. |
| Se crea una OC sin confirmación humana. | Confirmación registrada por el backend a partir del mensaje de la analista; `oc_crear` la exige. |
| Documentos reales (PDF escaneados, Excel con formatos distintos) que no se leen bien. | Extracción con validación de esquema y umbral: si un campo crítico no se lee con confianza, se pide revisión en lugar de suponer. Empezar con plantillas de Excel controladas. |
| Maestros desactualizados (proveedor inactivado hoy en SAP). | Consultar maestros en SAP en línea (`consultarProveedor`) en lugar de archivos; caché corta. |
| Costo descontrolado del modelo o abuso del link. | Topes por turno y sesión, clave de acceso, autenticación corporativa (Entra ID) en producción, monitoreo de tokens por usuario. |
| Fuga de datos sensibles (NIT, montos) hacia el proveedor del modelo. | Contrato empresarial sin retención de datos o despliegue en Azure OpenAI / Bedrock dentro del tenant; los logs no guardan claves. |
| Doble creación por reintentos. | Idempotencia por `solicitud_id` en el adaptador y en SAP (referencia externa) + outbox. |
| Evidencia de aprobación insuficiente para auditoría. | Hash sha256 adjunto en SAP; evolucionar a aprobación con firma o flujo de aprobación en el sistema. |
| Las reglas cambian (nuevos topes, nuevos centros). | Reglas aisladas en `src/core/controles.ts` con pruebas por caso; conocimiento y comportamiento en Markdown editable. |
