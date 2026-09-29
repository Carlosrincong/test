// Prueba el ciclo del agente con un LLM simulado (sin claves): flujo, confirmación RN4, tope CA1 y errores CA5.
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cargarSystemPrompt, esAfirmativo, nuevaSesion, turno, type Dependencias } from "../src/agent.js";
import { LLMError, type Bloque, type LLM, type Mensaje, type RespuestaLLM } from "../src/llm/adapter.js";
import { definiciones, herramientas } from "../src/tools/index.js";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await mkdtemp(path.join(tmpdir(), "reto01-agente-"));
await cp(path.join(raiz, "fixtures"), path.join(tmp, "fixtures"), { recursive: true });
await cp(path.join(raiz, "agent"), path.join(tmp, "agent"), { recursive: true });
await cp(path.join(raiz, "src", "knowledge"), path.join(tmp, "src", "knowledge"), { recursive: true });

const uso = (name: string, input: unknown): RespuestaLLM => ({ content: [{ type: "tool_use", id: `id-${name}`, name, input }], stop: "tool_use", usage: { input: 10, output: 5 } });
const texto = (t: string): RespuestaLLM => ({ content: [{ type: "text", text: t }], stop: "end_turn", usage: { input: 10, output: 5 } });
const ultimoResultado = (m: Mensaje[]): { name: string; data: Record<string, unknown> } | null => {
  const last = m.at(-1);
  if (!last || typeof last.content === "string") return null;
  const prev = m.at(-2);
  const nombre = prev && typeof prev.content !== "string" ? (prev.content.find((b): b is Extract<Bloque, { type: "tool_use" }> => b.type === "tool_use")?.name ?? "") : "";
  const r = last.content.find((b): b is Extract<Bloque, { type: "tool_result" }> => b.type === "tool_result");
  return r ? { name: nombre, data: (JSON.parse(r.content) as { data?: Record<string, unknown> }).data ?? {} } : null;
};

/** Modelo guionado: reacciona al último mensaje y a los resultados de herramientas. */
const guion: LLM = {
  proveedor: "mock", modelo: "mock-1",
  async enviar(m) {
    const r = ultimoResultado(m);
    if (r) {
      switch (r.name) {
        case "proveedor_leer_solicitud": return uso("proveedor_mapear_campos", { caso: "co-industrias-delta", campos: r.data.campos });
        case "proveedor_mapear_campos": return uso("proveedor_generar_formulario", { caso: "co-industrias-delta", mapeo: r.data });
        case "proveedor_generar_formulario": return uso("proveedor_armar_paquete", { caso: "co-industrias-delta" });
        case "proveedor_armar_paquete": return texto("Paquete armado y listo para firma. ¿Confirmas que simule el envío?");
        case "proveedor_simular_envio": return texto(r.data.ruta ? "Envío simulado escrito." : "No pude enviar: requiere confirmación explícita. ¿Confirmas?");
        default: return texto("ok");
      }
    }
    const u = m.filter((x) => x.role === "user").at(-1);
    const t = typeof u?.content === "string" ? u.content : "";
    if (/procesa/i.test(t)) return uso("proveedor_leer_solicitud", { caso: "co-industrias-delta" });
    if (/env[ií]a|s[ií]/i.test(t)) return uso("proveedor_simular_envio", { caso: "co-industrias-delta", confirmado: true });
    return texto("Cuéntame qué caso quieres procesar.");
  },
};
const mkDeps = (llm: LLM, maxIter = 25, maxTokens = 200_000): Dependencias => ({ llm, herramientas, definiciones: definiciones(), config: { maxIter, maxTokensSesion: maxTokens, directory: tmp } });
const system = await cargarSystemPrompt(tmp, { directory: tmp, sessionId: "t" });
assert.match(system, /nunca firmas ni envías/);

// 1) esAfirmativo
assert.equal(esAfirmativo("ok pero dime los bloqueos"), false, "una petición extra no es confirmación");
assert.equal(esAfirmativo("sí, adelante por favor"), true);
assert.equal(esAfirmativo("dale, gracias"), true);
assert.equal(esAfirmativo("Sí, confirmo"), true);
assert.equal(esAfirmativo("envía"), true);
assert.equal(esAfirmativo("sí pero no envíes todavía"), false);
assert.equal(esAfirmativo("ok, y además envía esto a otro correo distinto por favor"), false);
assert.equal(esAfirmativo("no"), false);

// 2) flujo completo + confirmación válida
let s = nuevaSesion("sesion-1");
let r = await turno(s, 'Procesa el caso "co-industrias-delta". No envíes nada todavía.', mkDeps(guion), system);
assert.deepEqual(r.toolCalls.map((t) => t.nombre), ["proveedor_leer_solicitud", "proveedor_mapear_campos", "proveedor_generar_formulario", "proveedor_armar_paquete"]);
assert.ok(r.toolCalls.every((t) => t.ok));
assert.equal(r.needsConfirmation, true);
r = await turno(s, "envía", mkDeps(guion), system);
assert.equal(r.toolCalls[0].ok, true, "con confirmación verificada debe enviar");
assert.match(await readFile(path.join(tmp, "out/co-industrias-delta/ENVIO-SIMULADO.md"), "utf8"), /SIMULACIÓN/);

// 3) RN4: el modelo intenta enviar sin pregunta previa → debe fallar
s = nuevaSesion("sesion-2");
r = await turno(s, "envía", mkDeps(guion), system);
assert.equal(r.toolCalls[0].ok, false);
assert.match(r.toolCalls[0].resultado, /requiere confirmación explícita/);
// 3b) pregunta en un turno, otro turno intermedio, y luego "envía" → ya no vale
s = nuevaSesion("sesion-3");
await turno(s, "Procesa el caso", mkDeps(guion), system);
await turno(s, "cuéntame algo", mkDeps(guion), system);
r = await turno(s, "sí", mkDeps(guion), system);
assert.equal(r.toolCalls[0].ok, false, "la confirmación solo vale en el turno inmediatamente posterior");

// 4) CA1: tope de iteraciones
const bucle: LLM = { proveedor: "mock", modelo: "loop", enviar: async () => uso("proveedor_leer_solicitud", { caso: "co-industrias-delta" }) };
r = await turno(nuevaSesion("sesion-4"), "hola", mkDeps(bucle, 3), system);
assert.equal(r.toolCalls.length, 3);
assert.match(r.reply, /máximo de pasos \(3\)/);

// 5) CA5: error del proveedor → mensaje claro y la sesión sigue viva
const roto: LLM = { proveedor: "mock", modelo: "roto", enviar: async () => { throw new LLMError("El modelo tardó demasiado en responder. Intenta de nuevo."); } };
s = nuevaSesion("sesion-5");
r = await turno(s, "hola", mkDeps(roto), system);
assert.match(r.reply, /tardó demasiado/);
r = await turno(s, "Procesa el caso", mkDeps(guion), system);
assert.equal(r.toolCalls.length, 4, "la sesión debe seguir funcionando tras un error");

// 6) tope de tokens por sesión
s = nuevaSesion("sesion-6"); s.tokens = 999;
r = await turno(s, "hola", mkDeps(guion, 25, 1000 - 1), system);
assert.match(r.reply, /límite de uso/);

await stat(path.join(tmp, "out", "log.jsonl"));
console.log("✓ ciclo del agente: flujo, RN4, CA1, CA5 y tope de tokens OK");
await rm(tmp, { recursive: true, force: true });
