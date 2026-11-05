# Contrato de aceptación

Las rutas de pruebas siguientes son relativas al repositorio. Demuestran cobertura
existente; no equivalen a certificar todos los casos con Obsidian real. La suite
completa debe seguir pasando mientras las implementaciones se sustituyen.

| ID | Escenario e invariante | Evidencia automatizada existente | Fase de cierre |
| --- | --- | --- | --- |
| A01 | Setup una vez; último administrador protegido | `auth/initial-admin.test.mjs`, `auth/users.test.mjs` | 2 |
| A02 | Login local, caducidad, sesión recordada y revocación | `auth/sessions.test.mjs`, `auth/session-cookies.test.mjs`, `auth/logout-web.test.mjs` | 2 |
| A03 | OIDC valida issuer, subject, transporte, transacción y replay | `auth/oidc/*.test.mjs` | 2 |
| A04 | Vincular/desvincular no permite apropiación ni perder el acceso | `auth/oidc/accounts.test.mjs`, `auth/oidc/http.integration.test.mjs` | 2 |
| A05 | Reauth reciente; email cambia a no verificado; solo admin verifica | `auth/http.test.mjs`, `auth/users.test.mjs` | 2 |
| A06 | Contraseña local, temporal y cambio obligatorio revocan autoridad anterior | `auth/change-password.test.mjs`, `auth/password-reset.test.mjs` | 2 |
| A07 | Host/Origin/CSRF/proxy y límites se aplican; nuevas rutas cerradas | `auth/http.test.mjs`, `auth/proxy-trust.test.mjs`, `auth/route-manifest.test.mjs`, `auth/request-limits.test.mjs` | 2–3 |
| A08 | No confundir admin, propietario, editor y lector | `auth/vault-policy.test.mjs`, `auth/vault-access.test.mjs`, `auth/multiuser.integration.test.mjs` | 3 |
| A09 | Crear/importar/renombrar/eliminar conserva ID y propiedad | `auth/vault-creation.test.mjs`, `auth/vault-storage.test.mjs`, `auth/vault-rename.test.mjs`, `auth/vault-deletion.test.mjs` | 3 |
| A10 | Un fallo de lifecycle deja reserva/cuarentena, sin acceso accidental | `auth/vault-rename.test.mjs`, `auth/vault-deletion.test.mjs`, `auth/user-deletion.test.mjs` | 3–4 |
| A11 | Árbol/bootstrap/adjuntos no revelan datos ajenos | `auth/vault-view.test.mjs`, `routes/bootstrap.private.test.mjs`, `auth/server.integration.test.mjs` | 3 |
| A12 | Rutas, enlaces, sustituciones y operaciones recursivas seguras | `auth/resource-shares.test.mjs`, `vault/resource-policy.test.mjs`, `routes/fs.routes.test.mjs` | 3–5 |
| A13 | Originales y montados no pisan una versión más nueva | `auth/resource-shares.test.mjs`, `packages/shim/src/editor-saves.test.js`, `packages/shim/src/fs/content-versions.integration.test.js` | 4 |
| A14 | Respuesta perdida no provoca replay incondicional; borrador preservado | `packages/shim/src/editor-saves.test.js`, `packages/shim/src/fs/write-durability.test.js` | 4 |
| A15 | EACCES/ENOSPC y publicación incompleta no dañan originales | `auth/resource-shares-recovery.test.mjs` | 4 |
| A16 | Compartir archivo/carpeta con usuario real y permiso válido | `auth/resource-shares.test.mjs`, `packages/shim/src/share-dialog.test.js` | 5 |
| A17 | Ubicación/nombre local y opción sin bóveda no crean copia independiente | `auth/resource-shares.test.mjs`, `packages/shim/src/fs/shared-files.test.js` | 5 |
| A18 | Write→read con nota limpia no crea falsa recuperación; read→write desbloquea | `packages/shim/src/fs/shared-notice.test.js`, `packages/shim/src/editor-saves.test.js`, `packages/shim/src/fs/shared-files.test.js` | 5 |
| A19 | Eventos filtrados por usuario; reconexión recupera estado; CLI notifica | `auth/state-events.test.mjs`, `auth/events-web.test.mjs`, `auth/vault-events.test.mjs`, `auth/server.integration.test.mjs` | 5 |
| A20 | Cambio de cuenta/bóveda no reutiliza caché, respuestas o borradores antiguos | `auth/client.test.mjs`, `packages/shim/src/account-storage.test.js`, `packages/shim/src/editor-saves.test.js` | 2–5 |
| A21 | Cuenta, usuarios y compartir funcionan sin bóveda ni páginas externas | `scripts/check-management-ui.mjs`, `packages/management/src/intent.test.js` | 6 |
| A22 | Todas las entradas usan los mismos formularios, árbol y errores estables | `packages/bridge/src/settings/management-modal.test.js`, `packages/shim/src/copy-dialog.test.js`, `auth/share-target-ui.test.mjs` | 6 |
| A23 | Foco/teclado y orden móvil; ventanas seguras dentro del viewport | `scripts/check-management-ui.mjs --mobile`, `packages/bridge/src/rename-keyboard.test.js` | 6 |
| A24 | Setup/login/Obsidian conservan idioma en ambos sentidos | `auth/i18n.test.mjs`, `packages/shim/src/account-storage.test.js` | 6 |
| A25 | Recepción Android mantiene título, URL, adjuntos, límites y no sobrescribe | `auth/share-target.test.mjs`, `auth/share-target-ui.test.mjs`, `auth/incoming-share-config.test.mjs` | 7 |
| A26 | Árbol/catálogo/montajes/bootstrap/lectura/escritura y carga mantienen presupuestos | `scripts/check-load.mjs` | 7 |

