// Interfaz propia del proveedor: cambiar de LLM no toca el ciclo del agente.
export type Bloque =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface Mensaje {
  role: "system" | "user" | "assistant";
  content: string | Bloque[];
}

export interface DefHerramienta {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface RespuestaLLM {
  content: Bloque[];
  stop: "end_turn" | "tool_use" | "max_tokens" | "otro";
  usage: { input: number; output: number };
}

export interface LLM {
  readonly proveedor: string;
  readonly modelo: string;
  enviar(mensajes: Mensaje[], herramientas: DefHerramienta[]): Promise<RespuestaLLM>;
}

/** Error del proveedor con mensaje apto para el usuario (nunca incluye claves). */
export class LLMError extends Error {}
