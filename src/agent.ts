import { readFile } from "node:fs/promises";
import path from "node:path";
import { LLMError, type Bloque, type DefHerramienta, type LLM, type Mensaje } from "./llm/adapter.js";
import type { Herramienta } from "./core/herramienta.js";
import { hoy, normalizar, registrar, type Ctx } from "./core/util.js";

export interface LlamadaHerramienta { nombre: string; args: unknown; ok: boolean; resultado: string }
export interface EntradaHistorial { rol: "user" | "assistant"; texto: string; herramientas: LlamadaHerramienta[] }
export interface Sesion {
  id: string;
  mensajes: Mensaje[];
  historial: EntradaHistorial[];
  /** RN4: solo es true si el turno anterior armó el paquete y terminó con una pregunta. */
  pendienteEnvio: boolean;
  tokens: number;
}
export interface Config { maxIter: number; maxTokensSesion: number; directory: string }
export interface Dependencias { llm: LLM; herramientas: Record<string, Herramienta>; definiciones: DefHerramienta[]; config: Config }
export interface ResultadoTurno { reply: string; toolCalls: LlamadaHerramienta[]; needsConfirmation: boolean }

export function nuevaSesion(id: string): Sesion {
  return { id, mensajes: [], historial: [], pendienteEnvio: false, tokens: 0 };
}

const AFIRMATIVOS = new Set(["si", "sip", "claro", "ok", "okay", "dale", "adelante", "confirmo", "confirmado", "envia", "enviar", "enviala", "envialo", "apruebo", "aprobado", "procede", "hazlo", "correcto", "listo", "vale"]);
const NEGATIVOS = new Set(["no", "nunca", "espera", "espere", "todavia", "cancela", "cancelar", "detente", "aun"]);
const NEUTROS = new Set(["por", "favor", "porfa", "porfavor", "gracias", "el", "la", "lo", "los", "las", "un", "una", "de", "del", "que", "ya", "pues", "entonces", "va", "bueno", "esta", "está", "todo", "bien"]);

export function esAfirmativo(mensaje: string): boolean {
  const tokens = normalizar(mensaje).split(" ").filter(Boolean);
  if (tokens.length === 0 || tokens.length > 6) return false;
  if (tokens.some((t) => NEGATIVOS.has(t))) return false;
  if (!AFIRMATIVOS.has(tokens[0])) return false;
  return tokens.every((t, i) => i === 0 || AFIRMATIVOS.has(t) || NEUTROS.has(t));
}

export async function cargarSystemPrompt(directory: string, ctx: Ctx): Promise<string> {
  const prompt = await readFile(path.join(directory, "agent", "prompt.md"), "utf8");
  const conocimiento = await readFile(path.join(directory, "src", "knowledge", "registro-proveedor.md"), "utf8");
  return `${prompt}\n\n---\n# Conocimiento del proceso\n${conocimiento}\n\nFecha de hoy: ${hoy(ctx)}`;
}

const resumir = (s: string, max = 600) => (s.length > max ? `${s.slice(0, max)}… [recortado]` : s);

export async function turno(sesion: Sesion, mensajeUsuario: string, deps: Dependencias, system: string): Promise<ResultadoTurno> {
  const { llm, herramientas, definiciones, config } = deps;
  const toolCalls: LlamadaHerramienta[] = [];
  // RN4: la confirmación la decide el backend, no el modelo.
  const ctx: Ctx = { directory: config.directory, sessionId: sesion.id, confirmacionVerificada: sesion.pendienteEnvio && esAfirmativo(mensajeUsuario) };
  sesion.pendienteEnvio = false;
  sesion.historial.push({ rol: "user", texto: mensajeUsuario, herramientas: [] });

  const terminar = (reply: string, armoPaquete: boolean): ResultadoTurno => {
    const pregunta = reply.trim().endsWith("?");
    sesion.pendienteEnvio = pregunta && armoPaquete;
    sesion.historial.push({ rol: "assistant", texto: reply, herramientas: toolCalls });
    return { reply, toolCalls, needsConfirmation: armoPaquete && pregunta };
  };

  if (sesion.tokens >= config.maxTokensSesion) {
    return terminar("Esta sesión alcanzó su límite de uso. Abre una sesión nueva para continuar.", false);
  }

  sesion.mensajes.push({ role: "user", content: mensajeUsuario });
  let armoPaquete = false;
  let ultimoTexto = "";


  for (let iter = 0; iter < config.maxIter; iter++) {
    let respuesta;
    try {
      respuesta = await llm.enviar([{ role: "system", content: system }, ...sesion.mensajes], definiciones);
    } catch (e) {
      const msg = e instanceof LLMError ? e.message : "Ocurrió un error al consultar el modelo.";
      await registrar(ctx, null, "llm", false, msg);
      return terminar(`${msg} Tu sesión sigue activa; puedes reintentar.`, armoPaquete);
    }
    sesion.tokens += respuesta.usage.input + respuesta.usage.output;

    if (respuesta.stop === "max_tokens") {
      await registrar(ctx, null, "llm", false, "respuesta truncada por max_tokens");
      return terminar(
        "El modelo no alcanzó a terminar su respuesta (se quedó sin espacio). " +
        "Intenta reformular el pedido en un mensaje más corto o dividirlo en pasos.",
        armoPaquete,
      );
    }

    sesion.mensajes.push({ role: "assistant", content: respuesta.content });
    const texto = respuesta.content.filter((b): b is Extract<Bloque, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n").trim();
    if (texto) ultimoTexto = texto;
    const usos = respuesta.content.filter((b): b is Extract<Bloque, { type: "tool_use" }> => b.type === "tool_use");
    if (usos.length === 0) return terminar(texto || "No tengo nada más que agregar.", armoPaquete);

    const resultados: Bloque[] = [];
    for (const uso of usos) {
      const herramienta = herramientas[uso.name];
      const crudo = herramienta
        ? await herramienta.execute(uso.input, ctx)
        : JSON.stringify({ ok: false, error: `La herramienta "${uso.name}" no existe.` });
      const ok = (JSON.parse(crudo) as { ok: boolean }).ok;
      if (uso.name === "proveedor_armar_paquete" && ok) armoPaquete = true;
      toolCalls.push({ nombre: uso.name, args: uso.input, ok, resultado: resumir(crudo) });
      resultados.push({ type: "tool_result", tool_use_id: uso.id, content: crudo, is_error: !ok });
    }
    sesion.mensajes.push({ role: "user", content: resultados });
    if (sesion.tokens >= config.maxTokensSesion) {
      return terminar("Alcancé el límite de uso de esta sesión. Esto es lo que logré hasta ahora; revisa los resultados de las herramientas arriba.", armoPaquete);
    }
  }

  const parcial = ultimoTexto ? `${ultimoTexto}\n\n` : "";
  return terminar(`${parcial}Alcancé el máximo de pasos (${config.maxIter}) en este turno. Revisa arriba lo que sí se ejecutó y dime cómo continuar.`, armoPaquete);
}
