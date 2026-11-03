# Referencia de rendimiento de fase 0

Resultado completo: [baselines/phase0.json](baselines/phase0.json).
Son mediciones del servidor actual, sin optimizaciones del producto.

## Reproducción

Desde el repositorio, con Node 24 y las dependencias del lockfile:

```sh
npm ci
node scripts/check-load.mjs --profile baseline --runs 5 --samples 10 --warmup 2 --output /tmp/ignis-baseline-new.json
```

El destino debe ser nuevo: la herramienta rechaza sobrescribir una medición.
Reserva el archivo al empezar; un ensayo interrumpido puede dejarlo vacío y no
debe contarse como un resultado. Solo un JSON completo representa una ejecución
terminada. Resúmenes de progreso salen por stderr y el resultado por stdout.

Para una comprobación rápida, `npm run test:load` ejecuta una ronda. Para ampliar
la carga sin mezclar fixtures, usar `--profile stress` (25.000 notas, 1.000 recursos).
El perfil stress no forma parte de la referencia inicial guardada.

Cada escenario crea SQLite, bóvedas y assets sintéticos temporales y arranca un
servidor real en un puerto libre. No usa ni modifica las bóvedas de la instalación.
El hijo no hereda variables de despliegue, credenciales OIDC ni destinos de logs.
Reconoce JSON `server.started`, independientemente del orden de campos y del texto
humano. Se detiene y retira el fixture al terminar, también ante fallo ordinario.

El fixture necesita módulos actuales del servidor. Al consolidar el esquema o
cambiar sus contratos deberá adaptarse conservando las mismas condiciones de
carga; hay que revisar y registrar el cambio, no comparar fixtures diferentes.

## Condiciones de la referencia

- Producto: `4b896055df511a6837a532c60318ac5e647cdd67`; sin diff en código de producto.
- Cinco rondas independientes de dos escenarios; diez muestras tras dos llamadas
  de calentamiento por operación. Cada escenario arranca un proceso/BD nuevos.
- Las cifras «1.000» y «10.000» son notas de carga, no el total del fixture: se
  añaden 10/100 carpetas compartidas con una nota cada una y 1.200 archivos fuente
  para las copias. Durante la prueba se publican dos copias de esos 1.200 archivos.
- HTTP localhost, sin compresión, respuestas completas y llamadas secuenciales.
- Login scrypt excluido de las muestras de operaciones; forma parte de preparar
  clientes. No se desactiva autenticación, autorización, CSRF ni control de versiones.
- Lectura: nota de 1.017 bytes. Guardado: texto pequeño versionado; el hash devuelto
  se comprueba contra los bytes reales del disco en cada muestra.
- Seis copias simultáneas: se comprueban dos éxitos y cuatro rechazos por capacidad,
  todos los bytes de las copias publicadas y ausencia de staging residual.
- Un usuario ajeno no ve el árbol del propietario ni recursos en su catálogo.
- Linux x64, Intel i7-13700K, Node v24.22.1; detalles exactos en el JSON.
- RSS del hijo mediante `/proc/.../status`, incluyendo lo consumido por el fixture
  durante la ejecución. Los límites cgroup no están disponibles en este entorno
  y se registran como `null`; no se supone que sean ilimitados.
- Assets mínimos sintéticos: **no se carga Obsidian**, que no se distribuye aquí.

## Resultados

Mediana entre las cinco rondas del p95 de cada ronda, en milisegundos:

| Operación | 1.000 notas / 10 comparticiones | 10.000 notas / 100 comparticiones |
| --- | ---: | ---: |
| Árbol | 132,1 | 666,2 |
| Bootstrap | 136,5 | 643,1 |
| Catálogo de comparticiones | 1,3 | 7,2 |
| Montajes | 1,8 | 29,2 |
| Lectura pequeña | 1,4 | 1,5 |
| Guardado pequeño versionado | 1,6 | 1,5 |
| Consulta de sesión durante árbol | 126,2 | 629,8 |

Mediana del pico de RSS por escenario: 254,5 MiB y 461,7 MiB respectivamente.

Con diez muestras, el estimador de p95 de una ronda coincide con su máximo; no es
una estimación precisa de la cola de latencia poblacional. Se conservan las muestras
de operaciones para ampliar el análisis. Los probes de sesión son cinco por árbol
y doce por conjunto de copias: su resumen muestra sensibilidad al bloqueo, no un
benchmark de sesiones a gran escala. La cifra agregada no es el p95 de todas las
muestras mezcladas. No se ha medido directamente el retraso del event loop.

## Interpretación y presupuesto futuro

El árbol y el bootstrap son las prioridades iniciales; una operación de árbol
también retrasa consultas ligeras de sesión. Estas mediciones son compatibles con
el trabajo síncrono y la autorización repetida observados en la auditoría, pero no
atribuyen por sí solas todo el tiempo a una función concreta.

Comparar al menos cinco rondas sobre el mismo entorno, perfil, payload, calentamiento
y muestras. El JSON guarda SHA de producto y herramienta para detectar diferencias.
No ejecutar tests/build u otra carga pesada simultáneamente con la referencia.
No convertir el margen de 15% en una condición de CI ciega sobre máquinas distintas.

Objetivo para la fase 7: p95 y RSS sin regresión superior a 15% en escenarios
comparables; si el ruido lo impide, aumentar muestras y documentarlo. Debemos además
reducir consultas/proyecciones repetidas en los cuellos identificados. Las pruebas
de conexiones 1/10/50, retraso del event loop, latencia de notificación y cien ciclos
de reconexión forman parte de la validación ampliada, todavía no medida aquí.
