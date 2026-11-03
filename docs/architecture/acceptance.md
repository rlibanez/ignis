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
| A09 | Crear/registrar/renombrar/eliminar conserva ID y propiedad | `auth/vault-creation.test.mjs`, `auth/vault-registration.test.mjs`, `auth/vault-rename.test.mjs`, `auth/vault-deletion.test.mjs` | 3 |
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
