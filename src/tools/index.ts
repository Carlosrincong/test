import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import * as proveedor from "./proveedor.js";
import type { Herramienta } from "../core/herramienta.js";
import type { DefHerramienta } from "../llm/adapter.js";

/** Nombre visible para el modelo: `<archivo>_<export>`. */
export const herramientas: Record<string, Herramienta> = Object.fromEntries(
  Object.entries(proveedor).map(([nombre, t]) => [`proveedor_${nombre}`, t as Herramienta]),
);

export function definiciones(): DefHerramienta[] {
  return Object.entries(herramientas).map(([name, t]) => {
    const { $schema: _omitido, ...schema } = zodToJsonSchema(z.object(t.args), { $refStrategy: "none" }) as Record<string, unknown>;
    return { name, description: t.description, input_schema: schema };
  });
}
