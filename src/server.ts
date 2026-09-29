import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { cargarSystemPrompt, nuevaSesion, turno, type Dependencias, type Sesion } from "./agent.js";
import { AnthropicLLM } from "./llm/anthropic.js";
import type { LLM } from "./llm/adapter.js";
import { definiciones, herramientas } from "./tools/index.js";

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const num = (v: string | undefined, def: number) => (v && Number.isFinite(Number(v)) ? Number(v) : def);
const config = { maxIter: num(process.env.MAX_ITER, 25), maxTokensSesion: num(process.env.MAX_TOKENS_SESION, 200_000), directory };
const modelo = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
const MAX_SESIONES = 200;

const llm: LLM | null = process.env.ANTHROPIC_API_KEY ? new AnthropicLLM(process.env.ANTHROPIC_API_KEY, modelo, num(process.env.LLM_TIMEOUT_MS, 60_000)) : null;
const sesiones = new Map<string, Sesion>();
const ocupadas = new Set<string>();
const Chat = z.object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), message: z.string().trim().min(1).max(2000) });

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

async function leerCuerpo(req: IncomingMessage): Promise<unknown> {
  let total = 0;
  const partes: Buffer[] = [];
  for await (const p of req) {
    total += (p as Buffer).length;
    if (total > 32_768) throw new Error("cuerpo demasiado grande");
    partes.push(p as Buffer);
  }
  return JSON.parse(Buffer.concat(partes).toString("utf8"));
}

async function chat(req: IncomingMessage, res: ServerResponse) {
  let cuerpo: z.infer<typeof Chat>;
  try { cuerpo = Chat.parse(await leerCuerpo(req)); } catch { return json(res, 400, { error: "Solicitud inválida: se espera { sessionId, message } (mensaje de hasta 2000 caracteres)." }); }
  if (!llm) return json(res, 200, { reply: "El modelo no está configurado en este servidor (falta la variable ANTHROPIC_API_KEY).", toolCalls: [], needsConfirmation: false });
  if (ocupadas.has(cuerpo.sessionId)) return json(res, 429, { error: "Esta sesión aún está procesando un mensaje." });
  let sesion = sesiones.get(cuerpo.sessionId);
  if (!sesion) {
    if (sesiones.size >= MAX_SESIONES) sesiones.delete(sesiones.keys().next().value as string);
    sesion = nuevaSesion(cuerpo.sessionId);
    sesiones.set(cuerpo.sessionId, sesion);
  }
  ocupadas.add(cuerpo.sessionId);
  try {
    const deps: Dependencias = { llm, herramientas, definiciones: definiciones(), config };
    const system = await cargarSystemPrompt(directory, { directory, sessionId: sesion.id });
    json(res, 200, await turno(sesion, cuerpo.message, deps, system));
  } catch (e) {
    console.error("[chat] error:", e instanceof Error ? e.message : "desconocido");
    json(res, 200, { reply: "Ocurrió un error inesperado. Tu sesión sigue activa; puedes reintentar.", toolCalls: [], needsConfirmation: false });
  } finally {
    ocupadas.delete(cuerpo.sessionId);
  }
}

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true, provider: llm?.proveedor ?? "sin-configurar", model: llm?.modelo ?? modelo });
    if (req.method === "POST" && url.pathname === "/api/chat") return await chat(req, res);
    const m = /^\/api\/sessions\/([A-Za-z0-9_-]{8,64})$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      const s = sesiones.get(m[1]);
      return s ? json(res, 200, { id: s.id, historial: s.historial }) : json(res, 404, { error: "Sesión no encontrada." });
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(await readFile(path.join(directory, "web", "index.html")));
    }
    json(res, 404, { error: "No encontrado." });
  } catch {
    json(res, 500, { error: "Error interno." });
  }
});

const puerto = num(process.env.PORT, 3000);
servidor.listen(puerto, () => console.log(`Agente listo en http://localhost:${puerto} · modelo=${llm ? modelo : "SIN CONFIGURAR (falta ANTHROPIC_API_KEY)"}`));
