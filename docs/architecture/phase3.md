# Fase 3: bóvedas, autorización y configuración compartida

## Entrega

El módulo `server/features/vaults` reúne catálogo, autorización, creación,
registro, miembros, transferencia, renombrado y borrado. Sus casos de uso reciben
puertos explícitos; no importan Express, SQLite ni filesystem. Los adaptadores
conservan las transacciones, reservas, verificaciones de identidad de directorio,
quiescencia y recuperación existentes. No se simula una transacción única entre
SQLite y disco.

`application/vaults.js` crea un ámbito fijado al contexto de sesión. Revalida esa
identidad antes de cada operación y pasa el mismo guard a las comprobaciones
transaccionales de lifecycle. Actores y roles no proceden de campos del cliente.
La autorización de contenido conserva el UUID de la primera decisión para la
revalidación de la respuesta; no vuelve a conceder permisos por el nombre de un
directorio reemplazado.

`adapters/vault-store.js` agrupa operaciones y proyecciones de persistencia. La
composición construye catálogo, acceso y casos de uso una vez, y el límite HTTP
los recibe ya preparados. CLI registra bóvedas directamente mediante el mismo
adaptador transaccional que utiliza el caso de uso HTTP; se elimina el antiguo
helper de registro alojado en identidad. El CLI sigue siendo privilegiado por
acceso al host, no un endpoint con actor nulo.

## Un único camino de resolución y lifecycle

Toda referencia explícita a contenido, bootstrap, adjuntos o sockets pasa por el
catálogo registrado. UUID y nombre de directorio registrado siguen admitiéndose;
una referencia desconocida no se convierte en una ruta física ni selecciona otra
bóveda. El descubrimiento para registro administrativo es una operación separada.
No hay propiedad implícita por descubrimiento ni acceso al contenido por ser admin.

Se retiran los fallbacks de renombrado y borrado que operaban directamente sobre
filesystem desde `routes/vault.js`. Si falta el lifecycle registrado, las rutas
responden sin modificar disco. El validador de nombres es el mismo que usa la
creación transaccional. Los listados y bootstrap filtran directorios ajenos o no registrados antes de
proyectar UUID y metadatos. La selección inicial puede encontrar una bóveda
accesible; una selección explícita obsoleta nunca hace ese fallback.

Los fallos de creación siguen dejando reserva/cuarentena cuando no es seguro
limpiar; los de renombrado y borrado conservan su registro recuperable. Las pruebas
de estos adaptadores se mantienen, con imports actualizados. Esta fase no introduce
un segundo protocolo de recuperación.

## Política de configuración

Se conserva únicamente `.obsidian` compartido. Se retiran `/api/vault-config`,
los servicios de preferencias privadas/proyección restringida, la tabla
`vault_preferences` y los cuatro módulos del overlay privado del shim. También
se eliminan sus ramas de lectura/escritura en los factories FS. Los guards de
montajes compartidos y su exclusión de prefetch permanecen como `filePolicy`;
no se retira su aislamiento.

El esquema pasa a versión 2 y solo se soportan instalaciones nuevas. No hay
migración ni borrado automático de bases anteriores.

| Recurso | Lectura | Escritura |
| --- | --- | --- |
| Notas, adjuntos ordinarios y papelera revisada | Miembro | Editor o propietario |
| `app.json`, hotkeys, graph, workspace(s) revisados | Miembro | Editor o propietario |
| Complementos y todos sus archivos/datos | Miembro | Admin con membresía editor/owner |
| Temas, snippets y configuración desconocida | Miembro | Admin con membresía editor/owner |
| `community-plugins.json`, `core-plugins.json`, `appearance.json` | Miembro | Admin con membresía editor/owner |
| Estado oculto fuera de `.obsidian`, reservas `.ignis*` | Denegado | Denegado |

La distinción se basa en ubicación y contrato, no en extensiones: `data.json` de
un complemento también puede controlar código activo. `appearance.json` queda
bajo administración porque activa temas/snippets; no se intenta filtrar su JSON
parcialmente en esta fase. Los cambios de aspecto que guardan ese archivo también
quedan sujetos a esa política. La sonda de filesystem `.OBSIDIANTEST` conserva el
permiso ordinario de editor y no es un directorio de código.

Las operaciones recursivas, copia, renombrado y symlinks usan la misma política:
no basta con autorizar la carpeta visible que contiene código protegido. HTML,
JS y SVG ordinarios conservan descarga y CSP sandbox en adjuntos; no se habilita
su ejecución por pertenecer a una bóveda. Los complementos administrados siguen
siendo código de confianza del mismo origen; esto no es un sandbox de plugins.

## Evidencia y límites

Se conserva cobertura de ID estable, colisiones UUID/directorio, alias, membresías,
revocación, propiedad, lifecycle y adjuntos. Nuevos casos verifican ámbitos de
sesión sustituidos, cero bóvedas, rechazo de configuración activa para propietarios
normales, admin sin membresía y admin lector, retirada de almacenamiento privado
y ausencia del fallback destructivo. Las rutas reales comprueban instalar,
leer y eliminar código con la nueva matriz de roles.

Las suites eliminadas probaban exclusivamente la alternativa privada retirada:
`auth/vault-config`, `auth/vault-preferences`, `auth/workspace-config` y los cuatro
`fs/private-*`. Se retiran también sus casos específicos de prefetch/watchers;
las pruebas generales de estos mecanismos y los montajes compartidos permanecen.
No se presenta la reducción de tests como pérdida accidental ni como una mejora
por sí misma.

Las reglas de arquitectura prohíben infraestructura en los casos de uso de bóvedas
y ciclos que incluyan el módulo nuevo. La exclusión Git de los datos se limita a `/vaults/` para no ocultar el módulo
`features/vaults`. Los once imports históricos del cliente al
servidor permanecen para fase 6. La lógica de publicación de contenido y los
invalidation snapshots de comparticiones siguen en sus módulos actuales para las
fases 4 y 5.

La recepción Android no cambia de comportamiento: solo cambia el import de la
política reubicada. Los smokes de interfaz usan API sintética y CSS nativo 1.14.5,
no certifican el runtime completo objetivo 1.14.4 ni el teclado Android. La prueba
de imagen usa Node 22 y assets sintéticos sin red ni datos del host. El ensayo de
carga es una ronda de integración, no una nueva referencia estadística. Las pruebas
manuales y de fallos reales pendientes siguen enumeradas en `acceptance.md`.

## Verificación de entrega

- Suite completa: 169 archivos, 2.084 pruebas pasadas y una omitida (fixture ENOSPC).
- Lint, errores públicos, límites de dependencias y ciclos: pasan.
- Build: pasa con las advertencias preexistentes de eval y ListItem.
- Smokes de gestión de escritorio y móvil: pasan con CSS nativo 1.14.5.
- Imagen Docker final: construida y comprobada con `npm run test:image`, Node
  22.23.4; arranque, rutas de autenticación y parada correctos.
- Fixture HTTP: una ronda completa de 1.000/10.000 archivos y 10/100 recursos
  compartidos, con conflictos/copia concurrente y aislamiento comprobados.
  Para 1,000 archivos: p95 árbol 123.4 ms, bootstrap 128.1 ms.
  Para 10,000 archivos: p95 árbol 606.7 ms, bootstrap 597.9 ms.
  Estas cifras describen esta ejecución sintética; no sustituyen las cinco
  rondas de referencia ni certifican el rendimiento de Obsidian real.
