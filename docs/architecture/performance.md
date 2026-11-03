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

## Resultado de fase 7

La referencia histórica anterior no se sobrescribe. La comparación de aceptación
actual usa el commit previo 5729923 y el candidato con el mismo contrato de
publicación durable, cinco rondas, treinta muestras por operación y dos
calentamientos. Los archivos contienen HEAD, hash del diff pendiente, CPU, Node,
fixture y muestras; medir antes del commit explica que HEAD sea el commit base.

- [Referencia ampliada](baselines/phase7-reference.json).
- [Candidato final](baselines/phase7-candidate.json).
- [Presupuesto comprobado](baselines/phase7-budget.json).
- [Conexiones y event loop](baselines/phase7-events.json).
- Las primeras mediciones de diez muestras y el candidato intermedio se conservan
  como phase7-initial-*.json y phase7-intermediate-candidate.json. La variabilidad
  en operaciones de 1–2 ms motivó ampliar muestras y retirar compilaciones SQL
  repetidas; no se relaja el presupuesto ni se eliminan barreras durables.

Mediana de los p95 por ronda, milisegundos (valores redondeados para lectura;
el comparador utiliza las muestras sin ese redondeo):

| Operación | 1k antes | 1k después | 10k antes | 10k después |
| --- | ---: | ---: | ---: | ---: |
| Árbol | 124,0 | 16,3 | 605,9 | 79,2 |
| Bootstrap | 127,5 | 19,0 | 608,5 | 84,2 |
| Catálogo | 1,44 | 0,71 | 7,72 | 1,78 |
| Montajes | 1,96 | 1,13 | 23,08 | 5,16 |
| Lectura | 1,43 | 1,17 | 1,22 | 1,31 |
| Guardado durable | 1,74 | 1,83 | 1,70 | 1,71 |
| Lectura tras carga | 1,17 | 1,18 | 1,15 | 1,12 |
| Sesión durante árbol | 122,1 | 17,5 | 587,0 | 77,2 |
| RSS pico (MiB) | 360,7 | 311,2 | 489,2 | 439,1 |

Todas estas métricas pasan el límite de regresión del 15 %. El trabajo estructural
se comprueba además por consultas/resoluciones/capturas en las pruebas de servicios;
no se atribuye toda variación de décimas de milisegundo a una sola línea.

La carga de eventos se ejecuta aparte con diez fixtures (cinco por tamaño), perfiles
1/10/50 y 1.000 ciclos de conexión/cierre en total. El mayor p95 por perfil medido
es de 284.8 ms; la puerta automática es <=1 s en esta carga local. No son
cincuenta experimentos independientes cuando cincuenta sockets reciben el mismo
flush; los cinco fixtures independientes quedan en el JSON. El histograma de
event loop usa resolución de 10 ms y no debe interpretarse como latencia de red.

Los escenarios con eventos no son la referencia primaria de tiempos: se conserva
la separación de cargas. RSS principal se toma antes de crear esas conexiones;
el histograma del event loop sí incluye los perfiles adicionales cuando se activan.
No se introducen sondeos o endpoints de métricas en el servidor productivo.

```sh
npm run test:load -- --runs 5 --samples 30 --output /tmp/candidate-new.json
npm run test:budget -- --reference /ruta/reference.json --candidate /tmp/candidate-new.json
npm run test:load -- --runs 5 --events --output /tmp/events-new.json
```

Usar destinos nuevos; nunca sobrescribir evidencia. Ejecutar en serie, sin builds,
pruebas o Chrome en paralelo. En CI de hardware variable se aplican los contratos
funcionales, contadores de trabajo y presupuesto local de notificación; no se
compara ciegamente su p95 con el de esta máquina.

Prueba funcional adicional de estrés: [25.000 notas y 1.000 recursos](baselines/phase7-stress.json). Una ronda y cinco muestras: árbol p95 188,1 ms y bootstrap 203,5 ms. No sustituye a las cinco rondas del presupuesto estadístico.
