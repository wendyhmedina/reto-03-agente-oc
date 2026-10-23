// Front del chat: historial, llamadas a herramientas visibles y confirmación humana resaltada.
// JavaScript plano, sin build. La clave del modelo nunca llega aquí: solo hablamos con /api.
const $ = (id) => document.getElementById(id)
const PROMPT_DEMO = 'Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.'

const leerLocal = (k) => { try { return localStorage.getItem(k) } catch { return null } }
const guardarLocal = (k, v) => { try { localStorage.setItem(k, v) } catch { /* modo privado */ } }
const nuevoId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2))

let sessionId = leerLocal("oc.sessionId") || nuevoId()
let claveAcceso = leerLocal("oc.accessKey") || ""
let ocupado = false
guardarLocal("oc.sessionId", sessionId)

// Markdown mínimo y seguro (se escapa todo el HTML antes de dar formato): tablas, listas, títulos,
// negrita, cursiva y código. Sin dependencias externas para que el chat funcione aunque no haya CDN.
const escapar = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const enLinea = (t) => escapar(t)
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
const celdas = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())

function md(texto) {
  const lineas = (texto || "").replace(/\r/g, "").split("\n")
  const out = []
  let i = 0
  while (i < lineas.length) {
    const l = lineas[i]
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lineas[i + 1] || "")) {
      const cab = celdas(l)
      i += 2
      const filas = []
      while (i < lineas.length && /^\s*\|.*\|\s*$/.test(lineas[i])) filas.push(celdas(lineas[i++]))
      out.push(`<table><thead><tr>${cab.map((c) => `<th>${enLinea(c)}</th>`).join("")}</tr></thead><tbody>${filas.map((f) => `<tr>${f.map((c) => `<td>${enLinea(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`)
      continue
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordenada = /^\s*\d+\./.test(l)
      const items = []
      while (i < lineas.length && /^\s*([-*]|\d+\.)\s+/.test(lineas[i])) {
        const sangria = /^\s{2,}/.test(lineas[i])
        items.push(`<li${sangria ? ' style="margin-left:18px"' : ""}>${enLinea(lineas[i].replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`)
        i++
      }
      out.push(ordenada ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`)
      continue
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/)
    if (h) { out.push(`<h3>${enLinea(h[2])}</h3>`); i++; continue }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(l)) { out.push("<hr>"); i++; continue }
    if (!l.trim()) { i++; continue }
    const parrafo = []
    while (i < lineas.length && lineas[i].trim() && !/^\s*(\||[-*]\s|\d+\.\s|#{1,4}\s)/.test(lineas[i])) parrafo.push(enLinea(lineas[i++]))
    if (parrafo.length) out.push(`<p>${parrafo.join("<br>")}</p>`)
    else out.push(`<p>${enLinea(lineas[i++])}</p>`)
  }
  return out.join("")
}

async function api(ruta, opciones = {}) {
  const headers = { "content-type": "application/json", ...(claveAcceso ? { "x-access-key": claveAcceso } : {}) }
  const res = await fetch(ruta, { ...opciones, headers })
  if (res.status === 401) {
    const k = prompt("Este agente está protegido. Escribe la clave de acceso:")
    if (k) { claveAcceso = k; guardarLocal("oc.accessKey", k); return api(ruta, opciones) }
  }
  const data = await res.json().catch(() => ({ error: "Respuesta ilegible del servidor." }))
  if (!res.ok) throw new Error(data.error || `Error HTTP ${res.status}`)
  return data
}

const conClave = (url) => (claveAcceso ? `${url}?k=${encodeURIComponent(claveAcceso)}` : url)

function argsCortos(args) {
  const partes = Object.entries(args || {}).map(([k, v]) => `${k}: ${typeof v === "string" ? `"${v}"` : JSON.stringify(v)}`)
  const t = partes.join(", ")
  return t.length > 60 ? t.slice(0, 57) + "…" : t
}

function tarjetaTool(t) {
  const d = document.createElement("details")
  d.className = "tool" + (t.ok ? "" : " fallo")
  d.innerHTML = `<summary><span class="tool-nombre"></span><span class="tool-args"></span><span class="tool-resumen"></span><span class="tool-ms"></span></summary><pre></pre>`
  d.querySelector(".tool-nombre").textContent = (t.ok ? "✓ " : "✕ ") + t.nombre
  d.querySelector(".tool-args").textContent = `(${argsCortos(t.args)})`
  d.querySelector(".tool-resumen").textContent = t.resumen
  d.querySelector(".tool-ms").textContent = `${t.ms} ms`
  d.querySelector("pre").textContent = `Argumentos:\n${JSON.stringify(t.args, null, 2)}\n\nResultado:\n${JSON.stringify(t.resultado, null, 2)}`
  return d
}

function enlacesEvidencia(toolCalls) {
  const casos = new Set()
  for (const t of toolCalls || []) {
    if (t.ok && (t.nombre === "oc_crear" || t.nombre === "oc_generar_evidencia") && t.args?.caso) casos.add(t.args.caso)
  }
  if (!casos.size) return null
  const cont = document.createElement("div")
  cont.className = "enlaces"
  for (const c of casos) {
    for (const [archivo, nombre] of [["aprobacion.pdf", "Evidencia PDF"], ["payload.json", "Payload"], ["trazabilidad.json", "Trazabilidad"]]) {
      const a = document.createElement("a")
      a.href = conClave(`/api/evidencia/${encodeURIComponent(c)}/${archivo}`)
      a.target = "_blank"
      a.rel = "noopener"
      a.textContent = `${nombre} · ${c}`
      cont.appendChild(a)
    }
  }
  return cont
}

function pintarMensaje(m) {
  $("vacio")?.remove()
  const el = document.createElement("div")
  if (m.rol === "usuario") {
    el.className = "msg usuario"
    el.textContent = m.texto
  } else {
    el.className = "msg agente" + (m.needsConfirmation ? " confirmar" : "") + (m.error ? " error" : "")
    if (m.toolCalls?.length) {
      const tools = document.createElement("div")
      tools.className = "tools"
      m.toolCalls.forEach((t) => tools.appendChild(tarjetaTool(t)))
      el.appendChild(tools)
    }
    const b = document.createElement("div")
    b.className = "burbuja"
    if (m.needsConfirmation) b.innerHTML = `<div class="etiqueta-conf">⚠ Requiere tu confirmación · ${(m.pendientes || []).join(", ")}</div>`
    b.insertAdjacentHTML("beforeend", md(m.texto))
    const enl = enlacesEvidencia(m.toolCalls)
    if (enl) b.appendChild(enl)
    el.appendChild(b)
  }
  $("mensajes").appendChild(el)
  el.scrollIntoView({ behavior: "smooth", block: "end" })
}

function mostrarBanner(pendientes) {
  const visible = pendientes && pendientes.length > 0
  $("banner-conf").hidden = !visible
  $("banner-casos").textContent = visible ? pendientes.join(", ") : ""
  $("texto").placeholder = visible ? "Responde: confirmo / no la crees… o usa los botones" : "Escribe al agente… (Enter envía, Shift+Enter salta línea)"
}

function indicadorPensando() {
  const el = document.createElement("div")
  el.className = "pensando"
  el.innerHTML = `<span class="puntos"><span></span><span></span><span></span></span><span>El agente está trabajando… <span class="seg">0 s</span></span>`
  const inicio = Date.now()
  const timer = setInterval(() => { el.querySelector(".seg").textContent = `${Math.round((Date.now() - inicio) / 1000)} s` }, 1000)
  $("mensajes").appendChild(el)
  el.scrollIntoView({ block: "end" })
  return () => { clearInterval(timer); el.remove() }
}

async function enviar(texto) {
  texto = (texto || "").trim()
  if (!texto || ocupado) return
  ocupado = true
  $("enviar").disabled = true
  $("texto").value = ""
  mostrarBanner([])
  pintarMensaje({ rol: "usuario", texto })
  const quitar = indicadorPensando()
  try {
    const r = await api("/api/chat", { method: "POST", body: JSON.stringify({ sessionId, message: texto }) })
    quitar()
    pintarMensaje({ rol: "agente", texto: r.reply, toolCalls: r.toolCalls, needsConfirmation: r.needsConfirmation, pendientes: r.pendientes, error: r.error })
    mostrarBanner(r.needsConfirmation ? r.pendientes : [])
  } catch (e) {
    quitar()
    pintarMensaje({ rol: "agente", texto: `No pude comunicarme con el agente: ${e.message}`, error: true })
  } finally {
    ocupado = false
    $("enviar").disabled = false
    $("texto").focus()
    cargarControl()
  }
}

async function cargarControl() {
  try {
    const c = await api("/api/control")
    $("c-sol").textContent = c.solicitudes
    $("c-cre").textContent = c.creadas
    $("c-ret").textContent = c.retroactivas
    $("c-pct").textContent = c.creadas ? `${c.pct_retroactivas_sobre_creadas} % de las OC creadas fueron retroactivas.` : "Aún no hay OC creadas."
  } catch { /* panel informativo */ }
}

async function iniciar() {
  $("sesion-id").textContent = sessionId.slice(0, 8)
  try {
    const h = await api("/api/health")
    $("estado-modelo").textContent = h.configurado ? `${h.provider} · ${h.model}` : "modelo sin configurar"
    if (!h.configurado) { $("estado-modelo").classList.add("mal"); $("estado-modelo").title = h.motivo || "" }
  } catch { $("estado-modelo").textContent = "backend no disponible"; $("estado-modelo").classList.add("mal") }

  try {
    const { casos } = await api("/api/casos")
    for (const c of casos) {
      const b = document.createElement("button")
      b.type = "button"
      b.textContent = c
      b.onclick = () => enviar(`Procesa la solicitud ${c}`)
      $("casos").appendChild(b)
    }
  } catch { /* sin casos */ }

  try {
    const s = await api(`/api/sessions/${sessionId}`)
    s.historial.forEach(pintarMensaje)
    mostrarBanner(s.pendientes)
  } catch { /* sesión nueva */ }
  cargarControl()
}

$("form").addEventListener("submit", (e) => { e.preventDefault(); enviar($("texto").value) })
$("texto").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar($("texto").value) } })
$("btn-confirmo").onclick = () => enviar("Confirmo, crea la OC.")
$("btn-no").onclick = () => enviar("No, no la crees.")
$("demo-prompt").onclick = () => { $("texto").value = PROMPT_DEMO; $("texto").focus() }
$("nueva-sesion").onclick = () => {
  sessionId = nuevoId()
  guardarLocal("oc.sessionId", sessionId)
  location.reload()
}
iniciar()
