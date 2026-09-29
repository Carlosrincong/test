// Cada export se expone al modelo como `proveedor_<export>`. Aquí solo van herramientas.
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { herramienta } from "../core/herramienta.js";
import {
  escribirPdf, escribirXlsx, indexarMapeo, markdownPortal, texto,
  type Celda, type CampoPdf,
} from "../core/formularios.js";
import { IDENT_TRIBUTARIO, mapearCampos, type Mapeo } from "../core/mapeo.js";
import {
  ToolError, diasHasta, estadoSoporte, hoy, leerJson, leerRuta, normalizar,
  rutaFixtures, rutaOut, validarCaso, type Ctx,
} from "../core/util.js";

// ---------- esquemas de los fixtures (validan plantillas corruptas) ----------
const Solicitud = z.object({
  de: z.string(), asunto: z.string().optional(), fecha: z.string().optional(),
  pais: z.string(), cliente: z.string(), formato: z.enum(["xlsx", "pdf", "portal"]),
});
const Celdas = z.array(z.object({
  hoja: z.string().min(1),
  celda_etiqueta: z.string().regex(/^[A-Z]{1,3}[0-9]{1,5}$/),
  etiqueta: z.string().min(1),
  celda_valor: z.string().regex(/^[A-Z]{1,3}[0-9]{1,5}$/),
}));
const CamposPdf = z.array(z.object({ etiqueta: z.string().min(1), obligatorio: z.boolean().optional() }));
const SoportesExigidos = z.array(z.string());
const IndiceSoportes = z.array(z.object({
  tipo: z.string(), archivo: z.string(), vigencia_hasta: z.string().nullable(),
  pais_emisor: z.string().optional(), descripcion: z.string().optional(),
}));
const Glosario = z.record(z.string());
const ValorSchema = z.union([z.string(), z.number(), z.boolean()]);
const MapeoSchema = z.object({
  llenos: z.array(z.object({ etiqueta: z.string(), clave: z.string(), valor: ValorSchema, fuente: z.string() })),
  faltantes: z.array(z.object({ etiqueta: z.string(), motivo: z.string() })),
  requiere_confirmacion: z.array(z.object({
    etiqueta: z.string(), clave: z.string(), valor: ValorSchema, fuente: z.string(),
    confianza: z.number(), nota: z.string(),
  })),
});
const Estado = z.object({ listo_para_firma: z.boolean(), bloqueos: z.array(z.string()), archivos: z.array(z.string()) });

// ---------- helpers de carga ----------
async function cargarCaso(ctx: Ctx, caso: string) {
  validarCaso(caso);
  const dir = path.join(rutaFixtures(ctx), "casos", caso);
  try { await stat(dir); } catch { throw new ToolError(`El caso "${caso}" no existe en fixtures/reto-01/casos/.`); }
  const solicitud = await leerJson(path.join(dir, "solicitud.json"), Solicitud, "solicitud.json");
  return { dir, solicitud };
}

const maestro = (ctx: Ctx) => leerJson(path.join(rutaFixtures(ctx), "repositorio", "maestro.json"), z.unknown(), "el maestro (maestro.json)");

async function leerPlantilla(dir: string, formato: "xlsx" | "pdf" | "portal"): Promise<{ celdas?: Celda[]; campos: CampoPdf[] }> {
  if (formato === "xlsx") {
    const celdas = await leerJson(path.join(dir, "plantilla-celdas.json"), Celdas, "plantilla-celdas.json");
    return { celdas, campos: celdas.map((c) => ({ etiqueta: c.etiqueta })) };
  }
  if (formato === "pdf") {
    return { campos: await leerJson(path.join(dir, "plantilla-campos.json"), CamposPdf, "plantilla-campos.json") };
  }
  try { return { campos: await leerJson(path.join(dir, "plantilla-campos.json"), CamposPdf, "plantilla-campos.json") }; }
  catch { return { campos: [] }; }
}

const archivoFormulario = { xlsx: "formulario.xlsx", pdf: "formulario.pdf", portal: "valores-portal.md" } as const;
const existe = (p: string) => stat(p).then(() => true, () => false);
const rel = (ctx: Ctx, p: string) => path.relative(ctx.directory, p).split(path.sep).join("/");

