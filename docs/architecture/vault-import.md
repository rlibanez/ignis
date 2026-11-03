# Importación de bóvedas desde el dispositivo

Cuenta ofrece «Importar bóveda» a usuarios normales y administradores. Usa los
mismos componentes de cuenta con Modal nativo o el host sin bóveda, sin páginas
externas. El asistente selecciona carpeta/ZIP, propone un nombre editable,
permite elegir preferencias, revisa cantidades/exclusiones y publica únicamente
al confirmar. Incluye progreso, Atrás, Cancelar y Abrir bóveda al terminar.
El gestor abierto actualiza su catálogo al publicarse la bóveda. Su pie ofrece
Importar bóveda junto a Crear bóveda, reutilizando el mismo asistente de Cuenta.

## Alcance del contenido

La carpeta se selecciona mediante showDirectoryPicker y se enumeran sus handles,
incluidos directorios vacíos. El servidor nunca acepta un directorio de origen
propio. La opción de carpeta permanece habilitada cuando no existe ese selector:
se ofrece arrastrar una carpeta desde el gestor de archivos usando las entradas
File and Directory Entries API (o handles modernos de arrastre). Los lectores se
agotan hasta recibir una tanda vacía; una tanda de 100 entradas no es el final.
También se permite el selector tradicional webkitdirectory. Un aviso visible
explica que FileList no describe directorios vacíos; se reconstruyen los padres
de los archivos recibidos, y el arrastre o ZIP son las alternativas para incluir
los vacíos. Este compromiso fue elegido expresamente por el usuario. Una selección
sin archivos no inventa una carpeta raíz: indica usar arrastre o ZIP.
Siguiente está deshabilitado hasta seleccionar un origen, también después de
cambiar entre carpeta y ZIP. El nombre seleccionado se destaca con un resumen
de archivos y carpetas; se puede importar incluso una carpeta raíz vacía.

El área de ZIP permite pulsar, usar Enter/Espacio o arrastrar un único archivo;
se rechazan carpetas, varios archivos y formatos ajenos a ZIP.

Se aceptan ZIP estándar almacenados o Deflate, sin cifrado ni ZIP64, con nombres
UTF-8. Una única carpeta contenedora se elimina del prefijo; los demás niveles se
conservan. La entrada explícita de esa carpeta contenedora también se descarta;
los directorios vacíos que están dentro se conservan. Un ZIP vacío o que solo
contiene su carpeta contenedora crea una bóveda vacía.
Los nombres de archivo se normalizan a NFC y las colisiones de rutas,
incluidas las que solo difieren en mayúsculas o normalización, se rechazan.

Los únicos ajustes opcionales de `.obsidian` son app.json, hotkeys.json y
graph.json: el contrato de preferencias personales ya revisado. Se exige JSON
válido de objeto, tamaño acotado, profundidad limitada y sin claves de prototipo.
El resto de configuración, espacios de trabajo, plugins, temas, node_modules,
__MACOSX y estado oculto no se instalan. community-plugins.json se genera como
lista vacía. No se importa ni ejecuta código de plugins, incluso siendo admin.
Los archivos originales del dispositivo no se modifican.
La lista permitida es una decisión conservadora de Ignis, no una exigencia del
formato de Obsidian. El visor explica individualmente appearance.json (referencias
a temas/snippets no importados), community-plugins.json (se genera deshabilitado),
core-plugins.json (se mantienen los valores predeterminados) y workspace.json
(se recrea la distribución de paneles y pestañas).

## Límites y protocolo

- 10000 nodos de archivos y directorios, incluidos padres implícitos, 32 MiB por archivo, 256 MiB sumados.
- ZIP subido: 64 MiB; los límites anteriores también se aplican al contenido declarado.
- Manifiesto JSON: 4 MiB. Preferencia JSON individual: 1 MiB.
- Cuatro actores con importaciones/lecturas de cuerpo simultáneas y una importación
  por actor. Las reservas de memoria se toman antes del parser de cuerpo.
- Borradores ligados a usuario y sesión, con vencimiento fijo de diez minutos.
  La limpieza ocurre al atender importaciones y al iniciar el servidor, sin un
  sondeo periódico. No hay reanudación tras reiniciar.
- Peticiones de carga con timeout cliente de cinco minutos. Se reutiliza CSRF
  durante cinco minutos para no emitir un token por archivo; el servidor sigue
  validando el token y el contexto en cada petición.

`/api/vault/import/{start,zip,file,commit,cancel}` son POST autenticados, con
Origin/Host, CSRF y contexto. El manifiesto de rutas los clasifica expresamente.
`start` fija nombre, selección de preferencias y tamaños/rutas/tipos; `file` recibe un
índice y bytes de tamaño exacto solo para entradas de archivo. Las entradas de
directorio tienen tamaño cero, no aceptan bytes y se crean durante la publicación.
Las declaraciones de directorios duplicadas o en conflicto con un archivo se
rechazan antes de escribir. Los bloques reconocidos son inmutables: un
reintento idéntico devuelve la confirmación sin reescribirlos; otros bytes se
rechazan. La publicación comprueba también el SHA-256 de cada bloque. `zip` valida la estructura central/local,
CRC, tipos de entrada, rangos, tamaños y expansión limitada antes de preparar la
revisión. Inflado y escritura son asíncronos; el CRC cede periódicamente el event
loop. No se reutilizan permisos, propietarios, UUID ni comparticiones del origen.

El adaptador HTTP espera tanto el parser del cuerpo como la operación completa.
El registro común de trabajo pendiente los incluye durante el apagado, incluso
si se cierra la conexión antes de que termine una escritura.

