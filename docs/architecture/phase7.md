# Fase 7: aceptación, rendimiento y operación

## Trabajo eliminado de las rutas calientes

Árbol y bootstrap utilizan una proyección de autorización en una transacción
SQLite por conjunto de entradas. Sesión, usuario, bóveda y membresía se resuelven
una vez; las decisiones de path conservan la política existente. Los prefijos de
filesystem se inspeccionan una vez por evaluación. Esta memoria no sobrevive a
una petición, espera o revalidación. Las tres sentencias SQL de autorización se
compilan una vez por servicio; sus filas y parámetros de autorización se vuelven
a evaluar en cada transacción. Las operaciones de un solo path evitan reservar
las estructuras de memoización de los lotes. No representa una instantánea atómica del
filesystem: se mantiene la comprobación fresca antes de enviar la respuesta y
las barreras de autorización/identidad del publisher antes de publicar bytes.

Catálogo y montajes reutilizan el actor y las fuentes/propietarios dentro de su
transacción síncrona, manteniendo stat/identidad física por recurso. Los recursos
no disponibles siguen visibles para su propietario, incluso si la bóveda está
inactiva, y no para sus destinatarios. No hay caché global de permisos.

La reconciliación de eventos captura una proyección por sesión y flush, validando
cada socket antes de usarla. No retiene snapshots compartidos entre flushes ni
añade sondeos de negocio. Las pruebas cuentan una resolución de sesión y un
número acotado de consultas al proyectar mil paths, una resolución de actor al
listar cien recursos y una captura por sesión al reconciliar múltiples sockets.

## Un único contrato vigente

Se retira la operación HTTP `grant`, que ya no utilizaba ningún cliente. Cambiar
permisos usa exclusivamente `grants`, con cambios atómicos y revisión. Dejar de
compartir usa `revoke`, con un caso de uso explícito. Las pruebas que antes usaban
el comando antiguo se ejecutan ahora por los comandos productivos; una petición
al comando retirado debe devolver 400 sin modificar la revisión.

La clasificación de `grants` como lectura era incorrecta: ahora es una mutación
y notifica al completar, sin depender exclusivamente del observador de SQLite.
`validateGrant` continúa siendo una lectura sin notificación de mutación. Los logs
reconocen ambos nombres sin registrar listas de grants, tokens o contenido.

Se elimina `configurationMode`, propiedad constante y sin consumidores desde que
se retiró la configuración privada. No se añaden aliases, banderas temporales,
tablas de compatibilidad ni migraciones. La recepción Android no se rediseña. Se retiran también los controles ocultos de
cuenta/logout y su controlador muerto de /login; el único cierre productivo sigue
en Cuenta. Las tres pruebas del antiguo botón se sustituyen por la prueba del
rechazo de logout en el cliente vigente; éste ya comprueba revocación confirmada
y limpieza de almacenamiento fallida.

## Rendimiento reproducible

Los resultados y comparación están en `baselines/phase7-*.json`. Se conservan las
primeras cinco rondas de diez muestras y la comprobación ampliada de treinta
muestras por operación, cinco procesos/fixtures independientes por escenario y
dos calentamientos fijos. Para reducir ruido se ejecutan en serie, sin tests,
builds o Chrome simultáneos. La referencia ampliada usa un checkout temporal del
commit previo, con el mismo harness y dependencias; no se cambia la rama de trabajo.

`compare-load.mjs` exige perfil, fixture, hardware registrado, Node, calentamiento
y muestras compatibles y al menos cinco rondas. Compara la mediana del p95 de
cada ronda y el pico RSS, con presupuesto del 15 %. Utiliza las muestras raw cuando
existen, no los resúmenes redondeados a una décima: ese redondeo puede fabricar una
regresión aparente en operaciones de un milisegundo. La comprobación es una medida
local bajo esta carga; no es una promesa para cualquier disco, red o host.

