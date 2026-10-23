// Pruebas de las reglas y de la robustez de las herramientas (sin modelo).
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { cp, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { leerPaquete, leerMaestros } from "../src/core/fixtures.ts"
import { validarPaquete } from "../src/core/controles.ts"
import { contieneAprobado } from "../src/core/parsers.ts"
import { parsearMonto, recortar, normalizarNombre } from "../src/core/texto.ts"
import * as oc from "../src/tools/oc.ts"

const RAIZ = join(import.meta.dir, "..")

async function validar(caso: string, dir = RAIZ) {
  const p = await leerPaquete(dir, caso)
  const m = await leerMaestros(dir)
  if (!p.ok || !m.ok) throw new Error(!p.ok ? p.error : "maestros")
  return validarPaquete(p.data, m.data)
}
const cods = (xs: { codigo: string }[]) => xs.map((x) => x.codigo)

describe("criterios de aceptación de los 6 casos", () => {
  test("sol-001 apta sin confirmaciones (O1)", async () => {
    const v = await validar("sol-001")
    expect(v.apta).toBe(true)
    expect(v.confirmaciones).toEqual([])
    expect(v.retroactiva).toBe(false)
  })
  test("sol-002 bloqueada por proveedor inexistente (O2)", async () => {
    const v = await validar("sol-002")
    expect(v.apta).toBe(false)
    expect(cods(v.bloqueos)).toEqual(["RC1"])
  })
  test("sol-003 bloqueada por aprobador sin autoridad (O2)", async () => {
    const v = await validar("sol-003")
    expect(v.apta).toBe(false)
    expect(cods(v.bloqueos)).toContain("RC2")
    expect(v.bloqueos[0]!.accion_sugerida).toContain("rtorres@periferia-ficticia.com")
  })
  test("sol-004 pide confirmación por diferencia de cotización (O3)", async () => {
    const v = await validar("sol-004")
    expect(v.apta).toBe(true)
    expect(cods(v.confirmaciones)).toEqual(["RC5"])
    expect(v.confirmaciones[0]!.detalle).toContain("26.500.000")
    expect(v.confirmaciones[0]!.detalle).toContain("25.000.000")
  })
  test("sol-005 retroactiva (O4)", async () => {
    const v = await validar("sol-005")
    expect(v.retroactiva).toBe(true)
    expect(cods(v.confirmaciones)).toEqual(["RC8"])
  })
  test("sol-006 deriva IVA (confirmación) y condiciones de pago (informativo) (O3)", async () => {
    const v = await validar("sol-006")
    expect(cods(v.confirmaciones)).toEqual(["RC6"])
    expect(v.derivados.indicador_iva).toEqual({ codigo: "C1", fuente: "maestro.proveedores.indicador_iva_default" })
    expect(v.derivados.condiciones_pago?.codigo).toBe("Z030")
  })
})

describe("utilidades", () => {
  test("'Aprobado' con negación no cuenta", () => {
    expect(contieneAprobado("Aprobado, proceder.")).toBe(true)
    expect(contieneAprobado("Esto NO está aprobado todavía")).toBe(false)
    expect(contieneAprobado("Revisemos el lunes")).toBe(false)
  })
  test("montos en formato colombiano", () => {
    expect(parsearMonto("COP 11.400.000")).toBe(11_400_000)
    expect(parsearMonto("1.234,5")).toBe(1234.5)
    expect(parsearMonto("abc")).toBeNull()
  })
  test("texto breve SAP ≤ 40 sin terminar en conector", () => {
    const r = recortar("Diademas con micrófono para la mesa de soporte", 40)
    expect(r.length).toBeLessThanOrEqual(40)
    expect(r.endsWith(" de")).toBe(false)
  })
  test("normalización de nombres de proveedor", () => {
    expect(normalizarNombre("Mobiliario Andino S.A.")).toBe(normalizarNombre("MOBILIARIO ANDINO SA"))
  })
})

describe("robustez (HU-6)", () => {
  let dir = ""
  const ctx = () => ({ directory: dir, sessionId: "test" })
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "oc-"))
    await cp(join(RAIZ, "fixtures"), join(dir, "fixtures"), { recursive: true })
    const base = join(dir, "fixtures", "reto-03", "solicitudes")
    await mkdir(join(base, "json-roto"))
    await writeFile(join(base, "json-roto", "solicitud.json"), "{ esto no es json")
    await mkdir(join(base, "monto-texto"))
    await writeFile(join(base, "monto-texto", "solicitud.json"), JSON.stringify({
      solicitud_id: "X", solicitante: "Y", proveedor_nombre: "TecnoSuministros S.A.S.", descripcion: "Z",
      centro_costo: "CC-1010", subarea: "Soporte", cantidad: 1, valor_unitario: "mil", valor_total: 1000, moneda: "COP", fecha_solicitud: "2026-08-01",
    }))
    await mkdir(join(base, "sin-adjuntos"))
    await cp(join(base, "sol-001", "solicitud.json"), join(base, "sin-adjuntos", "solicitud.json"))
    await mkdir(join(base, "aritmetica"))
    const sol = JSON.parse(await Bun.file(join(base, "sol-001", "solicitud.json")).text())
    await writeFile(join(base, "aritmetica", "solicitud.json"), JSON.stringify({ ...sol, valor_total: 12_000_000 }))
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  test("JSON malformado → { ok:false } legible, no lanza", async () => {
    const r = JSON.parse(await oc.leer_paquete.execute({ caso: "json-roto" }, ctx()))
    expect(r.ok).toBe(false)
    expect(r.error).toContain("no es un JSON válido")
  })
  test("monto no numérico → error con el campo", async () => {
    const r = JSON.parse(await oc.leer_paquete.execute({ caso: "monto-texto" }, ctx()))
    expect(r.ok).toBe(false)
    expect(r.error).toContain("valor_unitario")
  })
  test("adjuntos ausentes → null + faltantes, sin excepción", async () => {
    const r = JSON.parse(await oc.leer_paquete.execute({ caso: "sin-adjuntos" }, ctx()))
    expect(r.ok).toBe(true)
    expect(r.data.cotizacion).toBeNull()
    expect(r.data.aprobacion).toBeNull()
    expect(r.data.faltantes).toEqual(["correo.json", "cotizacion.txt", "aprobacion.json"])
  })
  test("RC10 aritmética bloquea", async () => {
    const v = await validar("aritmetica", dir)
    expect(cods(v.bloqueos)).toContain("RC10")
  })
  test("el modelo no puede alterar montos del paquete", async () => {
    const r = JSON.parse(await oc.validar.execute({ caso: "sol-004", paquete: { solicitud: { valor_total: 26_500_000 } } }, ctx()))
    expect(r.ok).toBe(false)
    expect(r.error).toContain("solicitud.valor_total")
  })
  test("ruta maliciosa rechazada", async () => {
    const r = JSON.parse(await oc.leer_paquete.execute({ caso: "../../etc" }, ctx()))
    expect(r.ok).toBe(false)
  })
})
