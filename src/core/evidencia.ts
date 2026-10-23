// HU-4: evidencia de aprobación. El contenido se renderiza de forma determinista,
// se calcula su sha256 y se guarda en .txt (P0) y .pdf (P1) con el mismo contenido.
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import { leerAprobacionCruda } from "./fixtures.ts"
import { rutas, relativa } from "./rutas.ts"
import { type Resultado, ok, falla } from "./tipos.ts"

const texto = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : "")

/** Contenido canónico del correo de aprobación (lo que se firma con sha256). */
export function renderizarAprobacion(a: Record<string, unknown>, caso: string): string {
  return [
    `EVIDENCIA DE APROBACIÓN — caso ${caso}`,
    "",
    `De: ${texto(a.de)}`,
    `Para: ${texto(a.para)}`,
    ...(a.cc ? [`CC: ${texto(a.cc)}`] : []),
    `Fecha: ${texto(a.fecha)}`,
    `Asunto: ${texto(a.asunto)}`,
    "",
    texto(a.cuerpo),
    "",
  ].join("\n")
}

export const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex")

/** Calcula el hash sin escribir archivos (lo usa la construcción del payload). */
export async function hashEvidencia(dir: string, caso: string): Promise<Resultado<string>> {
  const a = await leerAprobacionCruda(dir, caso)
  return a.ok ? ok(sha256(renderizarAprobacion(a.data, caso))) : a
}

function envolver(linea: string, max: number): string[] {
  if (linea.length <= max) return [linea]
  const out: string[] = []
  let actual = ""
  for (const palabra of linea.split(" ")) {
    if ((actual + " " + palabra).trim().length > max) {
      out.push(actual)
      actual = palabra
    } else actual = (actual + " " + palabra).trim()
  }
  if (actual) out.push(actual)
  return out
}

async function generarPdf(contenido: string, hash: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle("Evidencia de aprobación")
  pdf.setCreator("Agente OC — reto 03")
  // Fecha fija para que el PDF sea determinista entre ejecuciones.
  pdf.setCreationDate(new Date("2026-01-01T00:00:00Z"))
  pdf.setModificationDate(new Date("2026-01-01T00:00:00Z"))
  const fuente = await pdf.embedFont(StandardFonts.Helvetica)
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold)
  const pagina = pdf.addPage([595, 842]) // A4
  let y = 790
  const lineas = contenido.split("\n").flatMap((l) => envolver(l, 90))
  lineas.forEach((l, i) => {
    pagina.drawText(l, { x: 50, y, size: i === 0 ? 13 : 10.5, font: i === 0 ? negrita : fuente, color: rgb(0.1, 0.1, 0.1) })
    y -= i === 0 ? 22 : 15
  })
  y -= 10
  pagina.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) })
  pagina.drawText(`sha256 del contenido: ${hash}`, { x: 50, y: y - 16, size: 8, font: fuente, color: rgb(0.35, 0.35, 0.35) })
  return pdf.save()
}

export async function generarEvidencia(dir: string, caso: string): Promise<Resultado<{ ruta: string; ruta_pdf: string; sha256: string }>> {
  const a = await leerAprobacionCruda(dir, caso)
  if (!a.ok) return a
  const contenido = renderizarAprobacion(a.data, caso)
  const hash = sha256(contenido)
  try {
    const carpeta = rutas.outCaso(dir, caso)
    await mkdir(carpeta, { recursive: true })
    const txt = join(carpeta, "aprobacion.txt")
    const pdf = join(carpeta, "aprobacion.pdf")
    await writeFile(txt, `${contenido}\n---\nsha256: ${hash}\n`, "utf8")
    await writeFile(pdf, await generarPdf(contenido, hash))
    return ok({ ruta: relativa(dir, txt), ruta_pdf: relativa(dir, pdf), sha256: hash })
  } catch (e) {
    return falla(`No se pudo escribir la evidencia: ${(e as Error).message}`)
  }
}
