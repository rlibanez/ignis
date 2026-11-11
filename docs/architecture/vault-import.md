# Importación de bóvedas desde el dispositivo

Cuenta ofrece «Importar bóveda» a usuarios normales y administradores. Usa los
mismos componentes de cuenta con Modal nativo o el host sin bóveda, sin páginas
externas. El asistente selecciona carpeta/ZIP, detecta una o varias bóvedas y propone nombres editables,
permite elegir preferencias, revisa cantidades/exclusiones y publica únicamente
al confirmar. Incluye progreso, Atrás, Cancelar y Abrir bóveda al terminar.
El gestor abierto actualiza su catálogo al publicarse la bóveda. Su pie ofrece
Importar bóveda junto a Crear bóveda, reutilizando el mismo asistente de Cuenta.

La publicación usa `VAULT_ROOT/<username>/<nombre>` y reserva el nombre sólo
para la cuenta que importa. Una cuenta puede importar un nombre que ya exista en
otra cuenta; nunca se reutiliza su UUID ni se heredan sus permisos.

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
conservan. Los contenedores generados node_modules y __MACOSX no se eliminan
para que sus archivos sigan excluidos. La entrada explícita de una carpeta
contenedora normal también se descarta;
los directorios vacíos que están dentro se conservan. Un ZIP vacío o que solo
contiene su carpeta contenedora crea una bóveda vacía.
Los nombres de archivo se normalizan a NFC y las colisiones de rutas,
incluidas las que solo difieren en mayúsculas o normalización, se rechazan.

## Detección de varias bóvedas

El servidor valida el origen completo antes de dividirlo: rutas, colisiones,
bytes y nodos implícitos. Los límites de 10000 nodos, 512 MiB por archivo, 4 GiB
en total y 1 GiB de ZIP son conjuntos, aunque se desmarquen bóvedas o archivos.
Se admiten como máximo 32 bóvedas por origen. No se usan rutas del servidor.

- `.obsidian` en la raíz identifica una única bóveda.
- Varias carpetas con `.obsidian` identifican bóvedas independientes; se admiten
  carpetas contenedoras y directorios `.obsidian` vacíos.
- Sin ese marcador se conserva la importación como una única bóveda de notas.
- Una bóveda dentro de otra no se separa: el asistente enumera esas raíces
  anidadas y conserva el contenido dentro de la contenedora.
- Directorios ocultos o generados (`.git`, `node_modules`, `__MACOSX`) no se
  promocionan a bóvedas por contener un marcador.
- Los elementos fuera de las raíces detectadas se enumeran mediante un enlace
  a un modal de solo lectura; no se importan ni se descartan silenciosamente.

Cada bóveda tiene su checkbox de importación, nombre y preferencias. Los nombres
duplicados dentro de la selección y las colisiones existentes se avisan en el
campo correspondiente antes de importar. Las exclusiones se editan en un modal
independiente, identificado con el nombre de la bóveda. Seleccionar todo afecta
solo a ella y los elementos protegidos siguen deshabilitados. Las elecciones
sobreviven a Atrás y a desmarcar/remarcar la bóveda. Desactivar sus preferencias
limpia sus selecciones opcionales, sin afectar a las demás.

El ZIP se sube una sola vez al analizar el origen y se conserva privado con
SHA-256. La carpeta local envía primero su manifiesto, conservando los File
originales en el navegador. La revisión no publica ninguna bóveda; las opciones
se validan en el servidor antes de preparar cada hija. Las preferencias ZIP se
validan también antes de aceptar su selección.

La importación final es secuencial y cada publicación es independiente y completa.
Una bóveda fallida no revierte las terminadas. Los borradores fallidos se cancelan
para permitir continuar las demás; reintentar puede volver a subir esos archivos.
Preparar otra raíz u otras opciones sustituye únicamente un borrador inactivo
no publicado; permite volver y cambiar la selección incluso si se perdió su
respuesta de preparación. Un borrador ocupado o publicándose no se sustituye.
Los resultados por raíz y los recibos de commit impiden duplicar una publicación
cuya respuesta se perdió, y vuelven a comprobar sesión y propiedad. El asistente
omite las terminadas al reintentar y ofrece Abrir para cada resultado.

