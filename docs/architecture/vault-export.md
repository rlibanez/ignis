# Exportación de bóvedas

El menú del Gestor ofrece «Exportar bóveda» solo en entradas cuya membresía sea
owner. El servidor vuelve a comprobar la propiedad: ser administrador de instancia,
lector o editor no concede este permiso. El diálogo comparte las clases nativas
de los formularios y funciona con Obsidian abierto y en el host sin bóveda.
En móvil muestra Exportar primero y Cancelar después, a ancho completo.

## Contenido y portabilidad

El ZIP contiene los archivos físicos de esa bóveda dentro de una carpeta
contenedora con su nombre. Así, el detector de raíz del importador elimina solo
esa envoltura y conserva las carpetas del usuario, incluso si solo existe una.
El límite de entradas y profundidad incluye también esa carpeta contenedora. Nunca
consulta la proyección de recursos compartidos: los montajes recibidos no se
materializan ni se copian. Los archivos propios compartidos con otros sí se
incluyen; cuentas, sesiones, UUID, membresías y relaciones de compartición no.

Los ajustes de Obsidian y los complementos comunitarios son opciones
independientes y están desmarcadas inicialmente. Los ajustes incluyen, por
ejemplo, temas, fragmentos CSS y atajos. Los complementos incluyen su
configuración y estado de activación. El diálogo advierte que se conserve el
ZIP en privado. Al restaurarlo se aplica la política de importación de Ignis.

Se excluyen enlaces simbólicos, archivos con varios enlaces físicos, archivos
especiales, `.git`, `.trash`, `node_modules`, `__MACOSX` y temporales `.ignis-*`.
Los directorios vacíos se conservan en el ZIP y al importarlo de nuevo. El ZIP también puede extraerse para usarlo en Obsidian.
Es una exportación de contenido, no una copia de seguridad de la instancia.

## Seguridad y recursos

`POST /api/vault/export` exige sesión, Origin/Host y CSRF y admite únicamente
`{vault, configuration, plugins?}`. Si se omite `plugins`, toma el valor de
`configuration` para conservar el comportamiento anterior. La ruta está inventariada y limitada por frecuencia.
La identidad del actor se obtiene de la sesión; nunca del cuerpo de petición.
La autoridad conserva la sesión y el UUID, comprueba propiedad y versión de
política y fija la identidad del directorio raíz a través de las esperas.

El adaptador vacía las escrituras pendientes antes de enumerar los archivos.
Comprueba padres y hojas, abre con O_NOFOLLOW y valida inode/dispositivo, tamaño,
enlaces y timestamps durante la lectura. Revoca al perder sesión o propiedad.
Los cambios detectados abortan la preparación; no se ofrece un snapshot global
transaccional frente a ediciones concurrentes de toda la bóveda.

No se siguen rutas de compartición ni enlaces. El ZIP se prepara fuera de las
bóvedas, en DATA_ROOT/vault-exports, con directorio privado y archivo 0600.
La preparación usa streams con contrapresión y límites compartidos con importación:
10000 entradas, 32 MiB por archivo, 256 MiB de contenido y 64 MiB de ZIP.
Una exportación por actor, cuatro simultáneas globalmente. La descarga mantiene
la reserva y revalida autorización por bloque; Cache-Control es no-store.

El navegador recibe un Blob de tamaño limitado, permite cancelar y descarga el
archivo sin navegar fuera de Ignis. El cierre, pérdida de sesión o desconexión
aborta el trabajo. El servidor elimina temporales al terminar/fallar y limpia
restos de interrupciones al arrancar, sin añadir tareas periódicas.

## Pruebas

- `auth/vault-export.test.mjs`: autoridad real de bóvedas; propietario normal,
  admin sin propiedad, lector, referencias inválidas, configuración opcional,
  enlaces, límites de entrada/salida, revocación durante lectura, sustitución de
  directorio, cancelación, concurrencia y limpieza. Un montaje recibido real
  aparece en la proyección de compartición y se comprueba ausente en el ZIP.
- `auth/http.test.mjs`: descarga real, cabeceras, CSRF, petición anónima, esquema
  estricto, alias con barra final y denegación al perder propiedad.
- `npm run test:vault-transfers`: recorrido completo importar/exportar con Obsidian
  1.14.4 privado. Menú real del Gestor, formulario y orden de botones en móvil,
  descarga real del navegador, ida y vuelta de una bóveda con una única carpeta,
  comprobación de bytes y configuración, con y sin
  bóveda abierta. Las capturas se guardan en `/tmp/ignis-export-*.png`.
- Lint, suite general y build. Android físico sigue fuera de la emulación.
