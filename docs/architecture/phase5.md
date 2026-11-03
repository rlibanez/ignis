# Fase 5: comparticiones y eventos

## Responsabilidades

`features/sharing/application/sharing.js` define el registro de operaciones,
contexto de identidad y notificación tras mutaciones. Recibe sesiones y un puerto
de almacenamiento; no importa Express, SQLite ni filesystem. Cada invocación crea
una credencial interna inmutable con su token y contexto. El adaptador comprueba
ese mismo contexto cada vez que vuelve a autorizar, incluidas las comprobaciones
transaccionales posteriores a esperas. Un resultado de lectura atrasado no se
entrega a una sesión sustituida.

El adaptador `features/sharing/adapters/resource-shares.js` conserva las invariantes
transaccionales de grants, ubicaciones, revisiones, identidades de archivo,
colisiones y publicación de subárboles. Usa el catálogo/resolvedor común de
bóvedas y el publisher de contenido de fase 4. Las rutas están en
`transport/http/sharing/router.js`, con sus validaciones HTTP y errores públicos.
No quedan facades en las ubicaciones antiguas de `auth/` ni `routes/`.

Las notificaciones se programan después del retorno/commit de la mutación; los
resultados inciertos también invalidan para que otros clientes consulten el estado
real. Un fallo al notificar no transforma un guardado confirmado en fallido.
Las lecturas no notifican ni disparan el fallback HTTP de mutaciones. Ese fallback
se conserva para los recorridos de identidad/bóvedas todavía fuera de este módulo.

## Eventos privados y fuentes

El broker `adapters/events.js` recibe un store de proyecciones, conexiones vigentes
y el observador de base de datos. Los snapshots permanecen en el servidor y los
eventos contienen solo `type` y flags booleanos de cuenta/comparticiones/bóvedas.
No se envían nombres, rutas, destinatarios, contenido ni credenciales en mensajes.
Solo reciben invalidación los usuarios cuya proyección autorizada cambia o que
están afectados por un cambio de contenido. Los sockets de bóveda conservan el
filtrado de eventos por la política común y no calculan catálogos de cuenta.

Los destinatarios de contenido se resuelven al entregar el lote, no al encolarlo:
una revocación concurrente no deja una lista de destinatarios obsoleta. Los bursts
se agrupan por bóveda y conjunto de rutas; más de 128 rutas se convierten en una
invalidación de la fuente completa, sin crecer sin límite con cada archivo.

Se mantienen watchers únicamente para fuentes con propietarios o destinatarios
que tengan una suscripción de cuenta activa. Funcionan aunque no esté abierta la
bóveda de origen. El broker retira sus listeners al desaparecer el último
suscriptor y reconstruye sus referencias cuando el watcher de origen se reinicia.
No realiza consultas de fuentes cuando no hay suscriptores de cuenta.

`adapters/database-watch.js` observa commits de SQLite, también los hechos desde
otros procesos como el CLI. Si falla/cierra el watcher, lo vuelve a instalar con
backoff acotado (1–30 segundos). Durante la indisponibilidad se cierran sockets y
no se admiten nuevas suscripciones; al recuperarse se reconcilia de nuevo. El
estado completo se recupera al reconectar. Cerrar la aplicación cancela los
timeouts de recuperación y los listeners; no queda un segundo broker en el
siguiente arranque dentro del proceso.

## Sin sondeo de comparticiones en reposo

Se elimina `pong -> reconcile`, que consultaba catálogos en cada heartbeat. El
heartbeat del WebSocket conserva su función de liveness; no se utiliza para
consultar comparticiones. Los eventos proceden de mutaciones, commits observados,
cambios de archivos y conexión/desconexión. Las reconciliaciones de ráfagas usan
timeouts de una sola ejecución, no intervalos de polling.

El purge de sesiones caducadas de 60 segundos permanece como mantenimiento de
identidad. El backoff de un watcher averiado o una red caída tampoco es un sondeo
periódico cuando el sistema está sano. No se retiran los mecanismos upstream de
reconciliación de árboles de filesystem necesarios para sus cachés.

## Reconexión y aislamiento en el cliente