El origen y sus hijas tienen un tope absoluto de cuatro horas y caducan tras
30 minutos sin actividad autorizada. Los bloques procesados y las operaciones
válidas renuevan solo el plazo de inactividad, nunca el tope absoluto. Cancelar el
asistente elimina el origen y los borradores pendientes, conservando las bóvedas
ya publicadas. No se promete deshacer una publicación que ya haya comenzado.


Los ajustes de Obsidian y los complementos comunitarios se eligen por separado
para cada bóveda. Una cuenta administradora puede restaurar los ajustes de la
bóveda, incluidos temas, snippets, espacios de trabajo y archivos ocultos de
contenido. Para las cuentas normales se aplican los permisos de preferencias
existentes.

«No restaurar» excluye los complementos comunitarios. «Restaurar sin su
configuración» recupera los archivos estándar de instalación y deja los
complementos deshabilitados. «Restaurar con su configuración» recupera sus
archivos y datos junto con community-plugins.json, que conserva su estado de
activación. Ambos modos de restauración de complementos requieren permisos de
administrador. Los controles de ejecución de la instalación siguen aplicando.
Las rutas reservadas y los archivos temporales se excluyen como en la exportación.

La selección de modo es independiente por bóveda y forma parte de la clave de
reintento del servidor. Los ajustes de aplicación y del estado de activación
se validan como JSON con tamaño y profundidad acotados. Los archivos de plugins,
temas y datos adicionales se copian con streaming y los límites generales por
archivo, sin interpretarlos como preferencias JSON. La exportación permite conservar los ajustes y los complementos por separado.
Los archivos originales del dispositivo se conservan.

## Límites y protocolo

- 10000 nodos de archivos y directorios, incluidos padres implícitos, 512 MiB por archivo, 4 GiB sumados.
- ZIP subido: 1 GiB; los límites anteriores también se aplican al contenido declarado.
- Manifiesto JSON: 4 MiB. Preferencia JSON individual: 1 MiB.
- Cuatro actores con importaciones/lecturas de cuerpo simultáneas y una importación
  por actor. Las reservas de memoria se toman antes del parser de cuerpo.
- Borradores ligados a usuario y sesión: máximo de cuatro horas y 30 minutos
  de inactividad.
  La limpieza ocurre al atender importaciones y al iniciar el servidor, sin un
  sondeo periódico. No hay reanudación tras reiniciar.
- Peticiones de carga con timeout cliente de una hora. El servidor conserva
  los cinco minutos ordinarios y 60 segundos para cabeceras; solo una importación
  autenticada con capacidad reservada amplía el plazo del cuerpo a una hora,
  con dos minutos máximos sin tráfico. Al terminar una respuesta temprana se
  revoca esa ampliación sin alterar la respuesta HTTP. Los límites del proxy
  inverso también deben permitir el tamaño y la duración necesarios. Se reutiliza CSRF
  durante cinco minutos para no emitir un token por archivo; el servidor sigue
  validando el token y el contexto en cada petición.

El asistente utiliza `POST /api/vault/import/{scan,scan-zip,review,prepare,cancel-source}`
para analizar, revisar y cancelar el origen; `file`, `commit` y `cancel` actúan
sobre una hija preparada. Las rutas `start`, `zip` y `select` conservan su contrato
de borrador individual. Todas son POST autenticadas, con
Origin/Host, CSRF y contexto. El manifiesto de rutas los clasifica expresamente.
`start` fija nombre, selección de preferencias y tamaños/rutas/tipos; `file` recibe un
índice y bytes de tamaño exacto solo para entradas de archivo. Las entradas de
directorio tienen tamaño cero, no aceptan bytes y se crean durante la publicación.
Las declaraciones de directorios duplicadas o en conflicto con un archivo se
rechazan antes de escribir. Los bloques reconocidos son inmutables: un
reintento idéntico devuelve la confirmación sin reescribirlos; otros bytes se
rechazan. La publicación comprueba también el SHA-256 de cada bloque. `zip` valida la estructura central/local,
CRC, tipos de entrada, rangos, tamaños y expansión limitada. La estructura se
valida antes de preparar la revisión; el CRC y tamaño de cada archivo importado
se comprueban mientras se descomprime, antes de darlo por recibido. Inflado y
escritura son asíncronos y por bloques acotados. No se reutilizan permisos, propietarios, UUID ni comparticiones del origen.

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
y sesión, durante un máximo de cuatro horas. Repetir commit devuelve la identidad
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

