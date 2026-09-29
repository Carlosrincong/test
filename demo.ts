// Verificación SIN modelo: llama directo a las herramientas. Uso: npm run demo  (o: bun run demo.ts)
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as proveedor from "./src/tools/proveedor.js";
import type { Ctx } from "./src/core/util.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
type Res = { ok: boolean; data?: Record<string, unknown>; error?: string };
const ctx = (extra: Partial<Ctx> = {}): Ctx => ({ directory, sessionId: "demo", ...extra });
const parse = (s: string): Res => JSON.parse(s) as Res;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

async function procesar(caso: string): Promise<boolean> {
  console.log(`\n━━ ${caso} ━━`);
  const sol = parse(await proveedor.leer_solicitud.execute({ caso }, ctx()));
  if (!sol.ok || !sol.data) { console.log(`  ✗ leer_solicitud: ${sol.error}`); return false; }
  const campos = arr(sol.data.campos) as string[];
  console.log(`  país=${String(sol.data.pais)} formato=${String(sol.data.formato)} campos=${campos.length} soportes=${(arr(sol.data.soportes) as string[]).join(", ")}`);
  for (const a of arr(sol.data.advertencias)) console.log(`  ! ${String(a)}`);

  const map = parse(await proveedor.mapear_campos.execute({ caso, campos }, ctx()));
  if (!map.ok || !map.data) { console.log(`  ✗ mapear_campos: ${map.error}`); return false; }
  console.log(`  mapeo: ${arr(map.data.llenos).length} llenos · ${arr(map.data.faltantes).length} faltantes · ${arr(map.data.requiere_confirmacion).length} por confirmar`);
  for (const f of arr(map.data.faltantes) as { etiqueta: string; motivo: string }[]) console.log(`    faltante: ${f.etiqueta} — ${f.motivo}`);
  for (const f of arr(map.data.requiere_confirmacion) as { etiqueta: string; nota: string }[]) console.log(`    confirmar: ${f.etiqueta} — ${f.nota}`);

  const gen = parse(await proveedor.generar_formulario.execute({ caso, mapeo: map.data }, ctx()));
  console.log(gen.ok ? `  formulario: ${String(gen.data?.ruta)}${gen.data?.estado ? ` (${String(gen.data.estado)})` : ""}` : `  ✗ generar_formulario: ${gen.error}`);
  if (!gen.ok) return false;

  const paq = parse(await proveedor.armar_paquete.execute({ caso }, ctx()));
  if (!paq.ok || !paq.data) { console.log(`  ✗ armar_paquete: ${paq.error}`); return false; }
  console.log(`  paquete: ${String(paq.data.ruta)} · listo_para_firma=${String(paq.data.listo_para_firma)}`);
  for (const b of arr(paq.data.bloqueos)) console.log(`    bloqueo: ${String(b)}`);

  const sin = parse(await proveedor.simular_envio.execute({ caso, confirmado: true }, ctx()));
  console.log(`  envío sin verificación del backend → ${sin.ok ? "✗ DEBIO FALLAR" : `rechazado ("${sin.error}")`}`);
  const con = parse(await proveedor.simular_envio.execute({ caso, confirmado: true }, ctx({ confirmacionVerificada: true })));
  console.log(`  envío con confirmación → ${con.ok ? String(con.data?.ruta) : `✗ ${con.error}`}`);
  return !sin.ok && con.ok;
}

async function main() {
  await rm(path.join(directory, "out"), { recursive: true, force: true });
  const casos = (await readdir(path.join(directory, "fixtures", "reto-01", "casos"), { withFileTypes: true }))
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const resultados: [string, boolean][] = [];
  for (const caso of casos) resultados.push([caso, await procesar(caso)]);

  console.log("\n━━ casos de error (HU-5) ━━");
  for (const caso of ["no-existe", "../etc"]) {
    const r = parse(await proveedor.leer_solicitud.execute({ caso }, ctx()));
    console.log(`  ${caso.padEnd(10)} → ok=${r.ok} error="${r.error}"`);
  }
  const mal = parse(await proveedor.leer_solicitud.execute({ caso: 123 }, ctx()));
  console.log(`  args inválidos → ok=${mal.ok} error="${mal.error}"`);

  console.log("\n━━ resumen ━━");
  for (const [c, ok] of resultados) console.log(`  ${ok ? "✓" : "✗"} ${c}`);
  process.exitCode = resultados.every(([, ok]) => ok) ? 0 : 1;
}
main();
