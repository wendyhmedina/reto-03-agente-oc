# Conocimiento del proceso: órdenes de compra en Periferia

## El proceso

Cada compra llega a Administración por correo con tres piezas: la **solicitud** (Excel), la **cotización** del proveedor y el **correo de aprobación** del líder. La analista crea la OC en SAP con: proveedor, descripción, centro de costo y subárea, valor, indicador de IVA, aprobador y condiciones de pago, y adjunta el correo de aprobación como PDF.

El líder ya aprobó por correo: el agente **verifica** la aprobación, no la solicita.

## Matriz de controles

| Código | Qué se verifica | Efecto |
|---|---|---|
| RC1 | El proveedor existe en el maestro (por NIT; sin NIT, por nombre normalizado) y está activo. | Bloqueo |
| RC2 | Hay aprobación, dice "Aprobado" y la envía un aprobador del centro de costo. | Bloqueo |
| RC3 | El valor total no supera el tope del aprobador en ese centro. | Bloqueo |
| RC4 | La subárea pertenece al centro de costo. | Bloqueo |
| RC5 | Cotización y solicitud difieren como máximo 2 %. Sin cotización también se confirma. | Confirmación |
| RC6 | Sin indicador de IVA: se toma el predeterminado del proveedor. | Confirmación + derivado |
| RC7 | Sin condiciones de pago: se toman las del proveedor. | Derivado (solo informar) |
| RC8 | Factura con fecha anterior a la solicitud: **OC retroactiva**. | Confirmación + marca en control |
| RC9 | La aprobación es igual o posterior a la solicitud. | Confirmación |
| RC10 | cantidad × valor unitario = valor total (± 1). | Bloqueo |

Códigos auxiliares: `RC1-NIT` (proveedor identificado por nombre, informativo), `RC1-COT` (NIT de la cotización distinto, confirmación), `RC5-VIG` (cotización vencida, informativo), `PAQUETE` (adjuntos faltantes).

## Qué hacer ante cada situación

- **Proveedor inexistente o inactivo (RC1)**: Compras debe crearlo o reactivarlo en SAP (RUT, cámara de comercio, certificación bancaria) o el solicitante elige otro proveedor registrado.
- **Aprobador sin autoridad (RC2/RC3)**: pedir la aprobación a un aprobador del centro con tope suficiente. Si ninguno alcanza el monto, escalar a la dirección financiera.
- **Diferencia cotización vs solicitud (RC5)**: la OC se crea por el valor de la **solicitud** (es el monto que aprobó el líder). Si la analista prefiere el valor de la cotización, la solicitud debe volver al solicitante y re-aprobarse.
- **IVA derivado (RC6)**: confirmar el indicador propuesto; si el bien o servicio es excluido, corresponde C0.
- **OC retroactiva (RC8)**: se crea con confirmación y queda `retroactiva = true` en `out/control.csv`. La dirección quiere medir cuántas OC se crean después de la factura; el agente mide, no decide la política.

## Glosario SAP

- **OC**: orden de compra. Numeración desde 4500000001.
- **Sociedad / Organización de compras**: 1000 en todos los casos.
- **Posición**: línea de la OC; se numeran 10, 20, 30…
- **Texto breve**: descripción de la posición, máximo 40 caracteres (la descripción completa queda en la trazabilidad).
- **Unidad**: UN (unidades), H (horas), MES (meses de servicio).
- **Indicadores de IVA**: C0 excluido/no gravado, C1 IVA 19 %, C2 IVA 5 %.
- **Condiciones de pago**: Z000 inmediato, Z015 15 días, Z030 30 días, Z060 60 días fecha factura.
- **Precio unitario**: valor con IVA incluido, tal como lo aprobó el líder.

## Evidencias que genera el agente

- `out/<caso>/aprobacion.txt` y `aprobacion.pdf`: correo de aprobación con encabezados y hash sha256.
- `out/<caso>/payload.json` y `trazabilidad.json`: la OC y la fuente de cada campo.
- `out/sap/ordenes.jsonl`: OC creadas en el SAP simulado.
- `out/control.csv`: cada intento (creada, bloqueada, pendiente, idempotente, rechazada) para Contabilidad y Auditoría.
