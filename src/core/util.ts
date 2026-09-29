import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export interface Ctx {
  directory: string;
  sessionId: string;
  /** Lo fija SOLO el backend: el turno inmediatamente anterior pidió confirmación y el usuario dijo que sí. */
  confirmacionVerificada?: boolean;
  /** Fecha de ejecución YYYY-MM-DD (para pruebas reproducibles). */
  fecha?: string;
}

/** Error esperado: su mensaje es apto para mostrarse al usuario. */
export class ToolError extends Error {}

export const UMBRAL_POR_VENCER_DIAS = 15;

export function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function leerRuta(obj: unknown, ruta: string): unknown {
  let cur: unknown = obj;
  for (const parte of ruta.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[parte];
  }
  return cur;
}

export function similitud(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + costo);
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

export function hoy(ctx: Ctx): string {
  return ctx.fecha ?? process.env.FECHA_EJECUCION ?? new Date().toISOString().slice(0, 10);
}

export function diasHasta(hasta: string, desde: string): number {
  return Math.round((Date.parse(hasta) - Date.parse(desde)) / 86_400_000);
}

export type EstadoSoporte = "vigente" | "por_vencer" | "vencido" | "sin_vencimiento";

export function estadoSoporte(vigenciaHasta: string | null, fecha: string): EstadoSoporte {
  if (vigenciaHasta === null) return "sin_vencimiento";
  const dias = diasHasta(vigenciaHasta, fecha);
  if (Number.isNaN(dias)) {
    throw new ToolError(`Fecha de vigencia inválida: "${vigenciaHasta}". Se espera YYYY-MM-DD.`);
  }
  if (dias < 0) return "vencido";
  return dias <= UMBRAL_POR_VENCER_DIAS ? "por_vencer" : "vigente";
}

/** Solo nombres de carpeta simples: evita path traversal. */
export function validarCaso(caso: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(caso)) {
    throw new ToolError(`Nombre de caso inválido: "${caso.slice(0, 40)}".`);
  }
  return caso;
}

export const rutaFixtures = (ctx: Ctx) => path.join(ctx.directory, "fixtures", "reto-01");
export const rutaOut = (ctx: Ctx, caso: string) => path.join(ctx.directory, "out", caso);

export async function leerJson<S extends z.ZodTypeAny>(file: string, schema: S, que: string): Promise<z.infer<S>> {
  let crudo: unknown;
  try {
    crudo = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new ToolError(`No pude leer ${que}: el archivo no existe o está corrupto.`);
  }
  const r = schema.safeParse(crudo);
  if (!r.success) throw new ToolError(`${que} no tiene el formato esperado.`);
  return r.data;
}

/** RN5 / CA4: nunca registrar valores sensibles, solo un resumen. */
export async function registrar(ctx: Ctx, caso: string | null, herramienta: string, ok: boolean, resumen: string): Promise<void> {
  try {
    const linea = JSON.stringify({ ts: new Date().toISOString(), sesion: ctx.sessionId, herramienta, ok, resumen }) + "\n";
    const out = path.join(ctx.directory, "out");
    await mkdir(out, { recursive: true });
    await appendFile(path.join(out, "log.jsonl"), linea);
    if (caso) {
      await mkdir(path.join(out, caso), { recursive: true });
      await appendFile(path.join(out, caso, "log.jsonl"), linea);
    }
  } catch {
    /* el log nunca debe romper una herramienta */
  }
}
