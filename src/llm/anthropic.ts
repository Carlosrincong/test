import type { Bloque, DefHerramienta, LLM, Mensaje, RespuestaLLM } from "./adapter.js";
import { LLMError } from "./adapter.js";

interface RespuestaApi {
  content?: Bloque[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

export class AnthropicLLM implements LLM {
  readonly proveedor = "anthropic";
  constructor(
    private readonly apiKey: string,
    readonly modelo: string,
    private readonly timeoutMs: number,
  ) {}

  async enviar(mensajes: Mensaje[], herramientas: DefHerramienta[]): Promise<RespuestaLLM> {
    const system = mensajes.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : "")).join("\n\n");
    const resto = mensajes.filter((m) => m.role !== "system");
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: this.modelo,
          max_tokens: 2048,
          // Prompt caching: el system prompt es idéntico entre turnos.
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages: resto,
          tools: herramientas,
        }),
      });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new LLMError(timeout ? "El modelo tardó demasiado en responder. Intenta de nuevo." : "No pude conectarme con el modelo. Intenta de nuevo en un momento.");
    }
    const cuerpo = (await res.json().catch(() => ({}))) as RespuestaApi;
    if (!res.ok) {
      const msg = res.status === 401 ? "La clave del modelo no es válida." : res.status === 429 ? "El modelo está saturado o se agotó el cupo. Intenta más tarde." : `El proveedor del modelo devolvió un error (${res.status}).`;
      throw new LLMError(msg);
    }
    const stop = cuerpo.stop_reason === "end_turn" || cuerpo.stop_reason === "tool_use" || cuerpo.stop_reason === "max_tokens" ? cuerpo.stop_reason : "otro";
    return { content: cuerpo.content ?? [], stop, usage: { input: cuerpo.usage?.input_tokens ?? 0, output: cuerpo.usage?.output_tokens ?? 0 } };
  }
}
