# SOLUCION.md — Agente "Registro como Proveedor"

## 1. Problema en una frase
La analista administrativa de Periferia transcribe a mano, campo por campo, los mismos datos en 8–12 formularios de proveedor al mes (Excel, PDF o portal), con riesgo de error en datos sensibles (NIT, cuenta bancaria) y dependencia de una sola persona que sabe dónde está cada soporte.

## 2. Arquitectura

```
┌────────────┐  POST /api/chat   ┌──────────────────────────────────────────┐
│ web/ chat  │ ────────────────▶ │ src/server.ts (node:http, sesiones RAM)  │
│ tool cards │ ◀──────────────── │   └─ src/agent.ts: ciclo del agente      │
│ confirmar  │  {reply,toolCalls,│        ├─ src/llm/adapter.ts (interfaz)  │
└────────────┘   needsConfirm.}  │        │   └─ anthropic.ts (1 impl.)     │
                                 │        └─ src/tools/proveedor.ts (zod)   │
                                 │             └─ src/core/* (lógica pura)  │
                                 └───────┬───────────────────┬──────────────┘
                                  fixtures/ (solo lectura)   out/ (escritura + log.jsonl)
```

| Capa | Dónde vive | Qué contiene |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Reglas del agente y forma de responder |
| **Conocimiento** | `src/knowledge/registro-proveedor.md` | Reglas de negocio, estados, países |
| **Ejecución** | `src/tools/proveedor.ts` + `src/core/` | 5 herramientas con zod; mapeo, vigencias, xlsx/pdf |

`demo.ts` y el servidor importan **las mismas** herramientas: la lógica crítica no depende del modelo ni del HTTP. El prompt y el conocimiento se cargan desde archivo en cada turno, así que un cambio de reglas de negocio no toca el servidor.

## 3. Ciclo del agente
1. `turno()` calcula `confirmacionVerificada` **antes** de llamar al modelo: es `true` solo si el turno anterior armó el paquete, terminó con una pregunta **y** el mensaje actual es una afirmación corta sin negaciones (`esAfirmativo`).
2. Bucle: enviar (system + historial + herramientas) → si hay `tool_use`, validar args con zod, ejecutar, devolver `tool_result` → repetir hasta `end_turn`.
3. **Tope de iteraciones** (`MAX_ITER`, 25): al alcanzarlo responde con lo que hay. **Tope de tokens por sesión** (`MAX_TOKENS_SESION`). Timeout al proveedor (`LLM_TIMEOUT_MS`).
4. Errores de herramienta o proveedor se convierten en mensajes claros; la sesión sigue viva (CA5).
5. Cada llamada queda en el historial visible y en `out/log.jsonl` y `out/<caso>/log.jsonl`, **sin valores sensibles** (solo resúmenes).

**Confirmación humana (RN4).** `proveedor_simular_envio` exige `confirmado: true` **y** `ctx.confirmacionVerificada === true`, un dato que solo el backend puede fijar. Aunque el modelo alucine `confirmado: true`, sin pregunta previa y respuesta afirmativa la herramienta responde `requiere confirmación explícita`. Está probado en `test/agente-mock.ts`.

## 4. Elección del modelo y costo
- **Proveedor/modelo:** Anthropic, `claude-haiku-4-5-20251001` (configurable con `ANTHROPIC_MODEL`). La tarea es orquestar 4–5 llamadas a herramientas deterministas y redactar un resumen; no necesita un modelo grande.
- **Precio** (Haiku 4.5, según la página de precios de Anthropic consultada el 2026-09-28): $1 por millón de tokens de entrada, $5 de salida; lectura de caché $0.10, escritura $1.25.
- **Estimación por caso** (`co-industrias-delta`, flujo de 4 herramientas = 5 llamadas al modelo). Tokens aproximados como caracteres/3.5, medidos sobre el prompt, las definiciones de herramientas y los resultados reales:

| Concepto | Tokens |
|---|---|
| System prompt + conocimiento | ~1.100 |
| Definiciones de herramientas | ~890 |
| Resultados (leer 150 · mapear 615 · generar 25 · armar 157) | ~950 |
| **Entrada total (5 llamadas, se reenvía el historial)** | **~14.700** |
| **Salida total** | **~1.300** |
| **Costo por caso** | **≈ $0,021** |

Volumen: 100 casos ≈ $2,1; 1.000 casos ≈ $21. Con 8–12 solicitudes al mes el costo es irrelevante frente al tiempo ahorrado. El adaptador marca el system prompt con `cache_control`, pero el prefijo estático (~2.000 tokens) puede quedar por debajo del mínimo cacheable del modelo, así que **no cuento con ese ahorro** en la estimación.
- **Cotas de gasto:** máx. 25 iteraciones, tope de tokens por sesión, mensajes de 2.000 caracteres, 200 sesiones en memoria, una petición a la vez por sesión.

