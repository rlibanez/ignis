# Inventario y alcance de la unificación de interfaces

Revisado el 2026-11-08. La migración se limita a las vistas introducidas por
nuestra implementación. La propuesta inicial mezclaba vistas propias con
superficies heredadas: esa ampliación de alcance se ha descartado.

[Implementación y verificación](ui-unification-delivery.md).

## Vistas propias que se adaptan

| Familia | Superficies |
|---|---|
| Acceso independiente | `/setup`, `/login`, `/reset-password` y sus estados/ayudas |
| Recepción independiente | `/share-target` y creación de recursos auxiliares; se mantiene el protocolo Android |
| Cuenta | Panel de Cuenta, cambiar correo, cambiar contraseña, OIDC, contraseña local y reautenticación |
| Usuarios | Catálogo, crear/editar/eliminar, cierre de sesiones, contraseña temporal y desvinculación |
| Compartición | Catálogo, compartir/gestionar recurso, añadir acceso, ubicación, confirmaciones y panel lateral |
| Copia/recuperación propias | `copy-dialog.js`, acciones de recursos compartidos y recuperación de cambios introducidas por nosotros |
| Acceso a bóvedas | `VaultAccessDialog.svelte`, retirada de acceso y transferencia de propiedad |
| Transferencias | Importación, exclusiones por bóveda, revisión/progreso/errores y exportación |
| Sesión y recuperación | Sesión bloqueada, bóveda no disponible, fallo de inicio, recuperación de borradores, avisos de logout y confirmación de borrado compartido |
| Sin editor | Shell de Ajustes > Cuenta y los mismos formularios sin una bóveda abierta |

Las entradas añadidas al Gestor de bóvedas siguen abriendo estas funciones. No
se cambia el estilo del gestor para adaptarlo a las ventanas que abre.

## Superficies originales que se conservan

- Gestor de bóvedas, sus diálogos existentes de crear, renombrar y eliminar.
- `Modal`, `PromptDialog`, `ConfirmDialog`, `MessageDialog` e `InsecureContextModal`
  del shell original.
- `Button`, `SearchInput` y `PopoverMenu` originales.
- Headless Sync y sus formularios/listas.
- Editores originales de exclusiones y reglas (`ExcludedFoldersEditor`,
  `IgnoreRulesEditor`, `RecordEditor`, `RuleSetCard`, `SuggestionRow`).
- Aviso original del proxy y selección original del modo móvil del shim.
- Ajustes, modales, controles y CSS distribuidos por Obsidian.

Los 19 archivos restaurados de estas familias son idénticos byte por byte al HEAD
previo a esta tarea (`554a612`). Esa referencia ya contiene las funcionalidades
propias previamente aprobadas: no se revierte el gestor entero al upstream ni se
eliminan opciones añadidas o traducciones anteriores.

## Contrato de presentación

- Si el editor está iniciado, nuestras ventanas usan clases exportadas reales de
  Obsidian: `Modal`, controles de texto, selector, botón y `Notice`.
- Sin editor se reutilizan controladores y vistas con un host HTML independiente
  que consume el CSS instalado. No se inicia una bóveda ficticia.
- Checkboxes, archivos, árboles, tablas y asistentes conservan sus primitivas y
  lógica de producto cuando no existe un equivalente nativo adecuado.
- Los adaptadores Svelte propios están en `components/management`; no sustituyen
  los componentes originales importados por otras vistas.
- Los estilos nuevos se limitan a raíces/clases de nuestras ventanas. Los avisos
  propios que deben aparecer sobre el gestor usan una capa separada; no se eleva
  ni modifica el contenedor de avisos original de Obsidian.
- No se cambian autorización, reautenticación, API de negocio o recepción Android.

## Aceptación

1. Igualdad de los archivos originales con la referencia previa.
2. Pruebas de estilos calculados, con nuestros estilos activados/desactivados,
   sobre el gestor, diálogos y editores originales: misma geometría y apariencia.
3. Lo mismo con modales, controles y avisos reales de Obsidian; comprobar además
   que un aviso propio no modifica el contenedor de avisos original.
4. Nuestros formularios con y sin editor: validación, foco, cancelación, sesión
   perdida, ayudas, tamaños y acciones en escritorio y móvil.
5. Flujos reales de compartición, permisos, copia, importación, exportación y
   transferencia de propiedad. Las pruebas móviles usan emulación de Chrome.
