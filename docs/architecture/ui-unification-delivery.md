# Interfaces comunes: implementación y verificación

Entrega sobre `develop`, 2026-11-08. Se limita a las ventanas propias descritas en
el [inventario](ui-unification.md). El Gestor de bóvedas y las primitivas Svelte originales conservan su código previo.

## Elección de componentes

Los menús del gestor mantienen su implementación original. La capa de nuestras
ventanas respeta el nivel del gestor existente sin cambiar su geometría ni CSS.
Los avisos propios que coinciden con el gestor se trasladan a un contenedor
exclusivo mediante `ui-notice.js`; no hay una regla global sobre los avisos nativos.

El bridge publica un adaptador con las clases exportadas por Obsidian en
`ui-runtime.js`. Se instala antes de las entradas de gestión y se retira al
descargar el bridge. La disponibilidad del runtime, no el número de bóvedas,
determina el host:

| Contexto | Contenedor y primitivas |
|---|---|
| Editor inicializado (O) | `Modal`, `TextComponent`, `TextAreaComponent`, `DropdownComponent`, `ButtonComponent` y `Notice` reales |
| Gestor sin editor (Z) | `BrowserModal`, controles HTML y CSS instalado de Obsidian; mismos controladores |
| Páginas independientes (E) | HTML accesible y CSS instalado de Obsidian; sin iniciar una aplicación o bóveda ficticia |

`ui-controls.js` crea los controles, conserva las instancias nativas y normaliza
los atributos. Los selectores reciben opciones como datos para conservar las
actualizaciones de Svelte tras montar el campo. Si existe runtime pero falta una
clase necesaria, no se sustituye silenciosamente por HTML.

`dialog-host.js` contiene el ciclo de vida de formularios y confirmaciones de
gestión. Las plantillas contienen secciones inertes; ya no se abre un `<dialog>`
en la capa superior del navegador dentro de un `Modal` de Obsidian. El host mueve
solo cada formulario, conservando el catálogo padre, las referencias y los listeners
de su controlador. Gestiona hijos,
restauración, cancelación protegida durante peticiones y disposición. Una
confirmación individual mantiene vivo al propietario hasta terminar la acción.
La pérdida de sesión fuerza el cierre y limpia secretos incluso si la cancelación
normal estaba protegida. No se modifican prototipos DOM globales.

`NativeModal.svelte` y `NativeButton.svelte`, aislados en `components/management`,
se usan únicamente en nuestra gestión de acceso. No sustituyen a `Modal.svelte`,
`Button.svelte`, `PopoverMenu.svelte` ni otros componentes originales.

`ui-layout.js` establece categorías compartidas de formulario y lista, orden de
acciones, anchuras y disposición móvil. En móvil los modales comienzan arriba,
dentro del área segura; la acción principal precede a Cancelar y ocupa el ancho
disponible. Las páginas independientes inicializan su entorno mediante
`ui-environment.cjs`. El shim y el shell conservan su detección previa de móvil;
no se modifica la política de las vistas originales.

## Cobertura y excepciones

| Superficies propias | Implementación |
|---|---|
| Acceso y recepción independientes | `/setup`, `/login`, `/reset-password`, `/share-target` y sus auxiliares consumen CSS nativo instalado y disposición común |
| Cuenta y usuarios | Campos y acciones nativos en el editor, mismos controladores sin editor; host propio para formularios y confirmaciones |
| Compartición y recuperación | Catálogo, gestión individual, ubicación, Copiar y avisos accionables con primitivas comunes; árboles y tablas propios |
| Acceso y transferencias de bóvedas | Ventanas propias de acceso, propiedad, importación, exclusiones y exportación, también desde el gestor original |

El gestor, crear/renombrar/eliminar, Headless Sync, avisos heredados y editores de
ajustes originales conservan su código previo. Sus primitivas Svelte compartidas
no se sustituyen. Ajustes `Setting`/`Modal` y `FuzzySuggestModal` existentes tampoco
se reescriben.

Excepciones deliberadas:

- Los campos de archivo, ocultos y checkboxes conservan sus primitivas HTML.
  `ToggleComponent` no preservaría el rol y comportamiento de un checkbox.
- Árboles, tablas, listas de exclusiones, asistente y recuperación aportan lógica
  de producto; Obsidian no ofrece un equivalente público adecuado. Sus botones y
  campos sí se crean con el adaptador.