## 5. Diseño del portal web (solo documentación)
- **Estrategia:** un navegador controlado (Playwright) o una extensión que rellena el formulario con el `valores-portal.md` ya validado. El agente propone acciones y la persona las supervisa en una sesión visible.
- **Límites:** CAPTCHA y MFA no se automatizan; los cambios de layout rompen selectores (mitigar con selectores por etiqueta accesible y verificación campo a campo); los portales pueden prohibir la automatización en sus términos.
- **Credenciales:** nunca en el repo, el prompt ni los logs. Las ingresa la persona directamente en el navegador (o las inyecta un gestor de secretos que el modelo nunca ve).
- **Reparto:** el agente prepara valores y, si se autoriza, rellena campos; **el ingreso de credenciales, la resolución de CAPTCHA/MFA y el clic en "Enviar" son humanos.**
- Hoy: `proveedor_generar_formulario` responde `formato no soportado` y escribe `out/<caso>/valores-portal.md`.

## 6. Decisiones y trade-offs
| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Mapeo, vigencias y llenado en código determinista; el modelo solo orquesta | Que el LLM extraiga y mapee campos | Un modelo puede "completar" un dato plausible (riesgo del PRD). Con herramientas, `demo.ts` es reproducible y auditable |
| Confirmación verificada por el backend (`confirmacionVerificada`) | Confiar en el `confirmado: true` del modelo | RN4 no debe depender de que el modelo obedezca |
| `generar_formulario` recomprueba cada valor contra el maestro | Escribir lo que el modelo pase en `mapeo` | Impide que un valor inventado llegue al formulario (CA2) |
| Similitud de texto + guardia de "término distintivo" | Embeddings / preguntar al LLM | Sin costo ni no-determinismo. La guardia nació de un fallo real: "Número de sucursales" se emparejaba con `numero_empleados` por el prefijo "número de" |
| Servidor con `node:http` + `tsx` | Express/Hono, Bun | Cero dependencias de servidor; en el entorno de desarrollo no había Bun, y el PRD acepta Node 20+ |
| `simular_envio` permite simular aun con paquete no listo, dejando advertencia en `ENVIO-SIMULADO.md` | Bloquearlo | El PRD espera que "envía" produzca el archivo tras confirmar; el prompt obliga a advertir los bloqueos en la pregunta |
| Detección de "sí" por reglas simples | Botones con intención estructurada | Simplicidad. Los botones del front envían texto; en producción enviaría un evento firmado |

## 7. Supuestos
- "Vencido" es `vigencia_hasta < fecha de ejecución`; `null` = no vence. **Por vencer** = 15 días o menos (umbral propio, no del PRD).
- Fecha de ejecución = hoy, con override `FECHA_EJECUCION` para reproducibilidad.
- Etiquetas ambiguas ("Identificación tributaria") siempre piden confirmación, incluso en Colombia.
- Confianza < 0,8 → `requiere_confirmacion`; < 0,5 o sin término distintivo compartido → `faltante`. Un valor por confirmar **sí se escribe** en el formulario, resaltado (amarillo) con nota; los faltantes quedan vacíos en rojo.
- El borrador de correo se firma con el representante legal del maestro y nunca incluye datos bancarios.

## 8. Cobertura
| HU | Estado | Nota |
|---|---|---|
| HU-1 Leer solicitud | Hecho | Los 4 casos reales leídos; ambiguos y plantilla corrupta cubiertos en sintéticos |
| HU-2 Mapear campos | Hecho | Tres estados, glosario, RN1 (RTN/RUC con nota de "identificador extranjero"), fuzzy <0.8 marcado |
| HU-3 Formulario | Hecho | xlsx (CO, HN), pdf (EC) y portal (PA) generados en el `demo`. PDF y xlsx verificados por bytes y celda |
| HU-4 Paquete | Hecho | Vencidos y ausentes bloquean (EC, HN); faltantes no (RN3). Checklist y borrador de correo escritos |
| HU-5 Errores | Hecho | `{ok:data}`/`{ok:false,error}`, sin excepciones: caso inexistente, path traversal y args inválidos |

**Verificación sin modelo:**
- `npm run demo` → los 4 casos OK (CO listo_para_firma=true; EC y HN bloqueados por soportes; PA por portal)
- `npm run test:sinteticos` → PDF, RN1, vencidos/ausentes, portal, plantilla corrupta, CA2 (valor inventado rechazado), RN4
- `npm run test:agente` → ciclo completo con LLM simulado: flujo, RN4, CA1 (tope), CA5 (error y recuperación), tope de tokens
- `npm run typecheck` → sin errores

**Falta para producción:** integración real con correo/firma, dueño del dato maestro,
autenticación, persistencia de sesiones, más plantillas reales, evals del prompt con el
modelo real, despliegue público [URL].

## 9. Uso de IA
Se uso IA para el desarrollo de los modulos del agente, el front y el backend. Asi como para redaccion de documentos clave para el desarrollo de la solucion.  

## 10. Riesgos en producción
| Riesgo | Mitigación |
|---|---|
| Plantillas reales más caóticas que los fixtures | Umbrales de confianza, `requiere_confirmacion` por defecto ante duda, evals con plantillas reales |
| Maestro desactualizado | Dueño del dato, fecha de última revisión en cada valor |
| El modelo inventa un valor | Herramientas como única fuente; recomprobación contra el maestro; evals |
| Datos sensibles (cuenta, NIT) en logs o chat | Logs solo con resúmenes; el prompt prohíbe repetir datos bancarios |
| Abuso de la clave del modelo | Topes de iteraciones/tokens/sesiones; añadir autenticación y rate limit por IP |
| Confirmación "sí" ambigua | Evento estructurado firmado desde el front |
| Sesiones en memoria se pierden al reiniciar | Persistir en archivo/DB |
