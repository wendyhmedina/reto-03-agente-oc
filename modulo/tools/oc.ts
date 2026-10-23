// Herramientas del módulo reutilizable. No es una copia: re-exporta exactamente las que usa la aplicación,
// así que la plataforma anfitriona y el chat ejecutan el mismo código.
//
// Uso desde otra plataforma de agentes:
//   import * as oc from "./modulo/tools/oc.ts"
//   const r = await oc.validar.execute({ caso: "sol-004" }, { directory: "/ruta/al/proyecto", sessionId: "x" })
// Cada export expone { description, args (zod), execute(args, ctx) → string JSON }.
// La confirmación humana la decide la plataforma anfitriona: por defecto oc_crear acepta confirmado=true;
// para exigir la confirmación registrada, llama exigirConfirmacionRegistrada(true) y registrarConfirmacion(...).
export * from "../../src/tools/oc.ts"
export { exigirConfirmacionRegistrada, registrarConfirmacion } from "../../src/core/confirmaciones.ts"