`check-load --events` añade perfiles de 1/10/50 sockets y cien ciclos de apertura /
cierre por fixture. Usa siete sesiones y distintas IPs de loopback para respetar
los límites productivos de ocho sockets por sesión y treinta upgrades/IP/minuto;
no desactiva ni amplía los límites. El p95 local de notificación debe ser <=1 s.
Los avisos se validan como invalidaciones sin metadatos privados. Los sockets se
cierran con timeout acotado. La medición del event loop usa un preloader exclusivo
del harness, a resolución 10 ms; no crea un endpoint de diagnóstico en producción.
Los picos RSS de operaciones principales se capturan antes de los perfiles WS.

Frente a fase 0, las escrituras incorporan las garantías de publicación durable
de fase 4. Su coste adicional no se oculta ni se elimina fsync para cumplir una
cifra histórica. La referencia principal de esta fase compara el mismo contrato
de guardado en el commit anterior y el candidato. El informe histórico de fase 0
se conserva y esa diferencia de garantías se declara expresamente.

## Runtime y componentes reales

`test:runtime` exige assets privados 1.14.4 mediante IGNIS_E2E_OBSIDIAN_ASSETS y
los usa sin modificarlos. Crea una instalación temporal con bootstrap, bóvedas
por el lifecycle y dos perfiles aislados de Chrome. Carga Obsidian y su editor
reales, guarda desde el receptor y verifica bytes del original; cambia lectura /
escritura y revoca sin cerrar el editor; comprueba que una nota limpia no muestra
recuperación, que escribir como lector no cambia bytes y que restaurar escritura
permite guardar en la misma vista. Abre y cierra la gestión en el host nativo.
Se ejecuta en escritorio y viewport móvil, sin distribuir los assets en Git.

El smoke de componentes usa también CSS de esa versión: escritorio, 390×844,
360×800 y 844×390. Incluye errores de campo sin mover botones y cien ciclos por
recorrido, comprobando que no quedan modales ni canales abiertos. Se corrige la
ayuda del host sin bóvedas en landscape: conserva la capa del diálogo y limita
posición/tamaño al viewport. La emulación no certifica el teclado del sistema
Android, la hoja de compartir de Android ni los gestos físicos de cada navegador.

## CI, inventario y operación

`.github/workflows/architecture.yml` ejecuta lint, suite y build en Node 22.23.4 y
24.22.1, componentes de navegador y carga funcional con eventos. Otro job construye
la imagen, comprueba su arranque y ejecuta la matriz EACCES/ENOSPC/SIGKILL. El E2E
con assets privados es manual en un runner `ignis-acceptance`, con las variables
IGNIS_E2E_OBSIDIAN_ASSETS e IGNIS_CHROME_PATH. No descarga ni publica Obsidian.
El harness usa el upstream fijado en reference.json para sus metadatos; no exige
un remoto upstream/main ni historial completo en un checkout superficial de CI.
Las versiones y opciones de las actions se contrastan con sus fuentes primarias:
[checkout](https://github.com/actions/checkout),
[setup-node](https://github.com/actions/setup-node),
[upload-artifact](https://github.com/actions/upload-artifact) y
[setup-chrome](https://github.com/browser-actions/setup-chrome).
El runner privado debe soportar actions basadas en Node 24 (>=2.327.1).
La configuración de CI está añadida; ejecutarla en GitHub requiere publicar el
commit. No se presenta como un run remoto ya realizado.

`phase7-inventory.json` registra rutas/documentos/WS y todos los archivos cambiados
respecto al upstream fijado, distinguiendo los originales modificados de los
nuevos. Es un inventario descriptivo, nunca una entrada para autorizar peticiones.
`operations.md` documenta arranque, proxies Docker, backups coordinados de DB y
bóvedas, restauración y sesiones revocadas, cuarentena y resultados inciertos.
README y la arquitectura general dejan de afirmar que no hay autenticación integrada.

## Límites y aceptación manual

Las regresiones de OIDC se ejecutan con proveedor de pruebas local, no contra un
proveedor de producción. Mantener la comprobación manual con el proveedor elegido
y con Android Chrome/Brave/PWA/Firefox para teclado y recepción del sistema. La
aceptación automática no demuestra ausencia absoluta de fugas de memoria: sí
comprueba cierres, canales/DOM retirados, generaciones y reconexión acotada.
La fase 8 todavía requiere reconstruir y verificar la historia sobre upstream;
esta fase no reescribe commits ni publica ramas.
