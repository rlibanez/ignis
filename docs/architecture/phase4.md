# Fase 4: publicación de contenido y guardado del editor

## Servicio común

`features/content/application/replace.js` coordina el vaciado de escrituras
anteriores, la serialización por destino y el publisher. No importa filesystem,
SQLite, Express ni servicios de identidad/comparticiones. Recibe puertos explícitos.
Un cambio de actor, bóveda o ruta durante la espera cancela la operación; no se
publica un destino nuevo usando la cola de uno anterior. Las operaciones de
subárbol conservan el drenaje/quiescencia del coalescer y lifecycle existentes.

`adapters/runtime.js` resuelve los originales por UUID y contexto de sesión fijado.
Comprueba usuario activo, auth_version y membresía vigente. Las comparticiones
aportan su selector de grant vigente a la misma operación de reemplazo. La
composición crea una instancia para ambos recorridos. Se retiran `writeOriginal`
y `publish` del módulo de comparticiones; no queda otro publisher de notas allí.

`adapters/publication.js` prepara bytes completos en un archivo reservado del mismo
directorio, sincroniza el archivo y entra en la transacción de publicación. Dentro
de ella vuelve a resolver permisos, ruta y versión antes del renombrado. La misma
transacción actualiza las identidades de grants de archivo, y se sincroniza el
directorio. No hay un await entre la validación final y esos efectos.

El servicio común cubre reemplazos originales, escrituras compartidas, append y
copia de archivos ordinarios locales. Append prepara un archivo completo; copiar
no trunca el destino existente. Ambos procesan la fuente en bloques de 64 KiB,
sin cargarla entera en memoria, y comprueban que no cambió durante la preparación.
Las rutas de configuración oculta conservan su I/O/política de fase 3; no se les
atribuye el contrato del editor. Las copias de recursos/subárboles compartidos
conservan su staging/reservas ya existente, que se reorganiza con grants en fase 5.

## Versiones y resultados

`packages/contracts/src/content.js` define las precondiciones y la clasificación
compartida de errores:

| Precondición | Intención |
| --- | --- |
| SHA-256 exacto | Reemplazar únicamente la versión leída por ese editor |
| `null` | Crear únicamente si no existe |
| Omitida | Reemplazo deliberado de plugin; nunca hereda la versión de otro editor |

Las escrituras compartidas no admiten omitir su versión. Append compara la versión
que ha incorporado a su staging; la copia valida su fuente dentro de la transacción.
Los bytes preparados y los destinos se mantienen privados al recorrido autorizado.

| Resultado | Comportamiento |
| --- | --- |
| `committed` | Publicación y metadatos confirmados; se permite confirmar el guardado |
| `conflict` | La versión/ruta cambió o falta una precondición válida; no sobrescribir |
| `denied` | Falta autoridad vigente; no publicar |
| `failed` | Fallo comprobado antes de publicación; original preservado |
| `uncertain` | El renombrado ocurrió pero falló la confirmación, o se perdió una respuesta; conservar borrador y no reenviar a ciegas |

El adaptador HTTP de contenido usa mensajes fijos y no expone errores de SQLite o
rutas del host. Solo el publisher puede afirmar que un fallo sucedió antes de
publicar. El transporte del shim trata una pérdida de red, un acuse incompleto o
un error ambiguo de proxy como incierto. Un HTTP 200 sin confirmación de escritura
válida tampoco descarta el borrador. Las escrituras inciertas/conflictivas/denegadas
quedan retenidas, excluidas del backoff, retryAll y envío de unload.

## Adaptador de Obsidian y borradores

La integración específica se encuentra en
`packages/shim/src/integration/obsidian/1.14.4/editor-saves.js`, tras un dispatcher
que exige la versión 1.14.4 recibida por el arranque. Una versión desconocida se
rechaza antes de parchear métodos nativos. Se conservan las comprobaciones
estructurales de TextFileView y del adapter y la intención privada por llamada,
no una bandera global de «guardando» que pudiera heredar un plugin concurrente.

