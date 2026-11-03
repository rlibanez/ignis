# Decisiones de arquitectura

Estas decisiones convierten la propuesta aceptada en límites concretos. Fase 0
solo documenta y mide: no cambia aún la política del producto.

## D01. Un monolito modular

Conservar servidor, contenedor y herramientas actuales. Separar identidad,
bóvedas, comparticiones y contenido, con adaptadores explícitos para SQLite,
filesystem, HTTP, WebSockets y Obsidian. No usar el número de commits como métrica
de calidad ni crear un paquete por clase.

## D02. Referencia fija e historia posterior

El tag local anotado `architecture-phase0-baseline` apunta a `4b89605` y no debe
moverse ni reutilizarse. No se ha publicado. El SHA completo y el upstream común
están en `reference.json`, que permite localizar la referencia aunque no se hayan
descargado tags. Upstream no se actualiza durante una extracción funcional.

Solo después de aceptar el producto reconstruido se preparará una rama de entrega
con commits funcionales completos. No se hará un squash preventivo ni se borrará
la referencia de trabajo.

## D03. Configuración compartida y código de confianza

El producto actual arranca con configuración compartida de `.obsidian`. Ese es
el único modo inicial del diseño; la alternativa privada se retirará en fase 3
tras inventariar sus consumidores. No se activará silenciosamente el antiguo
perfil restringido.

Objetivo aprobado en el diseño: separar editar notas de instalar o modificar
código ejecutable. La recomendación de la auditoría queda adoptada como política
objetivo: administrar código requiere administrador y autorización sobre la
bóveda. No se concede acceso al contenido de cualquier bóveda por ser admin.

Antes de aplicarlo en fase 3 hay que enumerar y probar archivos/operaciones de
código, preferencias y recursos activos. Una distinción basada solo en la extensión
del archivo no basta. El cambio de permisos debe ser explícito en esa entrega.

Los complementos instalados siguen siendo código de confianza. No se promete
aislamiento frente a scripts maliciosos del mismo origen ni entre usuarios que
pueden introducir código ejecutable. El almacenamiento por cuenta no es un sandbox.

## D04. Datos de desarrollo y esquema inicial

No hay instalaciones que migrar. En fase 1 se puede consolidar el esquema y
descartar compatibilidad de desarrollo. Debe rechazarse claramente una base
incompatible; nunca borrarla silenciosamente al arrancar. Fase 0 no tocó datos;
fase 1 aplica este esquema únicamente a bases nuevas y rechaza las antiguas.
Conservar invariantes, unicidad, último admin y revocación también en persistencia.

## D05. Autorización vigente y resultados de escritura

El servidor es la autoridad. El contexto identifica al actor, pero no es un permiso
duradero. Revalidar antes de efectos y después de esperas relevantes. No compensar
rendimiento con cachés de permisos obsoletas.

Una escritura puede quedar confirmada, denegada, en conflicto, fallida antes de
publicar o con resultado incierto. El borrador solo se descarta tras confirmación.
No reintentar ciegamente un resultado incierto ni fingir atomicidad entre SQLite
y disco. Mantener reservas, publicación completa y recuperación documentada.

## D06. Integración y versiones

Obsidian de referencia: 1.14.4. No se modifican sus assets ni se incluyen en el
repositorio. Los parches necesarios a sus internals se concentran en un adaptador
de versión; una versión nueva requiere comprobar el contrato antes de soportarla.
Mantener los puntos síncronos que su arranque necesita mientras no exista una
alternativa demostrada. No añadir fallback silencioso a guardados inseguros.

## D07. Eventos y funciones conservadas

Sin polling periódico de comparticiones. Heartbeat, limpieza de caducidad y backoff
son mecanismos distintos y pueden mantenerse con límites. Reconexión recupera
estado autorizado; no presupone haber recibido todos los eventos.

Cuenta sin bóvedas, reautenticación de cinco minutos, recepción Android y sincronía
de idioma se conservan. No introducir CRDT, fusión automática, cambio de username
ni rediseño del flujo Android dentro de esta reconstrucción.
