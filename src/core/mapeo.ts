import { leerRuta, normalizar, similitud } from "./util.js";

export type Valor = string | number | boolean;

export interface CampoLleno { etiqueta: string; clave: string; valor: Valor; fuente: string }
export interface CampoConfirmar extends CampoLleno { confianza: number; nota: string }
export interface CampoFaltante { etiqueta: string; motivo: string }
export interface Mapeo { llenos: CampoLleno[]; faltantes: CampoFaltante[]; requiere_confirmacion: CampoConfirmar[] }

export type Glosario = Record<string, string>;

export const IDENT_TRIBUTARIO: Record<string, string> = { CO: "NIT", EC: "RUC", PE: "RUC", PA: "RUC", HN: "RTN" };
const AMBIGUAS = new Set(["identificacion tributaria", "numero de identificacion fiscal"]);
const UMBRAL_CONFIANZA = 0.8;
const UMBRAL_CANDIDATO = 0.5;

const PALABRAS_VACIAS = new Set(["de", "del", "la", "el", "los", "las", "o", "y", "en", "su", "al", "numero", "nombre"]);

/** Evita falsos positivos por prefijos comunes ("número de ..."): debe coincidir alguna palabra distintiva. */
function comparteTerminoDistintivo(a: string, b: string): boolean {
  const distintivas = a.split(" ").filter((t) => t && !PALABRAS_VACIAS.has(t));
  if (distintivas.length === 0) return true;
  const otras = b.split(" ");
  return distintivas.some((t) => otras.some((o) => similitud(t, o) >= 0.8 || (t.length >= 4 && o.length >= 4 && (t.startsWith(o) || o.startsWith(t)))));
}

function mejorCandidato(etiqueta: string, glosario: Glosario): { clave: string; confianza: number } | null {
  const n = normalizar(etiqueta);
  let mejor: { clave: string; confianza: number } | null = null;
  for (const [sinonimo, clave] of Object.entries(glosario)) {
    const s = normalizar(sinonimo);
    const conf = similitud(n, s);
    if (conf < 1 && !comparteTerminoDistintivo(n, s)) continue;
    if (!mejor || conf > mejor.confianza) mejor = { clave, confianza: Math.round(conf * 100) / 100 };
  }
  return mejor;
}

export function esVacio(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

type Resultado =
  | { tipo: "lleno"; campo: CampoLleno }
  | { tipo: "confirmar"; campo: CampoConfirmar }
  | { tipo: "faltante"; campo: CampoFaltante };

export function mapearEtiqueta(etiqueta: string, pais: string, glosario: Glosario, maestro: unknown): Resultado {
  const cand = mejorCandidato(etiqueta, glosario);
  if (!cand || cand.confianza < UMBRAL_CANDIDATO) {
    return { tipo: "faltante", campo: { etiqueta, motivo: "Sin equivalente en el glosario ni en el maestro." } };
  }
  const valor = leerRuta(maestro, cand.clave);
  if (esVacio(valor) || typeof valor === "object") {
    return { tipo: "faltante", campo: { etiqueta, motivo: `El maestro no tiene un valor para '${cand.clave}'.` } };
  }
  const base: CampoLleno = { etiqueta, clave: cand.clave, valor: valor as Valor, fuente: `maestro.${cand.clave}` };
  const notas: string[] = [];
  if (cand.confianza < UMBRAL_CONFIANZA) notas.push(`Coincidencia aproximada (confianza ${cand.confianza}).`);
  if (AMBIGUAS.has(normalizar(etiqueta))) {
    notas.push(`Etiqueta ambigua; equivalente en ${pais}: ${IDENT_TRIBUTARIO[pais] ?? "identificador tributario"}.`);
  }
  if (cand.clave === "nit" && pais !== "CO") {
    notas.push(`Identificador extranjero: el cliente pide ${IDENT_TRIBUTARIO[pais] ?? "otro identificador"} y Periferia solo tiene NIT colombiano.`);
  }
  if (notas.length) {
    return { tipo: "confirmar", campo: { ...base, confianza: cand.confianza, nota: notas.join(" ") } };
  }
  return { tipo: "lleno", campo: base };
}

export function mapearCampos(etiquetas: string[], pais: string, glosario: Glosario, maestro: unknown): Mapeo {
  const m: Mapeo = { llenos: [], faltantes: [], requiere_confirmacion: [] };
  for (const e of etiquetas) {
    const r = mapearEtiqueta(e, pais, glosario, maestro);
    if (r.tipo === "lleno") m.llenos.push(r.campo);
    else if (r.tipo === "confirmar") m.requiere_confirmacion.push(r.campo);
    else m.faltantes.push(r.campo);
  }
  return m;
}
