# Proceso de registro como proveedor

## Origen y formatos
Las solicitudes llegan por correo de clientes en Colombia, Ecuador, Perú, Panamá y Honduras. El formato de salida puede ser plantilla Excel (`xlsx`), formulario PDF (`pdf`) o portal web (`portal`). Del portal no se automatiza nada: solo se dejan los valores listos para copiar; las credenciales y el clic en "Enviar" son humanos.

## Estados de un campo
- `lleno`: existe en el maestro (se conoce la ruta del dato).
- `faltante`: no existe en el maestro. No bloquea `listo_para_firma`, pero queda en el checklist.
- `requiere_confirmacion`: mapeo con confianza < 0.8, etiqueta ambigua o regla de país.

## Reglas de negocio
- **RN1 Identificador tributario:** CO → NIT; EC, PE y PA → RUC; HN → RTN. Periferia solo tiene NIT colombiano; en otros países se llena con el NIT y se marca por confirmar ("identificador extranjero").
- **RN2 Datos bancarios:** solo si la plantilla los pide. Nunca en el borrador de correo.
- **RN3 Paquete listo para firma:** un soporte vencido o ausente lo bloquea. Un campo faltante no.
- **RN4 Acciones externas:** requieren confirmación explícita del usuario en el turno inmediatamente anterior.

## Vigencia de soportes
Estados: `vigente`, `por_vencer` (15 días o menos), `vencido`, `sin_vencimiento` (por ejemplo el RUT) y `ausente`. Los vencidos se deben renovar antes de enviar; los por vencer conviene avisarlos.

## Cierre
El representante legal firma; el agente nunca lo hace. "Enviar" en este entorno solo escribe `out/<caso>/ENVIO-SIMULADO.md`.
