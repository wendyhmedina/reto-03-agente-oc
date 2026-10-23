// SAP simulado sobre archivos en out/sap/. Numeración secuencial desde 4500000001.
// Las escrituras se serializan con una cola para que dos peticiones simultáneas no repitan número.
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { SapAdapter } from "./adapter.ts"
import type { OrdenCompra } from "../core/tipos.ts"
import { leerMaestros } from "../core/fixtures.ts"
import { normalizarNit } from "../core/texto.ts"
import { rutas } from "../core/rutas.ts"

const PRIMER_NUMERO = 4500000001

type Registro = { numero_oc: string; fecha: string; orden: OrdenCompra }

export class SapMock implements SapAdapter {
  private cola: Promise<unknown> = Promise.resolve()
  constructor(private readonly dir: string) {}

  private get archivo(): string {
    return join(rutas.sap(this.dir), "ordenes.jsonl")
  }

  private async registros(): Promise<Registro[]> {
    try {
      const txt = await readFile(this.archivo, "utf8")
      return txt.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Registro)
    } catch {
      return []
    }
  }

  async consultarProveedor(nit: string) {
    const m = await leerMaestros(this.dir)
    if (!m.ok) return null
    const p = m.data.proveedores.find((x) => normalizarNit(x.nit) === normalizarNit(nit))
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async buscarOrdenPorReferencia(solicitud_id: string) {
    const r = (await this.registros()).find((x) => x.orden.referencia.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc, fecha: r.fecha } : null
  }

  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const tarea = this.cola.then(async () => {
      const regs = await this.registros()
      // Idempotencia también dentro del SAP simulado (defensa en profundidad).
      const existente = regs.find((x) => x.orden.referencia.solicitud_id === orden.referencia.solicitud_id)
      if (existente) return { numero_oc: existente.numero_oc, fecha: existente.fecha }
      const numero_oc = String(PRIMER_NUMERO + regs.length)
      const fecha = new Date().toISOString()
      await mkdir(rutas.sap(this.dir), { recursive: true })
      await appendFile(this.archivo, JSON.stringify({ numero_oc, fecha, orden } satisfies Registro) + "\n", "utf8")
      return { numero_oc, fecha }
    })
    this.cola = tarea.catch(() => undefined)
    return tarea
  }
}
