// Casos sintéticos (NO modifican fixtures/): cubren PDF, RN1, faltantes, vencidos, portal y plantilla corrupta.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "../src/tools/proveedor.js";
import type { Ctx } from "../src/core/util.js";

type R = { ok: boolean; data?: Record<string, unknown>; error?: string };
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await mkdtemp(path.join(tmpdir(), "reto01-"));
await cp(path.join(raiz, "fixtures"), path.join(tmp, "fixtures"), { recursive: true });
const ctx: Ctx = { directory: tmp, sessionId: "test", fecha: "2026-09-28" };
const casos = path.join(tmp, "fixtures", "reto-01", "casos");

async function caso(id: string, sol: object, archivos: Record<string, unknown | string>) {
  const dir = path.join(casos, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "solicitud.json"), JSON.stringify({ de: "x@cliente.com", asunto: "Registro", cliente: "Cliente X", ...sol }));
  for (const [n, c] of Object.entries(archivos)) await writeFile(path.join(dir, n), typeof c === "string" ? c : JSON.stringify(c));
}
const run = async (t: { execute(a: unknown, c: Ctx): Promise<string> }, a: unknown): Promise<R> => JSON.parse(await t.execute(a, ctx)) as R;
const lista = (v: unknown) => v as { etiqueta: string; nota?: string }[];

// 1) Honduras / PDF / vencido + ausente + faltante + ambiguo + fuzzy
await caso("hn-sint", { pais: "HN", formato: "pdf" }, {
  "plantilla-campos.json": [
    { etiqueta: "Identificación tributaria", obligatorio: true }, { etiqueta: "RTN", obligatorio: true },
    { etiqueta: "Razon social del proveedor", obligatorio: true }, { etiqueta: "Número de sucursales", obligatorio: false },
  ],
  "soportes-exigidos.json": ["camara_comercio", "parafiscales", "certificado_iso_14001"],
});
let sol = await run(p.leer_solicitud, { caso: "hn-sint" });
assert.equal(sol.ok, true);
assert.equal((sol.data?.ambiguos as unknown[]).length, 1);
const map = await run(p.mapear_campos, { caso: "hn-sint", campos: sol.data?.campos });
const conf = lista(map.data?.requiere_confirmacion);
assert.ok(conf.some((c) => c.etiqueta === "RTN" && /extranjero/i.test(c.nota ?? "")), "RN1: RTN debe pedir confirmación");
assert.ok(conf.some((c) => c.etiqueta === "Identificación tributaria"), "ambigua debe pedir confirmación");
assert.ok(conf.some((c) => c.etiqueta === "Razon social del proveedor"), "fuzzy <0.8 debe pedir confirmación");
assert.deepEqual(lista(map.data?.faltantes).map((f) => f.etiqueta), ["Número de sucursales"]);
const gen = await run(p.generar_formulario, { caso: "hn-sint", mapeo: map.data });
assert.equal(gen.ok, true);
assert.match(await readFile(path.join(tmp, "out/hn-sint/formulario.pdf"), "latin1").then((s) => s.slice(0, 8)), /%PDF/);
const paq = await run(p.armar_paquete, { caso: "hn-sint" });
assert.equal(paq.data?.listo_para_firma, false);
const bloqueos = (paq.data?.bloqueos as string[]).join("|");
assert.match(bloqueos, /vencido: parafiscales/);
assert.match(bloqueos, /ausente: certificado_iso_14001/);
assert.doesNotMatch(bloqueos, /faltante/i, "RN3: un campo faltante no bloquea");
// CA2: valor manipulado por el modelo
const trucado = structuredClone(map.data) as { llenos: { valor: unknown }[]; requiere_confirmacion: { valor: unknown }[] };
(trucado.requiere_confirmacion[0] ?? trucado.llenos[0]).valor = "999";
assert.equal((await run(p.generar_formulario, { caso: "hn-sint", mapeo: trucado })).ok, false, "CA2: valor inventado debe rechazarse");
// RN4: sin verificación del backend, aunque el modelo diga confirmado:true
assert.equal((await run(p.simular_envio, { caso: "hn-sint", confirmado: true })).ok, false);
const env = JSON.parse(await p.simular_envio.execute({ caso: "hn-sint", confirmado: true }, { ...ctx, confirmacionVerificada: true })) as R;
assert.equal(env.ok, true);
assert.match(await readFile(path.join(tmp, "out/hn-sint/ENVIO-SIMULADO.md"), "utf8"), /ADVERTENCIA/);

// 2) Portal: formato no soportado + valores copiables
await caso("portal-sint", { pais: "CO", formato: "portal" }, { "soportes-exigidos.json": ["rut"] });
sol = await run(p.leer_solicitud, { caso: "portal-sint" });
assert.equal(sol.ok, true);
const mp = await run(p.mapear_campos, { caso: "portal-sint", campos: ["NIT", "Banco"] });
const gp = await run(p.generar_formulario, { caso: "portal-sint", mapeo: mp.data });
assert.equal(gp.data?.estado, "formato no soportado");
assert.match(String(gp.data?.ruta), /valores-portal\.md$/);
assert.equal((await run(p.armar_paquete, { caso: "portal-sint" })).data?.listo_para_firma, false);

// 3) Plantilla corrupta: no revienta y sigue con lo que puede
await caso("corrupto-sint", { pais: "CO", formato: "xlsx" }, { "plantilla-celdas.json": "{no es json", "soportes-exigidos.json": ["rut"] });
const cor = await run(p.leer_solicitud, { caso: "corrupto-sint" });
assert.equal(cor.ok, true);
assert.equal((cor.data?.campos as unknown[]).length, 0);
assert.match((cor.data?.advertencias as string[]).join(" "), /corrupto/);
assert.equal((await run(p.generar_formulario, { caso: "corrupto-sint", mapeo: { llenos: [], faltantes: [], requiere_confirmacion: [] } })).ok, false);

console.log("✓ todos los casos sintéticos pasaron");
await rm(tmp, { recursive: true, force: true });