// ---------- herramientas ----------
export const leer_solicitud = herramienta("proveedor_leer_solicitud", {
  description: "Lee la solicitud del cliente y su plantilla; devuelve país, cliente, formato de salida, campos pedidos y soportes exigidos.",
  args: { caso: z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/") },
  async run({ caso }, ctx) {
    const { dir, solicitud } = await cargarCaso(ctx, caso);
    const advertencias: string[] = [];
    let campos: CampoPdf[] = [];
    try { campos = (await leerPlantilla(dir, solicitud.formato)).campos; }
    catch (e) { advertencias.push(e instanceof ToolError ? e.message : "No pude leer la plantilla."); }
    if (solicitud.formato === "portal" && campos.length === 0) advertencias.push("Formato portal: no hay plantilla de campos.");
    let soportes: string[] = [];
    try { soportes = await leerJson(path.join(dir, "soportes-exigidos.json"), SoportesExigidos, "soportes-exigidos.json"); }
    catch (e) { advertencias.push(e instanceof ToolError ? e.message : "No pude leer los soportes exigidos."); }
    const ident = IDENT_TRIBUTARIO[solicitud.pais] ?? "identificador tributario";
    const ambiguos = campos
      .filter((c) => ["identificacion tributaria", "numero de identificacion fiscal"].includes(normalizar(c.etiqueta)))
      .map((c) => ({ etiqueta: c.etiqueta, estado: "requiere_confirmacion", propuesta: ident }));
    const data = {
      pais: solicitud.pais, cliente: solicitud.cliente, formato: solicitud.formato,
      campos: campos.map((c) => c.etiqueta),
      obligatorios: campos.filter((c) => c.obligatorio).map((c) => c.etiqueta),
      ambiguos, soportes, advertencias,
    };
    return { data, resumen: `${data.campos.length} campos, ${soportes.length} soportes, formato ${solicitud.formato}, ${advertencias.length} advertencias` };
  },
});

export const mapear_campos = herramienta("proveedor_mapear_campos", {
  description: "Cruza las etiquetas pedidas con el maestro y las clasifica en llenos, faltantes y requiere_confirmacion sin inventar valores.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    campos: z.array(z.string()).describe("Etiquetas exactas devueltas por proveedor_leer_solicitud"),
  },
  async run({ caso, campos }, ctx) {
    const { solicitud } = await cargarCaso(ctx, caso);
    const glosario = await leerJson(path.join(rutaFixtures(ctx), "glosario-campos.json"), Glosario, "glosario-campos.json");
    const data = mapearCampos(campos, solicitud.pais, glosario, await maestro(ctx));
    return { data, resumen: `${data.llenos.length} llenos, ${data.faltantes.length} faltantes, ${data.requiere_confirmacion.length} por confirmar` };
  },
});

export const generar_formulario = herramienta("proveedor_generar_formulario", {
  description: "Genera el formulario en el formato del cliente (xlsx, pdf o valores para portal) a partir del mapeo devuelto por proveedor_mapear_campos.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    mapeo: MapeoSchema.describe("Objeto {llenos, faltantes, requiere_confirmacion} tal cual lo devolvió proveedor_mapear_campos"),
  },
  async run({ caso, mapeo }, ctx) {
    const { dir, solicitud } = await cargarCaso(ctx, caso);
    const m = await maestro(ctx);
    // CA2: ningún valor sale de un lugar distinto al maestro.
    for (const c of [...mapeo.llenos, ...mapeo.requiere_confirmacion]) {
      if (String(leerRuta(m, c.clave)) !== String(c.valor)) {
        throw new ToolError(`El valor de "${c.etiqueta}" no coincide con el maestro (${c.clave}). Vuelve a mapear los campos.`);
      }
    }
    const salida = rutaOut(ctx, caso);
    await mkdir(salida, { recursive: true });
    const idx = indexarMapeo(mapeo as Mapeo);
    const { celdas, campos } = await leerPlantilla(dir, solicitud.formato);
    const ruta = path.join(salida, archivoFormulario[solicitud.formato]);
    if (solicitud.formato === "xlsx" && celdas) await escribirXlsx(ruta, celdas, idx);
    else if (solicitud.formato === "pdf") await escribirPdf(ruta, `Registro como proveedor — ${solicitud.cliente}`, campos, idx);
    else {
      const etiquetas = campos.length ? campos.map((c) => c.etiqueta) : [...idx.keys()];
      await writeFile(ruta, markdownPortal(solicitud.cliente, etiquetas, idx));
    }
    await writeFile(path.join(salida, "mapeo.json"), JSON.stringify(mapeo, null, 2));
    const data: Record<string, unknown> = { ruta: rel(ctx, ruta), formato: solicitud.formato };
    if (solicitud.formato === "portal") {
      data.estado = "formato no soportado";
      data.aviso = "El portal web no se automatiza: se dejaron los valores listos para copiar.";
    }
    return { data, resumen: `formulario ${solicitud.formato} generado (${mapeo.llenos.length} llenos, ${mapeo.faltantes.length} faltantes)` };
  },
});

