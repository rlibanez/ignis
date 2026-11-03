# Reconstrucción de la integración de Ignis

Fase 0 completada el 3 de noviembre de 2026. Este directorio guarda el contrato de
trabajo para reconstruir nuestra implementación como un **monolito modular**.
La referencia de fase 0 es histórica; los avances posteriores se describen aparte.

- [Fase 1: composición, contratos y persistencia](phase1.md).
- [Fase 2: identidad, cuenta y controladores HTTP](phase2.md).
- [Fase 3: bóvedas, autorización y configuración compartida](phase3.md).
- [Fase 4: publicación de contenido y guardado del editor](phase4.md).
- [Fase 5: comparticiones y eventos](phase5.md).
- [Fase 6: componentes de gestión y hosts](phase6.md).
- [Fase 7: aceptación, rendimiento y operación](phase7.md).
- [Operación y recuperación](operations.md).

- [Referencia fijada](reference.json): producto, upstream y versión de Obsidian.
- [Auditoría y diseño completo](audit-2026-11-03.txt): evidencia, responsabilidades,
  contratos propuestos y criterios globales.
- [Decisiones](decisions.md): objetivos aceptados y límites del refactor.
- [Escenarios de aceptación](acceptance.md): comportamiento que debemos conservar,
  pruebas actuales y comprobaciones que faltan.
- [Inventario de superficies](surfaces.json): rutas revisadas, documentos públicos
  y canales WebSocket. Es una instantánea documental, no una política ejecutable.
- [Referencia de rendimiento](performance.md): fixture, comandos, mediciones y límites.
- [Verificación realizada](verification.json): resultados y comprobaciones pendientes.

La referencia pasa 2.139 pruebas (una omitida), lint y build. El ensayo guarda
cinco rondas completas y los smoke tests de escritorio/móvil pasan con API sintética
y CSS de Obsidian 1.14.5. Eso no certifica el runtime real objetivo 1.14.4 ni el
teclado Android. Sus escenarios de aceptación quedan especificados para las fases
que sustituyan los componentes correspondientes.

## Secuencia de implementación

| Fase | Entrega | Puerta de salida |
| --- | --- | --- |
| 0 | Referencia y contrato reproducibles | Suite, build, lint, inventario y cinco rondas de métricas |
| 1 | Composición, contratos y persistencia | Dependencias explícitas, invariantes y lifecycle probados |
| 2 | Identidad y cuenta completas | Local/OIDC, revocación, reauth y cuenta sin bóvedas |
| 3 | Bóvedas y autorización | Resolver común, lifecycle recuperable y política de configuración |
| 4 | Contenido y guardado | Publicación común, versiones y borradores seguros |
| 5 | Comparticiones y eventos | Permisos vigentes en notas abiertas y reconexión segura |
| 6 | Componentes de gestión | Hosts compartidos, sin proxies DOM ni controladores de páginas |
| 7 | Validación y retirada | Rendimiento, fallos, E2E, documentación y un único camino vigente |
| 8 | Historia de entrega | Commits completos sobre upstream, todos verificables |

Cada fase entrega recorridos funcionales completos y retira el camino sustituido.
No es una migración que deje todo el cliente pendiente hasta el final. La historia
actual permanece disponible; no se reescribe antes de estabilizar el resultado.

## Qué significa aceptar una fase

Las pruebas existentes son evidencia útil, no una especificación infalible.
Una prueba eliminada debe relacionarse con el escenario que la sustituye o con
una función retirada de forma explícita. No se impone conservar su número.

Las mediciones HTTP sintéticas no certifican Obsidian real, el teclado Android,
el proveedor OIDC de producción ni seguridad absoluta. Las limitaciones y los
escenarios manuales pendientes están identificados en los documentos enlazados.

No se proponen microservicios, otro contenedor, un ORM o un framework de inyección.
Tampoco una reescritura del shim original o de protocolos criptográficos.

[Revisión de interfaces con y sin bóveda](zero-vault-review.md): escenarios,
correcciones, comando de comparación nativa y límites de la emulación.

[Importación desde carpeta local o ZIP](vault-import.md): asistente, límites,
preferencias permitidas y publicación aislada por usuario.

[Exportación ZIP para el propietario](vault-export.md): contenido físico,
configuración opcional, exclusión de recursos recibidos y descarga acotada.