- El ojo integrado y las ayudas componen primitivas; no son componentes completos
  exportados por Obsidian. Se conserva el renderer de tooltip del runtime en O y
  la ayuda accesible del host en Z/E.
- Las integraciones preexistentes de `SettingTab` y ajustes internos siguen
  dependiendo del runtime soportado 1.14.4. No se añaden clases minificadas ni se
  afirma compatibilidad automática con cualquier versión futura.
- Las páginas anteriores al editor usan CSS base y tema del sistema; no acceden
  al tema ni a snippets privados de una bóveda. En O se hereda el tema activo.

Se retiran los CSS públicos antiguos `setup.css`, `account.css` y `components.css`
de `auth/web`, incluidos sus endpoints sin consumidores. El CSS de formularios de
`packages/management` es distinto y sigue siendo necesario. No se recuperan
páginas independientes `/account`, `/users` o `/shares`.

## Invariantes y pruebas

No se cambian API de negocio, autorización, reautenticación, límites de
importación, reglas de propiedad ni protocolos Android. La ruta pública adicional
de CSS sirve únicamente el stylesheet instalado, mediante una ruta fija; la CSP
permite sus fuentes embebidas sin habilitar scripts o estilos inline.

Los contratos unitarios prueban creación nativa, fallback explícito, listas
reactivas, ciclo de vida de hijos, guardas de cancelación, reapertura y respuestas
tardías. Sustituyen la antigua prueba de offsets simulados por pruebas del host
y mediciones en navegador real.

Comandos de aceptación (Node 22.23.4 y 24.22.1 para la suite unitaria):

```sh
npm run lint
npm test
npm run build
npm run test:management
IGNIS_E2E_OBSIDIAN_ASSETS=/ruta/privada npm run test:management-parity
IGNIS_E2E_OBSIDIAN_ASSETS=/ruta/privada npm run test:vault-transfers
IGNIS_E2E_OBSIDIAN_ASSETS=/ruta/privada npm run test:entry-ui
```

La matriz de paridad ejecuta 54 estados en cada uno de cinco tamaños
(780×437, 2560×1440, 390×844, 360×800 y 844×390), con Obsidian real y sin
editor. Comprueba geometría, tipografía, errores sin reflow, ayudas, foco,
cancelación, sesión perdida y constructores nativos. Incluye una comprobación
absoluta de posición superior móvil; la mera igualdad entre hosts no basta.
El recorrido real también comprueba aislamiento de cuentas, edición compartida,
restauración/revocación de permisos y confirmación individual enviada al servidor.
El menú contextual real de «Copiar a…» se abre en escritorio y móvil para
comprobar constructores nativos, anchura, posición superior y acción antes de Cancelar.

Las transferencias comprueban selección de carpeta y ZIP, importación múltiple,
preferencias por bóveda, reintentos con respuestas perdidas, colisiones, descarga
de bytes reales y transferencia de propiedad. Las cuatro páginas independientes
se verifican en claro/oscuro y cuatro tamaños: 32 combinaciones.

`ui-isolation.mjs` compara estilos calculados, dimensiones y posición con las
hojas propias activadas/desactivadas sobre el mismo DOM. Cubre el gestor,
Prompt/Confirm/Message, editores heredados, modales y controles reales de Obsidian
y su contenedor de avisos. También verifica la capa exclusiva y limpieza de los
avisos propios, sin mover ni cambiar los avisos originales.

La aceptación verifica igualdad byte por byte con HEAD de los 19 archivos
originales preservados del gestor, controles, menús y editores heredados. La suite
pública de CI conserva las pruebas sintéticas; el workflow optativo del runner
privado añade las páginas independientes y los estados terminales sin distribuir
assets de Obsidian.

Límites: móvil es emulación táctil de Chrome, no un dispositivo Android físico.
Queda recomendable una prueba manual de teclado, selector de archivos y recepción
desde Android. No se utiliza una cuenta externa real de Headless Sync ni se
certifican temas de terceros; estos conservan sus propias reglas CSS.

## Revisión adicional de estados terminales y avisos propios

La revisión inicial omitió el renderer de `auth/web/client.js`. Se adapta ahora
«Sesión bloqueada», «Bóveda no disponible» y el fallo de inicio que usa ese mismo
renderer. Consumen `entry.css`, mantienen el tema activo y solo cargan el CSS base
si todavía no existe. Tras bloquear no se depende del runtime del editor: primero
se preservan los borradores, se bloquean/abortan peticiones y se retira su DOM;
la vista independiente sigue permitiendo descargar la recuperación.

