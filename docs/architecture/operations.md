# Operación y recuperación del monolito

Esta versión de desarrollo exige una instalación nueva con esquema 2. No ejecuta
migraciones de los esquemas anteriores y no borra automáticamente datos. Los assets
privados de Obsidian se fijan en 1.14.4; no se incluyen en el repositorio ni en la
imagen. La rama conserva las APIs protegidas y sólo mantiene fuera de la aplicación
/setup, /login, /reset-password y la recepción Android /share-target.

## Arranque y acceso

Configurar IGNIS_PUBLIC_ORIGIN con el origen público exacto. En producción usar
HTTPS. Si Traefik termina TLS, preservar Host y confiar exclusivamente en su IP o
subred controlada de Docker mediante IGNIS_TRUSTED_PROXIES. Una IP de LAN distinta
de la IP del proxy dentro de la red Docker no identifica al proxy ante Ignis.
No usar una subred compartida con contenedores no confiables. Los encabezados
reenviados desde otros peers se rechazan antes de autenticar.

Arrancar desde la imagen construida con el lockfile y su Dockerfile. Esperar el
evento estructurado server.started, no una cadena localizada. Revisar los eventos
server.schema_incompatible, logging.invalid_config y los eventos OIDC de arranque
si no llega. No habilitar dumps de cookies, tokens, secretos OIDC, cuerpos ni paths
privados para diagnosticar. Los logs usan eventos/campos permitidos en logger.js.

La configuración inicial crea el primer administrador. Los siguientes usuarios y
sus bóvedas se gestionan desde Ajustes > Cuenta; el gestor de bóvedas ofrece los
mismos ajustes aunque no exista ninguna bóveda. Ser administrador de instancia no
otorga acceso automático al contenido de otras bóvedas. Verificar correo sigue
siendo exclusivo del administrador. La reautenticación reciente dura cinco minutos.

El límite general `maxBodyBytes` se aplica al JSON descomprimido durante su
lectura, también con Transfer-Encoding chunked, gzip o deflate. Los cambios del
ajuste se aplican a las peticiones siguientes sin reiniciar. Las subidas binarias
de recepción Android conservan su límite `IGNIS_SHARE_MAX_MIB`; ese límite no
amplía el de las escrituras JSON. Autenticación, compartición e importación
conservan sus parsers y límites específicos.

La precarga `batch-read` deduplica rutas resueltas y admite hasta 1000 entradas.
Lee como máximo dos archivos simultáneos por petición, con 4 MiB por archivo y
16 MiB por lote, tanto de entrada como de respuesta serializada (sin la envoltura
JSON). Los archivos omitidos se consultan por la vía individual existente. Admite
seis peticiones simultáneas por cuenta y dieciséis globales; el exceso recibe 429
con Retry-After. Al desconectar se cancela el trabajo pendiente; las lecturas ya
en curso terminan antes de liberar la reserva. Los permisos se comprueban de nuevo
antes/durante la lectura y antes de emitir la respuesta.

## Backup coherente y restauración

La base identity.sqlite incluye identidades, sesiones, membresías, grants,
ubicaciones y planes de operaciones. No contiene los bytes de las notas.
Un backup de SQLite solo no es un backup de Ignis.

1. Parar el servicio y todos los escritores externos/CLI. Respaldar conjuntamente
   DATA_ROOT y VAULT_ROOT con permisos privados. Respaldar también la configuración
   del despliegue mediante el procedimiento seguro del operador, sin publicarla.
2. Para una copia aislada de identidad, `npm run auth -- backup /ruta/absoluta/copia.sqlite`
   utiliza la API SQLite de backup, no una copia improvisada del archivo WAL abierto.
3. `npm run auth -- restore /ruta/absoluta/copia.sqlite` restaura en un directorio
   auth nuevo, valida esquema/integridad y revoca las sesiones restauradas. No
   sobrescribe silenciosamente un directorio auth existente ni restaura notas.
4. Recuperar los archivos de la bóveda de la misma instantánea. Conservar permisos,
   directorios y relaciones; no sustituir recursos compartidos individualmente
   esperando que su identidad física siga siendo válida. Una identidad distinta
   deja el recurso no disponible: el propietario debe revisar y volver a compartir.
5. Arrancar, autenticar de nuevo y verificar árbol, grants, ubicaciones y bytes.
   Conservar el backup anterior hasta terminar esa verificación.

## Resultados inciertos y operaciones interrumpidas

Un guardado confirmado ha publicado los bytes y completado las barreras durables
previstas. Un fallo posterior al rename puede ser incierto; SQLite y filesystem
no son una única transacción atómica. No reenviar automáticamente un resultado
incierto. Conservar/descargar el borrador y comprobar el archivo antes de resolverlo.

Al reiniciar, las creaciones pendientes pasan a cuarentena; no se borran carpetas
que puedan contener datos. Los planes de borrado/renombrado conservan el estado
para revisión. Consultar `npm run auth -- status`, `list-vaults` y
`resolve-vault <id-or-directory>` antes de actuar. No editar tablas ni retirar
reservas manualmente mientras el servidor está abierto. Para datos desechables de
esta fase de desarrollo, usar un DATA_ROOT y VAULT_ROOT nuevos; conservar el anterior
para inspección si importa recuperar su contenido.

## Eventos, límites y observabilidad

Los avisos de compartición usan WebSockets e invalidaciones sin nombres/rutas.
Los clientes vuelven a consultar su proyección autorizada al conectar/reconectar;
no se hace polling periódico de catálogos en reposo. Heartbeat, caducidad de sesión
y backoff de reconexión tienen funciones distintas y permanecen activos.

La admisión permite hasta ocho sockets de eventos por sesión, 256 conexiones del
servicio y 30 upgrades por IP/minuto (además del límite global). No aumentarlos
para esconder bucles de reconexión. Un fallo del observador de SQLite cierra las
conexiones y bloquea upgrades hasta recuperar la vigilancia. Revisar
`auth.state_watch.unavailable`; recuperar el filesystem antes de reintentar.

La instrumentación de retraso del event loop es exclusiva del harness de carga;
no añade endpoints de diagnóstico ni datos privados al protocolo productivo.
Consultar phase7.md y performance.md para reproducir las puertas de aceptación.