Los archivos se preparan en DATA_ROOT/vault-imports, con nombres de staging
aleatorios y permisos privados. El identificador de intento permite cancelar
incluso si el cliente perdió la respuesta que contenía el identificador del
borrador: nunca sustituye la comprobación de actor/sesión. Un cliente no puede
consultar ni cancelar borradores ajenos, tampoco por ser administrador.
La respuesta de preparación incluye las rutas, tipos y motivos de las exclusiones,
además del contador. El enlace Excluidos abre un modal independiente, sin buscador,
con paginación de 100 elementos; no inserta el listado ni redimensiona el asistente.
El listado se cierra al cerrar el asistente o perder la sesión.
Los reintentos de preparación limpian primero el intento cuya respuesta se perdió.
La confirmación final conserva hasta 256 recibos recientes, ligados al mismo actor
y sesión, durante un máximo de diez minutos. Repetir commit devuelve la identidad
ya publicada, revalidando su propiedad, sin crear otra bóveda ni retener archivos.
Los recibos son efímeros; tras un reinicio se consulta el catálogo de bóvedas.

## Publicación y fallos

Una reserva durable en las tablas existentes de bóvedas/membresías mantiene el
estado pending oculto. Se crea un directorio nuevo sin sobrescribir, se copian
solo archivos aprobados con exclusividad y sin seguir enlaces en las hojas, se
sincronizan archivos/directorios y se repite la autorización dentro de la
transacción antes de activar la identidad nueva. El propietario siempre es el
actor autenticado. No cambia el esquema ni introduce migraciones.

Cancelar durante la preparación aborta la petición y descarta el borrador privado.
Si una escritura estaba en curso, se marca cancelada y se elimina al terminar esa
escritura; no puede publicarse ni bloquear el siguiente intento hasta la caducidad.
Durante la publicación final se bloquea el cierre voluntario para no presentar una
cancelación falsa después de confirmar datos. Perder autorización sí aborta el
cliente y las barreras del servidor impiden activar la publicación pendiente.

Un resultado de disco incierto conserva el directorio como quarantine, invisible
para el uso normal. No se elimina recursivamente una salida potencialmente
modificada por otra operación. Véase operations.md para investigación operativa.
No se necesita ni se incorpora recuperación de directorios preexistentes del
servidor; ese flujo administrativo tiene un contrato diferente.

## Verificación

- `packages/management/src/folder-source.test.mjs`: lectura de todas las tandas,
  directorios anidados/vacíos, captura síncrona de datos de arrastre, cancelación y
  rechazo de archivos sueltos o carpetas ilegibles sin fallback que pierda datos.

- `auth/vault-import.test.mjs`: rutas peligrosas y colisiones, ZIP real con enlaces,
  cifrado, longitudes falsas y CRC incorrecto, preferencias peligrosas, límites,
  colisiones de carpetas implícitas, reintentos, propietario, aislamiento, vencimiento, cancelación y revocación durante publicación.
- `auth/http.test.mjs`: petición autenticada/CSRF, usuario sin membresías previas,
  borrador ajeno rechazado, subida real y publicación; variantes con barra final,
  cancelación concurrente y espera del trabajo pendiente durante el apagado.
- `npm run test:vault-transfers`: Obsidian 1.14.4 real con assets privados. Carpeta en
  el host nativo y ZIP desde una cuenta normal sin bóvedas, revisión, subidas reales,
  apertura del resultado, comprobación de bytes, actualización del gestor y
  recuperación tras respuestas perdidas en preparación, subida y confirmación.
  Comprueba directorios vacíos tras publicar, descargar y abrir en Obsidian,
  Siguiente deshabilitado sin origen y selección destacada. El selector del sistema
  se sustituye por handles de prueba; el arrastre alternativo usa un directorio
  real con más de 100 archivos mediante CDP. La API HTTP y la publicación son
  reales. Comprueba también el modal independiente de exclusiones y el botón del
  gestor en escritorio y móvil. Repite
  escritorio/móvil; no simula el selector del sistema operativo Android.
- La suite, lint y build siguen siendo necesarios. El job CI de runtime privado
  incluye este recorrido; no se distribuyen assets de Obsidian en el repositorio.

### Choosing excluded preferences

The separate excluded-items dialog offers checkboxes and an explicit Apply action.
Only reviewed inert JSON preferences can be recovered: app, hotkeys, graph and
workspace layouts. Appearance and core-plugin configuration additionally require
an authenticated administrator, matching the normal vault configuration policy.
Executable plugins, community-plugin activation, themes, hidden metadata and
unknown configuration remain disabled even if a client forges its selection.
The server validates every selected path against the original manifest and checks
JSON size, depth and unsafe keys; core-plugin state accepts both Obsidian formats: an enabled-identifier list or an identifier-to-boolean map.

Applying choices updates the existing session-bound draft through
`POST /api/vault/import/select?id=...`; it does not consume another creation
attempt or reupload the source. ZIP bytes are retained privately in the staging
directory with a SHA-256 digest, checked through a non-following file handle
before reading additional selected files. They share the draft's fixed expiry
and cleanup. Folder files are uploaded on final confirmation. Changes are atomic:
a failed selection keeps the original plan; unselected cached files are never
published. The link remains accessible when its count is zero so selected items
can be excluded again. Selection requests retain CSRF, session, ownership,
concurrency, size and rate limits and never extend the staging lifetime.

Vault name availability is checked when preparing the draft (the name step),
including on-disk directories and durable database reservations. A conflict is
shown through the name input's native validation bubble without adding content
to the form. Editing the name clears that validation error. Publication checks
availability again inside its reservation transaction; a late conflict returns
the wizard to the name field, and preparing again discards the old draft.