`auth/`, `routes/` y `vault/` se refieren a `apps/ignis-server/server/`.

## Comprobaciones que no sustituye la suite actual

1. **Obsidian real, dos usuarios:** abrir una nota compartida; cambiar permiso
   escritura→lectura→escritura y revocar. Probar nota limpia y con borrador. Comprobar
   bytes guardados, avisos, recuperación y desbloqueo sin recargar.
2. **Carreras:** revocar durante una petición en espera y durante un stream;
   cambiar sesión mientras termina una petición antigua. No pueden emitirse nuevos
   datos protegidos tras denegación; no se pueden retirar bytes ya enviados.
3. **Caída del proceso:** parar antes/después de publicación y commit; reiniciar
   y verificar identidad, grants, borradores y temporales. La cobertura actual de
   errores simulados no se presenta como una matriz completa de kill/restart.
4. **ENOSPC real:** fixture montado con espacio limitado, `IGNIS_TEST_FAULT_ROOT`;
   su prueba se omite en una ejecución ordinaria sin ese fixture.
5. **Android Chrome/Brave/PWA y Firefox:** teclado al crear/renombrar y abrir
   formularios; no usar la emulación de CDP como prueba del teclado del sistema.
6. **Escritorio y móvil:** 360×800 y 390×844, landscape, foco/escape/cierre,
   tooltips completos, una acción por fila en móvil y Cancelar debajo. Los errores
   de campo no desplazan botones; sin scroll horizontal o contenido inaccesible.
7. **OIDC real de pruebas:** retornos a Ignis con y sin bóvedas; link, unlink y
   reauth; un intento de navegación no ejecuta de nuevo operaciones sensibles.
8. **Conexiones y recursos:** abrir/cerrar/reconectar cien veces; verificar timers,
   listeners, sockets y memoria. La red caída no equivale a sesión revocada.

Estos escenarios son puertas para las fases indicadas, no pruebas manuales ya
realizadas en fase 0. Antes de retirar un adaptador interno debe existir evidencia
con la versión real de Obsidian fijada en la referencia.

## Orden de verificación por entrega

```sh
npm test
npm run lint
npm run build
node scripts/check-management-ui.mjs
node scripts/check-management-ui.mjs --mobile
```

El smoke de gestión usa API sintética. Para comprobar medidas y estilos nativos,
proporcionar `IGNIS_OBSIDIAN_CSS` desde una instalación legítima y registrar versión
y entorno. Las instrucciones del ensayo de rendimiento están en `performance.md`.
Las pruebas reales y de fallos se incorporan como gates en las fases que sustituyan
esos componentes; no se marca un escenario aceptado solo porque exista un test.

## Aceptación del artefacto Docker

Las pruebas desde el repositorio no detectan fuentes omitidas por el Dockerfile.
Después de cambiar módulos requeridos por el servidor, construir y comprobar
también la imagen de producción:

```sh
docker build -f apps/ignis-server/Dockerfile -t ignis:architecture-smoke .
npm run test:image
```

El smoke ejecuta el runtime que contiene la imagen, con su versión de Node y
dependencias de producción. Usa UID 1000, filesystem de imagen de solo lectura,
tmpfs desechable y red aislada; comprueba arranque, autenticación pública y parada.
No publica puertos, monta bóvedas del host ni descarga Obsidian. Los assets mínimos
son sintéticos: tampoco este gate certifica el runtime completo de Obsidian.

