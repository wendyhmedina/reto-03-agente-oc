// Interfaz obligatoria del adaptador SAP (PRD 7.4). La implementación real (OData/BAPI)
// se diseña en SOLUCION.md; aquí solo vive el contrato.
import type { OrdenCompra } from "../core/tipos.ts"

export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>
  // `fecha` es opcional: extensión compatible con el contrato del PRD para informar la fecha en reintentos.
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string; fecha?: string } | null>
}