El canal de cuenta usa backoff exponencial con jitter, máximo 30 segundos, cuando
una conexión falla. No abre un socket nuevo inmediatamente desde `onclose`; eso
evita bucles de upgrades rechazados. Una apertura correcta reinicia el backoff y
solicita estado autorizado completo. Al volver del segundo plano se reemplaza la
conexión y se refresca, sin asumir que se recibieron todos los eventos.

Las consultas de sesión también llevan una generación: una respuesta antigua
posterior a logout/suspensión no redirige ni abre otra conexión. No se cierra sesión
por una mera caída de red; una revocación confirmada sigue bloqueando el cliente.

El runtime de montajes del shim fija cada intercambio y operación a sesión,
bóveda y generación. Al detener/reconfigurar, lecturas, montajes, renombrados,
copias y escrituras pendientes ya no pueden instalar datos en las cachés de otra
cuenta, cambiar sus flags de refresh o registrar un borrador antiguo como suyo.
Los menús/colas de acciones y los descriptores de montajes tienen el mismo límite.
Se conserva la recuperación de borradores de fase 4 y no se reenvían escrituras
inciertas al reconectar.

Las pruebas existentes de downgrade/upgrade, nota limpia y nota con borrador
permanecen: un lector sin cambios no crea una falsa recuperación; devolver escritura
permite volver a guardar con la baseline válida. Una versión conflictiva o un
grant sustituido no se rebasa silenciosamente para desbloquear una edición vieja.

## Verificación y límites

La prueba de servidor real con tres cuentas comprueba notificación de grants y
cambios lectura/escritura, reconexión con permisos actualizados, ausencia de eventos
para un tercero, cambios externos de archivo sin bóveda abierta y operaciones CLI
(registro de bóveda y revocación por cambio de correo) sin depender de heartbeat.
Los frames se verifican para que solo contengan los flags permitidos.

Las pruebas de cliente cubren respuestas de una generación anterior para montajes,
lecturas, renombrados y escrituras, recuperación sin contaminación entre cuentas,
backoff, sesión antigua, reposo sin timers de sondeo y limpieza de listeners.
Las del broker cubren revocación antes de entrega, ráfagas acotadas y recuperación
del observador. Las reglas de arquitectura impiden infraestructura en los casos
de uso y persistencia en los controladores HTTP de comparticiones.

No cambia el esquema: continúa en versión 2, definida en
`platform/persistence/schema.js` y persistida con checksum en `schema_info`.
No se requiere otra instalación limpia por esta fase. La recepción Android no
cambia; el código de recuperación de fase 4 sigue usando los mismos contratos.

Los smokes de interfaz son sintéticos. La prueba real de servidor/WebSockets no es
una prueba de Obsidian completo: permanecen pendientes los recorridos manuales con
Obsidian 1.14.4, dos editores reales y Android de `acceptance.md`. Las cinco rondas
de referencia no se sustituyen por una ronda de carga de integración.

## Resultado de entrega

- Suite completa: 175 archivos, 2.156 pruebas pasadas y una omitida en el host
  por necesitar el fixture ENOSPC.
- Matriz aislada de fallos: 16 pruebas pasadas con Node 22.23.4, incluida ENOSPC
  real, EACCES y SIGKILL antes/después de publicación.
- Lint, reglas de arquitectura/errores públicos y build: pasan. Las advertencias
  de eval y ListItem siguen siendo las preexistentes.
- Imagen Docker final: construida y comprobada mediante `test:image`; arranque,
  autenticación pública y parada correctos.
- Smokes de gestión de escritorio y móvil: pasan con API sintética y CSS nativo
  1.14.5, sin errores de ejecución ni descarga de páginas de gestión retiradas.
- Carga HTTP: una ronda completa de 1.000/10.000 archivos y 10/100 comparticiones,
  diez muestras por operación.
  Para 1,000 archivos: p95 árbol 129.9 ms, bootstrap 132.3 ms y catálogo 1.5 ms.
  Para 10,000 archivos: p95 árbol 613.3 ms, bootstrap 600.5 ms y catálogo 12.2 ms.
  Esta ronda comprueba integración y coste; no sustituye la referencia estadística
  ni valida el editor real.