export const armar_paquete = herramienta("proveedor_armar_paquete", {
  description: "Arma el paquete para firma (formulario, soportes exigidos, checklist y borrador de correo) y dice si está listo para firma.",
  args: { caso: z.string().describe("Nombre de la carpeta del caso") },
  async run({ caso }, ctx) {
    const { dir, solicitud } = await cargarCaso(ctx, caso);
    const salida = rutaOut(ctx, caso);
    const formulario = path.join(salida, archivoFormulario[solicitud.formato]);
    if (!(await existe(formulario))) throw new ToolError("Aún no se generó el formulario de este caso. Primero usa proveedor_generar_formulario.");
    const mapeo = await leerJson(path.join(salida, "mapeo.json"), MapeoSchema, "el mapeo del caso");
    const exigidos = await leerJson(path.join(dir, "soportes-exigidos.json"), SoportesExigidos, "soportes-exigidos.json");
    const repo = path.join(rutaFixtures(ctx), "repositorio", "soportes");
    const indice = await leerJson(path.join(repo, "index.json"), IndiceSoportes, "el índice de soportes");
    const m = await maestro(ctx);
    const fecha = hoy(ctx);

    const paquete = path.join(salida, "paquete");
    await rm(paquete, { recursive: true, force: true });
    await mkdir(path.join(paquete, "soportes"), { recursive: true });
    await copyFile(formulario, path.join(paquete, archivoFormulario[solicitud.formato]));

    const bloqueos: string[] = [];
    const archivos: string[] = [archivoFormulario[solicitud.formato]];
    const soportes = [];
    for (const tipo of exigidos) {
      const e = indice.find((x) => x.tipo === tipo);
      const origen = e ? path.join(repo, path.basename(e.archivo)) : null;
      if (!e || !origen || !(await existe(origen))) {
        soportes.push({ tipo, estado: "ausente", vigencia_hasta: null, dias_restantes: null });
        bloqueos.push(`Soporte exigido ausente: ${tipo}`);
        continue;
      }
      await copyFile(origen, path.join(paquete, "soportes", path.basename(e.archivo)));
      archivos.push(`soportes/${path.basename(e.archivo)}`);
      const estado = estadoSoporte(e.vigencia_hasta, fecha);
      if (estado === "vencido") bloqueos.push(`Soporte vencido: ${tipo} (venció ${e.vigencia_hasta})`);
      soportes.push({ tipo, estado, vigencia_hasta: e.vigencia_hasta, dias_restantes: e.vigencia_hasta ? diasHasta(e.vigencia_hasta, fecha) : null });
    }
    if (solicitud.formato === "portal") bloqueos.push("Formato portal: los valores deben ingresarse manualmente en el portal");
    const listo = bloqueos.length === 0;

    const icono = { vigente: "✅", sin_vencimiento: "✅", por_vencer: "⚠️", vencido: "❌", ausente: "❌" } as const;
    const checklist = [
      `# Checklist — ${solicitud.cliente} (${caso})`,
      `Fecha de ejecución: ${fecha}`,
      `Estado: **${listo ? "LISTO PARA FIRMA" : "NO LISTO PARA FIRMA"}**`,
      "", "## Soportes exigidos",
      ...soportes.map((s) => `- ${icono[s.estado as keyof typeof icono]} ${s.tipo}: ${s.estado}${s.vigencia_hasta ? ` (vigencia hasta ${s.vigencia_hasta}, ${s.dias_restantes} d)` : ""}`),
      "", "## Campos faltantes (no bloquean, pero deben resolverse)",
      ...(mapeo.faltantes.length ? mapeo.faltantes.map((f) => `- ${f.etiqueta}: ${f.motivo}`) : ["- Ninguno"]),
      "", "## Campos por confirmar",
      ...(mapeo.requiere_confirmacion.length ? mapeo.requiere_confirmacion.map((f) => `- ${f.etiqueta}: ${f.nota}`) : ["- Ninguno"]),
      "", "## Bloqueos",
      ...(bloqueos.length ? bloqueos.map((b) => `- ${b}`) : ["- Ninguno"]), "",
    ].join("\n");
    await writeFile(path.join(paquete, "checklist.md"), checklist);

    // RN2: el borrador nunca incluye datos bancarios; solo nombra los soportes.
    const rl = leerRuta(m, "representante_legal.nombre");
    const razon = leerRuta(m, "razon_social");
    const correo = [
      `Para: ${solicitud.de}`,
      `Asunto: RE: ${solicitud.asunto ?? "Solicitud de registro como proveedor"}`,
      "", "Buenos días,", "",
      `Adjuntamos el formulario de registro como proveedor diligenciado y firmado por nuestro representante legal, junto con los siguientes soportes:`,
      ...exigidos.map((t) => `- ${t.replace(/_/g, " ")}`), "",
      "Quedamos atentos a cualquier observación.", "", "Cordialmente,",
      `${typeof rl === "string" ? rl : "Representante legal"}`, `${typeof razon === "string" ? razon : ""}`, "",
      "---", "BORRADOR INTERNO: no enviado. Requiere revisión y firma humana.", "",
    ].join("\n");
    await writeFile(path.join(paquete, "borrador-correo.md"), correo);
    archivos.push("checklist.md", "borrador-correo.md");
    await writeFile(path.join(salida, "estado.json"), JSON.stringify({ listo_para_firma: listo, bloqueos, archivos }, null, 2));

    return {
      data: { ruta: rel(ctx, paquete), listo_para_firma: listo, bloqueos, checklist: { soportes, faltantes: mapeo.faltantes, por_confirmar: mapeo.requiere_confirmacion.map((c) => ({ etiqueta: c.etiqueta, nota: c.nota })) } },
      resumen: `paquete armado, listo_para_firma=${listo}, ${bloqueos.length} bloqueos`,
    };
  },
});