El algoritmo de guardado conserva la baseline de cada vista, el callback de caché
y la reconciliación nativa. La recuperación ahora captura también vistas sucias
antes de su debounce y el texto actual mientras espera un guardado, además de los
borradores fallidos/desacoplados. Restaurar el original no sustituye el borrador
retenido por esa baseline. Los snapshots se limitan al contexto original; un
cambio de cuenta o bóveda no entrega texto al nuevo contexto. No se añade una
persistencia local de borradores entre cuentas ni una fusión automática.

## Recuperación de fallos y límites

No hay atomicidad conjunta entre disco y SQLite. Si muere el proceso tras el
renombrado y antes del commit, los bytes nuevos quedan completos y los grants
explícitos que conservan la identidad anterior dejan de resolver. No se les asigna
silenciosamente un reemplazo por nombre. El propietario puede inspeccionar el
original y gestionar de nuevo la compartición. Los temporales de un proceso muerto
siguen reservados/inaccesibles por API; no se publican automáticamente al reiniciar.

El diseño requiere que los escritores de Ignis usen la misma base y los mecanismos
de autorización/publicación. No promete CAS frente a programas ajenos que escriban
libremente en el volumen fuera de ese contrato ni soporte de múltiples bases
independientes sobre las mismas bóvedas.

Se mantiene el esquema 2 de fase 3; esta fase no requiere otro reset. No cambian
los formularios ni el protocolo de recepción Android. Sus escrituras ordinarias
pasan por la publicación común y sus pruebas siguen vigentes.

## Aceptación reproducible

Además de la suite, build, lint, reglas de dependencias, smokes de gestión y carga:

```sh
docker build -f apps/ignis-server/Dockerfile -t ignis:architecture-smoke .
npm run test:image
npm run test:content-faults
```

El último comando ejecuta la matriz de recuperación con Node 22 en un contenedor
sin red, UID 1000, repositorio de solo lectura y un tmpfs desechable de 1 MiB. La
prueba llena solo ese tmpfs para provocar ENOSPC real. No llena discos del host.
Incluye EACCES real y SIGKILL antes/después de renombrar: originales, compartidos,
append, copias, renombrado y eliminación. Las pruebas por inyección añaden fallos
de sync y cambios de sesión, permisos y fuente durante staging.

Las pruebas de editor usan un doble del contrato nativo y fixtures de concurrencia;
no se presentan como una ejecución de Obsidian completo 1.14.4. Los smokes de
interfaz usan API sintética y CSS nativo 1.14.5. Se mantienen las puertas manuales
con Obsidian real, Android y proveedor OIDC de `acceptance.md` para la validación
final. No se declara soporte de versiones nuevas solo porque pasen tests sintéticos.

## Verificación de entrega

- Suite completa: 172 archivos, 2.135 pruebas pasadas y una omitida por no tener
  el fixture ENOSPC en el host.
- `test:content-faults`: las 16 pruebas de recuperación pasan en Node 22.23.4,
  incluida la prueba de ENOSPC real omitida en el host.
- Lint, errores públicos, dependencias/ciclos y build: pasan; permanecen las
  advertencias preexistentes de eval y ListItem.
- Imagen de producción: construida, arranca y se detiene correctamente; rutas
  públicas de autenticación comprobadas mediante `test:image`.
- Smokes de gestión de escritorio y móvil: pasan con API sintética y CSS nativo.
- Ensayo HTTP de carga: una ronda completa de 1.000/10.000 archivos, 10/100
  recursos compartidos y diez muestras por operación.
  Con 1,000 archivos: p95 árbol 122.5 ms, bootstrap 130 ms, escritura 2.1 ms.
  Con 10,000 archivos: p95 árbol 629 ms, bootstrap 599.3 ms, escritura 1.8 ms.
  Es una comprobación de integración/coste, no una nueva referencia estadística
  ni una certificación del rendimiento del editor real.
