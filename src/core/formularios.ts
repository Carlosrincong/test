import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { writeFile } from "node:fs/promises";
import type { Mapeo, Valor } from "./mapeo.js";

export interface Celda { hoja: string; celda_etiqueta: string; etiqueta: string; celda_valor: string }
export interface CampoPdf { etiqueta: string; obligatorio?: boolean }
export interface EstadoCampo { estado: "lleno" | "confirmar" | "faltante"; valor?: Valor; nota?: string }

export function indexarMapeo(m: Mapeo): Map<string, EstadoCampo> {
  const idx = new Map<string, EstadoCampo>();
  for (const c of m.llenos) idx.set(c.etiqueta, { estado: "lleno", valor: c.valor });
  for (const c of m.requiere_confirmacion) idx.set(c.etiqueta, { estado: "confirmar", valor: c.valor, nota: c.nota });
  for (const c of m.faltantes) idx.set(c.etiqueta, { estado: "faltante", nota: c.motivo });
  return idx;
}

export function texto(v: Valor | undefined): string {
  if (v === undefined) return "";
  if (typeof v === "boolean") return v ? "Sí" : "No";
  return String(v);
}

const NO_MAPEADO: EstadoCampo = { estado: "faltante", nota: "El campo no fue mapeado." };
const columna = (celda: string) => celda.replace(/\d+/g, "");

export async function escribirXlsx(ruta: string, celdas: Celda[], idx: Map<string, EstadoCampo>): Promise<void> {
  const wb = new ExcelJS.Workbook();
  for (const c of celdas) {
    const ws = wb.getWorksheet(c.hoja) ?? wb.addWorksheet(c.hoja);
    const e = idx.get(c.etiqueta) ?? NO_MAPEADO;
    const etiqueta = ws.getCell(c.celda_etiqueta);
    etiqueta.value = c.etiqueta;
    etiqueta.font = { bold: true };
    const valor = ws.getCell(c.celda_valor);
    if (e.estado !== "faltante" && e.valor !== undefined) {
      valor.value = typeof e.valor === "boolean" ? texto(e.valor) : e.valor;
    }
    if (e.estado === "confirmar") {
      valor.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
      valor.note = `POR CONFIRMAR: ${e.nota ?? ""}`;
    } else if (e.estado === "faltante") {
      valor.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8CBAD" } };
      valor.note = `FALTANTE: ${e.nota ?? ""}`;
    }
    ws.getColumn(columna(c.celda_etiqueta)).width = 34;
    ws.getColumn(columna(c.celda_valor)).width = 52;
  }
  await wb.xlsx.writeFile(ruta);
}

const limpiar = (s: string) => s.replace(/[^\u0020-\u007E\u00A0-\u00FF]/g, "?");

function envolver(t: string, font: PDFFont, size: number, ancho: number): string[] {
  const lineas: string[] = [];
  let actual = "";
  for (const palabra of limpiar(t).split(" ")) {
    const prueba = actual ? `${actual} ${palabra}` : palabra;
    if (font.widthOfTextAtSize(prueba, size) > ancho && actual) {
      lineas.push(actual);
      actual = palabra;
    } else actual = prueba;
  }
  if (actual) lineas.push(actual);
  return lineas;
}

export async function escribirPdf(ruta: string, titulo: string, campos: CampoPdf[], idx: Map<string, EstadoCampo>): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595, 842]);
  let y = 790;
  const linea = (t: string, f: PDFFont, size: number, color = rgb(0, 0, 0)) => {
    if (y < 60) { page = pdf.addPage([595, 842]); y = 790; }
    page.drawText(limpiar(t), { x: 50, y, size, font: f, color });
    y -= size + 6;
  };
  linea(titulo, bold, 15);
  y -= 8;
  for (const c of campos) {
    const e = idx.get(c.etiqueta) ?? NO_MAPEADO;
    const marca = e.estado === "confirmar" ? "  [POR CONFIRMAR]" : e.estado === "faltante" ? "  [FALTANTE]" : "";
    linea(`${c.etiqueta}${c.obligatorio ? " *" : ""}${marca}`, bold, 10, e.estado === "lleno" ? rgb(0, 0, 0) : rgb(0.7, 0.2, 0));
    const valor = e.estado === "faltante" ? "________________" : texto(e.valor);
    for (const l of envolver(valor, font, 11, 490)) linea(l, font, 11);
    y -= 4;
  }
  await writeFile(ruta, await pdf.save());
}

export function markdownPortal(cliente: string, campos: string[], idx: Map<string, EstadoCampo>): string {
  const filas = campos.map((etiqueta) => {
    const e = idx.get(etiqueta) ?? NO_MAPEADO;
    const estado = e.estado === "lleno" ? "lleno" : e.estado === "confirmar" ? "por confirmar" : "faltante";
    const valor = e.estado === "faltante" ? "" : texto(e.valor).replace(/\|/g, "\\|");
    return `| ${etiqueta} | ${valor} | ${estado}${e.nota ? ` — ${e.nota}` : ""} |`;
  });
  return [
    `# Valores para el portal de ${cliente}`,
    "",
    "> Formato no soportado: el portal lo opera una persona (credenciales y clic en \"Enviar\" son humanos).",
    "",
    "| Campo | Valor | Estado |",
    "|---|---|---|",
    ...filas,
    "",
  ].join("\n");
}
