import { z } from "zod";
import { ToolError, registrar, type Ctx } from "./util.js";

export interface Definicion<S extends z.ZodRawShape> {
  description: string;
  args: S;
  /** Devuelve los datos y un resumen SIN valores sensibles (va al log). */
  run: (args: z.infer<z.ZodObject<S>>, ctx: Ctx) => Promise<{ data: unknown; resumen: string }>;
}

export interface Herramienta<S extends z.ZodRawShape = z.ZodRawShape> {
  description: string;
  args: S;
  execute(args: unknown, ctx: Ctx): Promise<string>;
}

function casoDe(args: unknown): string | null {
  if (typeof args === "object" && args !== null && "caso" in args) {
    const c = (args as { caso: unknown }).caso;
    if (typeof c === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(c)) return c;
  }
  return null;
}

/** Contrato: execute NUNCA lanza; siempre devuelve JSON `{ok:true,data}` o `{ok:false,error}`. */
export function herramienta<S extends z.ZodRawShape>(nombre: string, def: Definicion<S>): Herramienta<S> {
  const schema = z.object(def.args);
  return {
    description: def.description,
    args: def.args,
    async execute(args: unknown, ctx: Ctx): Promise<string> {
      const caso = casoDe(args);
      const fallo = async (error: string): Promise<string> => {
        await registrar(ctx, caso, nombre, false, error);
        return JSON.stringify({ ok: false, error });
      };
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return fallo("Argumentos inválidos: " + parsed.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; "));
      }
      try {
        const { data, resumen } = await def.run(parsed.data, ctx);
        await registrar(ctx, caso, nombre, true, resumen);
        return JSON.stringify({ ok: true, data });
      } catch (e) {
        if (e instanceof ToolError) return fallo(e.message);
        console.error(`[${nombre}] error inesperado:`, e instanceof Error ? e.message : "desconocido");
        return fallo(`Error inesperado en ${nombre}. Intenta de nuevo o avisa al equipo técnico.`);
      }
    },
  };
}
