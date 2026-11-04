# Fase 1: composición, contratos y persistencia

La fase introduce los límites y el ciclo de vida de la arquitectura nueva. No
reescribe todavía los casos de uso de identidad ni las políticas de compartición.

## Composición y ciclo de vida

- `server/index.js` contiene únicamente política de proceso: logger, señales,
  diagnóstico, readiness y límite de tiempo de parada.
- `server/app/create-application.js` es una aplicación de un solo uso, con
  `start()`/`stop()` idempotentes, construcción diferida y limpieza ante arranque fallido.
- `server/app/compose-server.js` ensambla HTTP, seguridad y adaptadores de Ignis.
- `server/app/create-security.js` construye persistencia, sesiones y servicios;
  el adaptador HTTP los recibe explícitamente.
- `server/integration/ignis/` concentra montaje de rutas y conexiones de eventos.

La parada deja de aceptar HTTP, termina sockets, espera operaciones en curso y
retira suscripciones, timers, watchers y complementos antes de cerrar persistencia.
Las escrituras pendientes se vacían antes de cerrar la base. Un fallo al limpiar
un recurso no impide intentar los demás; los errores se conservan agregados.

Los adaptadores originales de Ignis aún contienen singletons. Por ello solo se
permite un runtime predeterminado activo por proceso; intentar un segundo se
rechaza sin afectar al primero. Se puede crear otra aplicación después de parar
la anterior. No se anuncia soporte de varias instancias aisladas concurrentes.
`createApplication` permite inyectar el runtime para probar el lifecycle sin señales
ni efectos de infraestructura. Importar ese módulo no arranca el servidor.

## Contratos iniciales

`packages/contracts/src/session.js` define una instantánea inmutable de identidad,
comparación con una sesión vigente y el límite de reautenticación de cinco minutos.
No contiene cookies, tokens secretos, SQL ni permisos duraderos. El servidor sigue
siendo la autoridad y revalida la sesión al emitir respuestas protegidas.

`npm run lint` incorpora `scripts/check-architecture.mjs`. Comprueba contratos
puros, ausencia de dependencias inversas desde persistencia, nuevos imports
cliente→servidor y ciclos que incluyan los módulos arquitectónicos nuevos. Las
once dependencias antiguas de UI están enumeradas explícitamente hasta retirarlas
en fase 6. Este control estático no es un sandbox ni reemplaza las pruebas de permisos.

## Persistencia

`server/platform/persistence/` sustituye `auth/database.js` y `auth/schema.js`.
No quedan fachadas en las rutas antiguas. Todos los consumidores y fixtures usan
la nueva ubicación.

El esquema inicial versión 1 sustituye la secuencia de 19 migraciones de desarrollo.
Se conserva la estructura vigente y sus invariantes; desaparece la columna histórica
sin consumidores `resource_destinations.destination_folder`. Las preferencias
privadas siguen presentes hasta resolver ese ámbito en fase 3.

La apertura comprueba el marcador `schema_info` y la estructura real de tablas,
índices y triggers. Una base antigua o modificada se rechaza antes de cambiar su
journal o su esquema. No se repara, actualiza, elimina ni recrea silenciosamente.
La creación nueva es transaccional y admite procesos concurrentes; las transacciones
rechazan callbacks `async` antes de ejecutarlos y resultados thenable antes del commit.
El contrato sigue siendo estrictamente síncrono: no se deben iniciar tareas async
desde un callback ordinario de transacción.

Se mantienen permisos privados, WAL, integridad, claves foráneas, restricciones de
último administrador, unicidad y triggers de revocación. Backup y restore validan
el esquema vigente y restaurar no resucita sesiones.

**Ruptura intencional de desarrollo:** las bases y backups anteriores a esta fase
son incompatibles. Conservarlos y utilizar un `DATA_ROOT` nuevo. El arranque informa
`server.schema_incompatible` con un mensaje fijo y no incluye rutas ni secretos.
No hay un comando de borrado automático ni una migración de instalaciones antiguas.

## Evidencia y límites

Las pruebas específicas cubren inicio/parada concurrentes, parada durante inicio,
fallos parciales y limpieza que continúa tras un error. Un proceso real inicia y
para dos aplicaciones sucesivas, con watchers activos, sin `process.exit` ni handlers
de señales añadidos por la aplicación. Otra prueba ejecuta el entrypoint contra
una base antigua y verifica salida, diagnóstico y conservación de sus bytes.

Las pruebas de migraciones antiguas se han sustituido por rechazo de esquemas,
persistencia tras reapertura, integridad real y unicidad en el esquema inicial.
Se conservan las pruebas de concurrencia, backup, recuperación y seguridad de los
servicios. Los triggers temporales usados para inyectar fallos se retiran antes
de reabrir una base cuya estructura debe coincidir con el esquema aprobado.

Las ventanas no se rediseñan aquí. Las verificaciones sintéticas de UI y el fixture
HTTP de carga siguen comprobando la integración; no certifican Obsidian real ni
el teclado Android. La referencia de cinco rondas de fase 0 permanece intacta.

Verificación de esta entrega: 173 archivos de pruebas, 2.151 pruebas pasadas y
una omitida por requerir el fixture ENOSPC. Lint, comprobación de dependencias,
filtraciones de errores y build pasan. Los smoke tests de gestión pasan en
escritorio y móvil con API sintética y CSS nativo 1.14.5; una ronda completa del
fixture HTTP de carga termina correctamente. Las advertencias preexistentes del
build sobre eval y accesibilidad de ListItem permanecen.

Además se comparó el esquema inicial contra la referencia de fase 0: se conservan
las columnas vigentes de las 20 tablas funcionales, los 16 triggers y los índices
explícitos. Las diferencias intencionales son el nuevo marcador y la eliminación
de la columna histórica ya descrita. La revisión final de reautenticación y
cobertura de montaje de rutas pasa también sus 112 pruebas específicas.

## Siguiente corte

Fase 2 extraerá los recorridos de identidad y cuenta del adaptador HTTP hacia casos
de uso y rutas pequeñas. La construcción ya está separada, pero no se presenta
`auth/http.js` como un módulo completamente refactorizado: conserva controladores,
políticas de transporte y proyección que se sustituirán en las fases siguientes.