La búsqueda de otros renderers propios identificó y adaptó además:

- Panel persistente de recuperación/solo lectura: mantiene estado, acciones y
  tokens de recuperación; sus botones nativos conservan su apariencia y el panel
  usa variables del tema mediante CSS exclusivo de `ignis-recovery-*`.
- Dos `alert()` propios al cerrar sesión: utilizan nuestro host de avisos nativo
  o independiente, con fallback HTML accesible antes de cargar cualquiera de ellos.
- `confirm()` propio de borrado permanente dentro de un recurso recibido: usa la
  confirmación nativa común. La sesión se comprueba antes y después de esperar
  la respuesta; servidor, revisión y permisos siguen siendo obligatorios. Sin
  host de confirmación no se borra nada.

No se modifica el splash de carga ni los avisos heredados del upstream. El prompt
PWA de instalación pertenece al navegador y se conserva.

`test:terminal-ui` añade 48 estados terminales y 16 de recuperación (ambos temas,
escritorio y tres tamaños móviles), avisos de logout, validación de descargas y
peticiones bloqueadas. El recorrido real de Obsidian prueba cancelar/confirmar el
borrado, comprobar los bytes originales y bloquear preservando el tema. El test de
islamiento carga también `entry.css` y compara `html`/`body` y las vistas originales.
Se mantienen los límites de emulación móvil ya indicados.

Los formularios y confirmaciones propios usan ahora un máximo de 400 px en escritorio, incluidas las páginas de acceso, restablecimiento y estados terminales. Los catálogos Gestionar usuarios y Recursos compartidos conservan el ancho de Ajustes; share-target mantiene su vista principal de 704 px. En móvil se conserva el ancho nativo disponible.

Los formularios de gestión se portalan individualmente: el catálogo permanece montado y visible detrás del modal hijo, sin duplicar tablas ni formularios. El ámbito del controlador consulta también los formularios portados y conserva los eventos de cierre. La apertura directa de un recurso sigue sin mostrar un catálogo intermedio.

La recepción de texto/enlaces muestra un bloque delimitado con campos editables de contenido y título cuando existe. No reserva espacio para el título ausente ni el estado vacío. El guardado usa los valores editados, conserva las precondiciones de escritura y mantiene las ediciones tras fallar; el título actualiza el nombre sugerido de notas nuevas.

Las páginas independientes dejan el scroll vertical en el documento; body permanece de altura natural y overflow visible. La prueba de recepción ejecuta secuencias touchStart/touchMove/touchEnd en tres tamaños móviles y comprueba que el último botón queda accesible, además del control de anchura y desbordamiento horizontal. No equivale a una prueba física en Android instalado.

En móvil, la cabecera de las páginas independientes utiliza un único margen superior de 16 px, ampliado si la zona segura del dispositivo lo exige. Se elimina la suma de padding de body y main; el escritorio y la interfaz original del editor permanecen intactos. La prueba de páginas comprueba la posición de la marca en las cuatro rutas y mantiene la comprobación de scroll táctil.

La revisión final añade regresiones para mantener el nombre sugerido editado al reintentar un guardado fallido y liberar las confirmaciones temporales eliminadas de su ámbito de componentes.

## Resultado de aceptación final

- Lint, límites de arquitectura, comprobación de errores y build aprobados.
- Node 22.23.4 y 24.22.1: 213 archivos, 2664 pruebas aprobadas y una omitida.
- 270 estados de paridad con/sin editor en cinco tamaños, sin diferencias.
- 32 combinaciones de páginas independientes; desplazamiento táctil hasta la última acción.
- 64 estados terminales/recuperación, y recorrido de borrado compartido y bloqueo con Obsidian real en escritorio y móvil.
- Gestión, importación, exportación y transferencia de propiedad verificadas con respuestas perdidas, permisos y contextos de sesión.
- 19 archivos originales preservados, idénticos a HEAD; aislamiento de estilos aprobado.
- Limpieza explícita de los secretos de formularios portados al disponer su propietario.

La validación móvil utiliza Chrome con emulación táctil. No se certifica una instalación física de PWA Android ni un proveedor OIDC externo real.