export const simular_envio = herramienta("proveedor_simular_envio", {
  description: "Simula el envío del paquete (solo escribe ENVIO-SIMULADO.md); exige confirmación explícita del usuario en el turno inmediatamente anterior.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    confirmado: z.boolean().describe("true solo si el usuario confirmó explícitamente en su último mensaje"),
  },
  async run({ caso, confirmado }, ctx) {
    // RN4: no basta con que el modelo diga true; el backend debe haber verificado la confirmación.
    if (!confirmado || ctx.confirmacionVerificada !== true) throw new ToolError("requiere confirmación explícita");
    const { solicitud } = await cargarCaso(ctx, caso);
    const salida = rutaOut(ctx, caso);
    const estado = await leerJson(path.join(salida, "estado.json"), Estado, "el estado del paquete").catch(() => {
      throw new ToolError("Aún no hay paquete armado para este caso. Primero usa proveedor_armar_paquete.");
    });
    const md = [
      `# Envío simulado — ${caso}`,
      `Fecha: ${hoy(ctx)}`, `Destinatario: ${solicitud.de}`,
      `Asunto: RE: ${solicitud.asunto ?? "Solicitud de registro como proveedor"}`,
      "", "> SIMULACIÓN: no se envió ningún correo ni se cargó nada a ningún portal.", "",
      ...(estado.listo_para_firma ? [] : ["> ⚠️ ADVERTENCIA: el paquete NO estaba listo para firma:", ...estado.bloqueos.map((b) => `> - ${b}`), ""]),
      "## Adjuntos", ...estado.archivos.map((a) => `- ${a}`), "",
    ].join("\n");
    const ruta = path.join(salida, "ENVIO-SIMULADO.md");
    await writeFile(ruta, md);
    return { data: { ruta: rel(ctx, ruta), advertencia: estado.listo_para_firma ? null : estado.bloqueos }, resumen: `envío simulado escrito (listo_para_firma=${estado.listo_para_firma})` };
  },
});