The wizard applies choices through `POST /api/vault/import/review`, bound to the
source, detected root and current session; it does not reupload the source or
prepare a child until final confirmation. The single-draft `select` contract
continues to update an existing draft when used directly. ZIP bytes are retained privately in the staging
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
a failed result. Back returns to the name step and cancels any pending child
draft before preparing again. Completed vaults remain immutable in the wizard.

## Pruebas de importación múltiple

`features/vaults/application/import-source.test.mjs` verifica detección, bóvedas
anidadas, raíces ocultas, límite conjunto y máximo de bóvedas.
`auth/vault-import.test.mjs` comprueba publicación independiente de varias bóvedas,
exclusiones por raíz, índices del manifiesto local, bóvedas vacías, respuestas
perdidas, cancelación parcial, caducidad, revocación, propiedad y ZIP alterado.
`auth/http.test.mjs` prueba las nuevas rutas con autenticación, CSRF, contexto
y rechazo de orígenes ajenos, también para administradores.

`test:vault-transfers` añade escenarios de lote a los recorridos anteriores: tres
bóvedas en carpeta/ZIP, desmarcar una, nombres independientes, selección y limpieza
de preferencias por bóveda, Atrás, fallo parcial simulado y reintento sin duplicar.
Comprueba bytes y preferencias descargando los ZIP reales, con y sin bóveda
abierta, en escritorio y viewport móvil. Los fallos de red inyectados son
sintéticos; la API, las subidas, las publicaciones y las descargas son reales.

## Importaciones grandes y memoria acotada

Los endpoints binarios reciben el cuerpo directamente en temporales privados,
con conteo de bytes, SHA-256, backpressure y permisos exclusivos. No usan
`express.raw` ni convierten el ZIP o el archivo completo en un Buffer. Los cuerpos
gzip/deflate tienen además un límite de bytes en el transporte y siguen sujetos
al límite descomprimido; un tamaño declarado excesivo se rechaza antes de leerlo.

El lector ZIP utiliza el mismo parser de metadatos que los fixtures en memoria,
pero lee del descriptor únicamente la cola EOCD y los encabezados necesarios.
Las entradas Stored/Deflate se descomprimen con streams y CRC/tamaño incremental.
El descriptor está fijado con O_NOFOLLOW, identidad, tamaño, tiempos e integridad
SHA-256. Un cambio durante la lectura no se publica. Se mantienen el formato ZIP
estándar UTF-8, el rechazo de cifrado/ZIP64/enlaces y los límites de rutas/nodos.

La copia final también lee, calcula el hash y escribe por bloques, conservando
las barreras de autorización, exclusividad, fsync y activación transaccional.
Solo las preferencias JSON, limitadas a 1 MiB, se reúnen para validarlas.

Se comprueba espacio antes de preparar y durante las escrituras, con un margen
de 128 MiB por filesystem. Si los temporales y la bóveda están en el mismo
filesystem se considera el espacio de ambas copias. No se reserva físicamente
todo el espacio por adelantado: la comprobación progresiva limita el efecto de
importaciones concurrentes. Un fallo devuelve un aviso de espacio insuficiente,
limpia la subida pendiente y conserva una publicación incierta en cuarentena.
Con 4 GiB descomprimidos puede necesitarse temporalmente aproximadamente el
doble, además del ZIP; debe dimensionarse el almacenamiento del despliegue.

Estos límites ampliados corresponden a importación. La exportación conserva
los límites documentados en vault-export.md y su descarga mediante Blob.

`npm run test:large-imports` ejecuta un proceso desechable con heap de 64 MiB y
rechaza buffers/concatenaciones de más de 1 MiB. Sube por HTTP un ZIP real de
casi 1 GiB con un archivo de 512 MiB, sube una carpeta con otro archivo de
512 MiB y expande una entrada Deflate de 512 MiB. Comprueba hashes, limpieza y
un pico RSS inferior a 256 MiB. No usa datos reales ni assets de Obsidian.
La prueba requiere 5 GiB libres en el directorio temporal y está en CI;
es funcional y de memoria, no una comparación temporal
entre máquinas. Las suites de streams y plazos cubren corrupción, truncamiento,
revocación, falta de espacio y conservación del plazo ordinario para otras rutas.
