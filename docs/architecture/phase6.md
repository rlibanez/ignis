# Fase 6: componentes de gestión

## Camino vigente

`packages/management/src` contiene los componentes de usuarios, comparticiones,
grants, ubicación, cuenta y confirmaciones. `management-modal.js` sólo compone
el host, el montaje y la liberación de recursos. `management-view.js` construye
el fragmento estático y su presentación mediante tokens/clases nativas; no obtiene
HTML del servidor ni interpreta una página con DOMParser.

`users-component.js`, `shares-component.js` y `account-security-component.js`
reciben una raíz real y puertos explícitos. Sus búsquedas están limitadas a esa
raíz. No registran controladores globales ni suplantan document/window/location.
`management-dialogs.js` construye cierres, semántica, clases nativas y orden de
acciones antes de presentar cada diálogo; no usa MutationObserver para reparar
el formulario después del montaje. Las confirmaciones dinámicas pasan por el
mismo constructor. Los selectores creados al renderizar grants y los botones de
acciones reciben sus clases al crearse.

El host nativo de `packages/bridge/src/settings/management-modal.js` usa Modal de
Obsidian; `packages/ui/src/management.js` aporta BrowserModal para el gestor sin
bóvedas. Ambos montan exactamente los mismos componentes. La entrada individual
oculta el catálogo y libera el host al cerrar la operación. En móvil la hoja
principal usa el Modal real y su inset; no añade un segundo padding al contenido.

## Cliente y ciclo de vida

`client.js` proporciona peticiones same-origin/no-store, timeout de 15 segundos,
cancelación al cerrar y comprobación de contexto antes/después de fetch **y de
leer el cuerpo JSON**, incluidas sus copias. La intención de retorno OIDC se captura antes de que el
shell retire los parámetros de la URL; no se simula location. Los listeners globales y canales
pertenecen al montaje. Al cerrar se aborta, se cierran canales y diálogos y se
borran los campos sensibles. Los formularios nativos de contraseña, email y
desvinculación usan también ese cliente y abortan al cerrar/perder autenticación.

Las operaciones conservan los endpoints API, CSRF, X-Ignis-Context, revisiones y
comprobaciones de reautenticación/permisos del servidor. No se modifica el esquema
2, ni se añaden migraciones o compatibilidad con instalaciones antiguas.

La creación de contraseña local tras OIDC es un componente interno independiente.
Conserva la comprobación de escrituras pendientes, la confirmación del proveedor,
la limpieza de almacenamiento/cachés/IndexedDB, el idioma y el cierre de sesiones.
`/login` conserva acceso y reautenticación; se retiran su gestión de cuenta y sus
formularios de contraseña internos ocultos. Ya no hay una segunda implementación
productiva de esas ventanas en esa página.

## Primitivas compartidas

El árbol, su CSS, los botones de acción, el control mostrar/ocultar contraseña y
el arranque OIDC pertenecen al paquete cliente. Copiar, compartir y ubicación
usan ese árbol. Los helpers de ayuda delegan el tooltip al host y no insertan
contenido visible dentro de la disposición del formulario.

Los cuatro assets clásicos requeridos por setup/login/reset y la recepción
Android se sirven desde un manifiesto fijo en auth/http.js, usando esos mismos
archivos cliente. Sus URLs y protocolo permanecen iguales. Los módulos `.cjs`
exportan la primitiva para el bundler; sólo la ejecución como script externo
instala su adaptador de navegador. No montan gestión dentro de Obsidian.
Docker copia el paquete necesario; el smoke de imagen verifica que arranca sin
fuentes montadas desde el repositorio.

Se eliminan los once imports cliente → servidor permitidos provisionalmente.
El control de arquitectura ya no admite excepciones y rechaza proxies de DOM,
registros globales de controladores y adaptaciones por MutationObserver/DOMParser
en management. Incluye .cjs y ciclos del paquete de gestión en su análisis.

## Evidencia y límites

- Suite completa de Vitest: 177 archivos, 2.162 pruebas pasadas y una omitida
  por no disponer del fixture ENOSPC en el host. Incluye identidad/OIDC, permisos, sesiones, compartidos,
  contenido, editor, recepción Android e idioma.
- Pruebas nuevas de client.js: cancelación, respuesta tardía, JSON tardío/clonado,
  contexto cambiado y listeners que no sobreviven al host.
- Pruebas de session-transition.js: limpieza e idioma, abortar antes de borrar.
- Se sustituyen cuatro pruebas de registro global por la prohibición de esa vía;
  se conserva la prueba de cierre/canales/secretos y se refuerza la arquitectura.
- `check-management-ui.mjs`, escritorio y móvil 390×844: cuenta sin bóvedas,
  email, usuarios, crear/editar, confirmación de sesiones, X de cierre, compartir,
  error de grant sin cambio de rectángulo del diálogo y retorno a contraseña local.
  Comprueba además el retorno de reautenticación tras limpiar la URL y la ayuda
  en la capa del diálogo y dentro del viewport. El harness adicional importa el mismo host/componente para abrir un recurso
  individual: catálogo invisible, título y cierre/liberación del host.
- Lint, build y smoke Docker de arranque/autenticación/cierre.

Los screenshots de la comprobación sintética se inspeccionan visualmente. Usa
CSS local de Obsidian 1.14.5; el objetivo de ejecución sigue siendo 1.14.4. No se
presenta esa emulación como prueba del runtime 1.14.4, del teclado Android ni de
un proveedor OIDC real. Permanecen los recorridos manuales A21–A24 de acceptance.md
con esas plataformas, incluyendo landscape y temas. No se cambia la recepción
Android; sus regresiones automáticas siguen ejecutándose.