## Evidencia añadida en fase 3

`features/vaults/application/vaults.test.mjs` cubre contexto fijado, cero bóvedas,
registro administrativo y revocación. `routes/vault.routes.test.mjs` prueba que
sin lifecycle registrado no hay renombrado/borrado directo. La suite real
`auth/server.integration.test.mjs` verifica admin sin membresía, admin lector,
propietario normal y admin editor al instalar/leer/borrar código. El detalle de
archivos activos, preferencias y suites retiradas está en `phase3.md`.

## Evidencia añadida en fase 4

`features/content/adapters/publication.test.mjs` verifica fallos antes y después
de publicar, cambios de permisos/sesión/fuente durante staging y versiones CAS.
`features/content/application/replace.test.mjs` rechaza cambios mientras la
operación espera su cola. La suite `auth/resource-shares-recovery.test.mjs` añade
SIGKILL para notas originales/compartidas, append y copias.

`npm run test:content-faults` ejecuta esa matriz también con ENOSPC real en un
tmpfs de Docker dedicado de 1 MiB, sin red ni escritura sobre el repositorio.
Las pruebas de transporte y write-durability comprueban que no se reenvían
guardados inciertos; las de editor incluyen texto anterior al debounce, texto
nuevo durante una escritura y aislamiento del borrador por contexto.

## Evidencia añadida en fase 5

`auth/multiuser.integration.test.mjs` ejecuta además tres cuentas, WebSockets
reales, cambios de grants, una reconexión, escrituras externas y procesos CLI.
Comprueba destinatarios, ausencia de payload privado y revocación sin esperar al
heartbeat. Las pruebas del broker/observador están en `features/sharing/adapters/`,
y las del contexto de operación en `features/sharing/application/`.

`packages/shim/src/fs/shared-files.test.js` rechaza respuestas y acciones de una
generación anterior. `auth/events-web.test.mjs` comprueba backoff acotado, respuesta
de sesión obsoleta y ausencia de timers de sondeo mientras la conexión está sana.
Las pruebas de editor/shared-notice de las fases anteriores se conservan.

## Evidencia añadida en fase 6

`packages/management/src/client.test.js` cubre cierre durante fetch/JSON, clones,
contexto cambiado y listeners por montaje. `session-transition.test.js` cubre la
limpieza antes de OIDC. La arquitectura prohíbe imports cliente → servidor sin
excepciones y la adaptación de páginas por proxies/observadores en management.

`check-management-ui.mjs` amplía escritorio/móvil con crear/editar usuarios, X,
confirmación de sesiones, grants inválidos sin desplazar la ventana y apertura
individual sin catálogo detrás. El harness importa los mismos componentes/host
que producción, sin publicar una entrada de pruebas en el producto. El detalle
está en `phase6.md`; sigue pendiente la aceptación manual con runtime 1.14.4,
Android real y proveedor OIDC.


## Evidencia añadida en fase 7

- Proyecciones: vault-access y resource-shares comprueban trabajo acotado por
  snapshot, aislamiento, roles inyectados rechazados y revalidación de symlinks /
  membresía. State-events cuenta capturas por sesión y valida cada conexión.
- Contratos retirados: la integración HTTP rechaza `grant`; `grants` es mutación
  notificada. Bootstrap no incluye la bandera sin consumidores configurationMode.
- `test:runtime`: Obsidian 1.14.4 real, dos perfiles aislados, editor, bytes guardados,
  downgrade, intento lector, upgrade en la misma vista, revocación y host nativo.
  Se prueba escritorio y viewport móvil con assets privados en solo lectura.
- `check-management-ui`: CSS 1.14.4, escritorio y tres viewports móviles, incluyendo
  landscape; cien ciclos con canales y modales retirados.
- Carga: cinco rondas comparables, event loop, perfiles 1/10/50 y cien reconexiones
  por fixture, con límites productivos activos. Informe y límites en phase7.md.
- CI añadida con Node 22/24, navegador, imagen y fallos reales. Proveedor OIDC de
  producción, teclado/gestos Android reales y recepción del sistema requieren la
  comprobación manual correspondiente; no se presentan como validados por CDP.

## Comparación posterior del host sin bóvedas

`test:management-parity` compara ventanas y estados con el host nativo de
Obsidian 1.14.4 y exige también el estándar común de botones móviles.
[Alcance y resultados](zero-vault-review.md), con evidencia resumida en
`zero-vault-verification.json`. Los errores de API de la matriz son sintéticos;
no sustituyen las pruebas de autorización ni ejecutan operaciones destructivas.
