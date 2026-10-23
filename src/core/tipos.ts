// Esquemas zod del dominio. Son la única definición de forma de los datos:
// los tipos TypeScript se infieren de aquí para que esquema y tipo no diverjan.
import { z } from "zod"

const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "fecha en formato AAAA-MM-DD")
const montoPositivo = z.number({ error: "debe ser un número" }).finite().positive("debe ser mayor que cero")

/** Excel de solicitud normalizado (PRD 7.1). */
export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string().min(1),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: montoPositivo,
  valor_unitario: montoPositivo,
  valor_total: montoPositivo,
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: fechaIso,
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
})

export const CotizacionSchema = z.object({
  referencia: z.string().nullable(),
  fecha: z.string().nullable(),
  proveedor: z.string(),
  nit: z.string().nullable(),
  total: z.number(),
  moneda: z.string(),
  validez_hasta: z.string().nullable(),
  items: z.array(z.object({ descripcion: z.string(), cantidad: z.number(), precio_unitario: z.number() })),
  texto: z.string(),
})

export const AprobacionSchema = z.object({
  de: z.string(),
  para: z.string().nullable(),
  fecha: z.string(),
  asunto: z.string().nullable(),
  aprobado: z.boolean(),
  texto: z.string(),
})

export const FacturaSchema = z.object({
  numero: z.string(),
  fecha: z.string(),
  total: z.number(),
})

/** Paquete normalizado (PRD 7.2). `faltantes` lista los adjuntos que no llegaron. */
export const PaqueteSchema = z.object({
  caso: z.string(),
  correo: CorreoSchema.nullable(),
  solicitud: SolicitudSchema,
  cotizacion: CotizacionSchema.nullable(),
  aprobacion: AprobacionSchema.nullable(),
  factura: FacturaSchema.nullable(),
  faltantes: z.array(z.string()),
})
export type Paquete = z.infer<typeof PaqueteSchema>

/** Hallazgo de una regla de control. */
export const HallazgoSchema = z.object({
  codigo: z.string(),
  detalle: z.string(),
  accion_sugerida: z.string(),
})
export type Hallazgo = z.infer<typeof HallazgoSchema>

/** Valores que el agente completa desde maestros y debe informar (RC6, RC7). */
export const DerivadosSchema = z.object({
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }).nullable(),
  indicador_iva: z.object({ codigo: z.string(), fuente: z.string() }).nullable(),
  condiciones_pago: z.object({ codigo: z.string(), fuente: z.string() }).nullable(),
  aprobador: z.object({ email: z.string(), nombre: z.string(), tope: z.number() }).nullable(),
})
export type Derivados = z.infer<typeof DerivadosSchema>

export type ResultadoValidacion = {
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  advertencias: Hallazgo[]
  derivados: Derivados
  retroactiva: boolean
}

/** Orden de compra (PRD 7.4). */
export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({
    email: z.string(),
    fecha_aprobacion: z.string(),
    evidencia_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive(),
        descripcion: z.string().max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().positive(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(
    z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() }),
  ),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

// ---- Maestros ----
export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})
export type Proveedor = z.infer<typeof ProveedorSchema>

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string().optional(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), nombre: z.string().optional(), tope: z.number() })),
})
export type CentroCosto = z.infer<typeof CentroCostoSchema>

export const IndicadorIvaSchema = z.object({ codigo: z.string(), descripcion: z.string(), tasa: z.number() })
export const CondicionPagoSchema = z.object({ codigo: z.string(), descripcion: z.string(), dias: z.number() })

export type Maestros = {
  proveedores: Proveedor[]
  centros: CentroCosto[]
  iva: z.infer<typeof IndicadorIvaSchema>[]
  condiciones: z.infer<typeof CondicionPagoSchema>[]
}

/** Contexto que el backend entrega a cada herramienta (PRD 6.2). */
export type ToolCtx = { directory: string; sessionId: string }

/** Resultado tipado: las herramientas nunca lanzan. */
export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }
export const ok = <T>(data: T): Resultado<T> => ({ ok: true, data })
export const falla = (error: string): Resultado<never> => ({ ok: false, error })
