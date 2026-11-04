# Historia de entrega sobre upstream

Esta entrega reconstruye el producto aceptado como cuatro commits en `develop`,
sobre upstream `b349e57483473b21274b7cd8c9df01f0eea9f356`. La referencia de producto
es `168046f16754242bb4a591f1e8446e15e37798aa` (tag local
`delivery-source-2026-11-04`). Se conserva la rama original; esta entrega no
reescribe ni publica su historial.

## Bloques

| Bloque | Commit | Contenido y verificación |
| --- | --- | --- |
| 1 | `dff102f` | Servicios modulares de identidad, bóvedas y contenido. 1604 pruebas, lint y build desde una copia limpia. El arranque upstream permanece sin activar la integración. |
| 2 | `b9673fd` | Integración atómica del servidor protegido y cliente: cuentas, usuarios, permisos y compartición en tiempo real. 2202 pruebas; imagen, fallos y Obsidian real. |
| 3 | `64da800` | Importación desde carpeta/ZIP y exportación del propietario, con preferencias opcionales. 2320 pruebas; recorridos reales en escritorio y móvil, con y sin bóveda. |
| 4 | Pendiente de commit manual | CI, herramientas de carga, documentación histórica y evidencia final de equivalencia. 2323 pruebas en Node 22/24; copia limpia y navegador sin assets privados. |

Los bloques no reproducen los errores ni los estados intermedios de los 149
commits anteriores. Las funciones nuevas aparecen con sus contratos, controles y
pruebas correspondientes. La versión final sigue siendo un monolito modular.

## Equivalencia y diferencias deliberadas

La comparación final está en [delivery-verification.json](delivery-verification.json).
Todos los archivos de producto de `apps/` y `packages/`, sus modos Git, dependencias,
lockfile, configuración Docker y build se contrastan con la referencia aceptada.
La única normalización de producto elimina ocho espacios en una línea vacía del
CSS inyectado de `packages/management/src/management-dialogs.js`; no cambia
ninguna declaración ni comportamiento. La recepción Android permanece idéntica.

Diferencias de documentación/herramientas:

- README conserva el enlace Discord del nuevo upstream y explica cómo construir
  y configurar este fork, crear el administrador y usar instalaciones limpias.
- El índice identifica las fases y métricas antiguas como evidencia histórica.
  Sus JSON y resultados originales no se sobrescriben.
- `delivery-reference.json` fija la base actual para inventarios y nuevas
  mediciones. `reference.json` sigue describiendo la fase 0 histórica.
- CI fija Ubuntu 24.04 en sus runners públicos; mantiene Node 22.23.4 y 24.22.1.
- Los documentos `delivery*` registran la reconstrucción actual.

## Puertas de aceptación

Desde un checkout limpio, con las dependencias del lockfile:

```sh
npm ci
npm test
npm run lint
npm run build
npm run test:management
npm run test:load -- --runs 1 --events --output /tmp/load-new.json
docker build -f apps/ignis-server/Dockerfile -t ignis:architecture-smoke .
npm run test:image
npm run test:content-faults
```

Los ensayos crean datos temporales propios. Los destinos JSON de carga deben ser
nuevos; no se sobrescribe evidencia. Las mediciones temporales deben hacerse en
serie, sin tests, builds ni Chrome simultáneos. La carga funcional de CI no es una
comparación de tiempos entre máquinas distintas.

Para Obsidian real 1.14.4, proporcionar los assets privados de una instalación
legítima mediante `IGNIS_E2E_OBSIDIAN_ASSETS`; no se incluyen en Git:

```sh
npm run test:management-parity
npm run test:vault-transfers
```

La comparación de ventanas ejercita 54 estados por tamaño: 780×437, 2560×1440,
390×844, 360×800 y 844×390, con y sin bóveda abierta. Las transferencias prueban
selección completa y tradicional de carpeta, arrastre real de carpeta/ZIP,
preferencias/exclusiones, colisiones de nombre sin desplazar elementos,
respuestas perdidas, publicación y descarga real. Las pruebas del servidor
cubren propietario frente a administrador/lector, rutas peligrosas, enlaces,
límites, caducidad, revocación, cancelación y temporales.

## Evidencia y límites

Los resultados actuales, el inventario y el contraste de producto se guardan
junto a este documento. El [inventario actual](delivery-inventory.json) describe
archivos, rutas y canales; no interviene en autorización. Las mediciones de fase 7 conservan su presupuesto y
condiciones originales; las nuevas ejecuciones se identifican por separado.
Una comparación funcional correcta no constituye una garantía absoluta de
seguridad ni un benchmark de otro servidor.

La matriz local reproduce Node 22/24, componentes de navegador, imagen y fallos.
El resultado remoto de GitHub Actions solo puede comprobarse después del push;
no se presenta aquí como ejecutado. El job con assets privados es manual y exige
un runner propio `ignis-acceptance`. El teclado y gestos físicos de Android y el
proveedor OIDC de producción siguen siendo comprobaciones manuales; los tests
OIDC usan un proveedor local y el móvil se prueba por emulación de viewport.

## Rendimiento de esta reconstrucción

Se conservan las cinco rondas nuevas de treinta muestras del
[candidato](baselines/delivery-candidate.json) y de la
[referencia aceptada](baselines/delivery-reference.json), medidas en serie y
comparables en el entorno registrado. La comparación con la antigua medición de
fase 7 fue rechazada porque `totalMemoryBytes` difería en 4096 bytes. No se ha
alterado ese control ni el presupuesto del 15 %.

La [comparación actual](baselines/delivery-budget.json) no pasa formalmente en
dos métricas: catálogo de 1000 notas (0,698 → 0,807 ms; +15,6 %) y lectura de
10000 notas (1,266 → 1,486 ms; +17,4 %). Se trata de variación observada al ejecutar
código de producto idéntico; no se atribuye una causa de rendimiento a la
reconstrucción ni se presenta el presupuesto como superado. No se repiten rondas
para seleccionar únicamente un resultado favorable. Las demás 16 comparaciones
pasan; la comprobación histórica de fase 7 también conserva su resultado.

El árbol del candidato tiene p95 de 16,6/81,1 ms y bootstrap de 18,8/83,6 ms
para 1000/10000 notas. La [carga separada de eventos](baselines/delivery-events.json)
pasa los perfiles de 1/10/50 conexiones, con p95 máximo de 58,9 ms y 200 ciclos
de reconexión entre ambos fixtures. Estos resultados son evidencia local, no un
SLA. CI mantiene una carga funcional acotada y no compara tiempos entre máquinas.
