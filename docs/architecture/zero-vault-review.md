# Revisión de interfaces con y sin bóveda

La revisión compara Obsidian 1.14.4 real (Modal, Settings y ButtonComponent) con
el host del gestor de bóvedas. Se crean cuentas y bóvedas temporales; una de las
cuentas administradoras no tiene ninguna bóveda. Los assets privados se leen sin
modificarlos. No se ejecutan comandos de Git que alteren el historial.

## Correcciones

- El host común deja de imponer el 90dvh que anulaba la altura nativa del diálogo.
- El host sin bóveda activa las mismas barras de desplazamiento del estilo base:
  sus controles ya no pierden tres píxeles adicionales cuando aparece scroll.
- Cuenta usa el encabezado móvil nativo, sin reservar otra fila de 64px encima.
- Su adaptación de `setWarning()` utiliza `mod-destructive` y `mod-cta`, como
  ButtonComponent de 1.14.4, en lugar de sustituirlo por `mod-warning`.
- Los botones auxiliares, Cancelar y los envíos de los formularios de cuenta
  reciben su `type` explícitamente. Obsidian createEl no aplica esa opción a un
  botón como nuestro host alternativo; un botón auxiliar podía intentar enviar.
- Usuarios, recursos compartidos y creación de contraseña local respetan también
  el límite nativo de Ajustes cuando se abren sin una ventana de Ajustes detrás.
- Las hojas HTML calculan su posición de maquetación sin usar la traslación de
  apertura del modal nativo. Esa posición temporal podía dejarlas fuera de pantalla.
- Los avisos flotantes usan el contenedor nativo de notificaciones y mantienen
  el orden de capas modal / aviso / ayuda por encima del gestor de bóvedas.
  El fondo de la capa modal hereda también el color del tema nativo.
- Las confirmaciones móviles usan acción arriba, Cancelar abajo y ancho completo.
  La comparación entre hosts por sí sola no detectaba que ambos compartían el
  mismo error; ahora también se comprueba el estándar de botones móviles.

## Pruebas

```sh
IGNIS_E2E_OBSIDIAN_ASSETS=/ruta/privada/obsidian-1.14.4 npm run test:management-parity
```

Requiere Chrome (`IGNIS_CHROME_PATH` opcional). Se ejecuta en escritorio bajo
780×437, escritorio grande 2560×1440, móvil 390×844, móvil estrecho 360×800 y
rotación a 844×390 tras iniciar en móvil. La rotación conserva el modo móvil de
Obsidian, igual que una sesión de teléfono que cambia de orientación.

`IGNIS_PARITY_OUTPUT=/directorio/temporal` conserva capturas y las medidas de cada
estado. No se guardan valores de inputs, tokens ni las respuestas de sesión. Los
nombres, correos y recursos mostrados son datos sintéticos de esta prueba.

El harness compara tamaños, posiciones, tipografías, padding, colores y estados
semánticos de los controles de formularios. Exige ausencia de desbordamiento
horizontal, límites de ancho nativos, pies móviles de ancho completo y Cancelar
al final. Comprueba ayudas dentro del viewport, cierre con X, foco, botones
auxiliares sin submit, bloqueo durante peticiones y acceso mediante coordenadas
a varios botones de cancelación después de hacer scroll. No acepta excepciones
JavaScript sin capturar. Las transiciones se dejan terminar y se normaliza el
resaltado transitorio `mobile-tap` antes de comparar estilos en reposo.

Los estados comprenden Cuenta; correo y contraseña; errores de credenciales y
confirmación; desvinculación OIDC; listas de usuarios y recursos; crear, editar y
eliminar usuarios; borrado empezado y error de vista previa; cerrar sesiones;
contraseña temporal y mensaje de copiado; contraseña local propia y administrada;
reautenticación; compartir, gestionar, añadir acceso y dejar de compartir;
ubicación con árbol, sin asignación y sin bóvedas; errores al guardar, estados
vacíos, fallos de carga y peticiones pendientes. El resumen medido de la ejecución
queda en `zero-vault-verification.json`.

El mismo comando sigue ejercitando login por formulario, el editor y el guardado
reales, cambios de permisos y revocación antes de la comparación. Durante la
matriz de presentación se interceptan únicamente las API de gestión con las
mismas respuestas controladas en ambos navegadores: errores, OIDC y operaciones
destructivas no se envían al servidor. La autorización real se comprueba por la
suite de seguridad y el E2E anterior, no por estas respuestas simuladas.

El estado «Copiado» se inyecta para comparar su geometría: no se escribe en el
portapapeles del equipo. No se certifican un proveedor OIDC externo, el teclado
Android, la hoja del sistema para compartir, todos los temas comunitarios ni
cada gesto físico mediante la emulación. La comparación fija el mismo tema base
en ambos hosts; una bóveda puede configurar un tema distinto. CI ejecuta esta
matriz en el job opcional con assets privados, sin distribuirlos en el repositorio.

Validación local: 53 estados por cada una de las cinco resoluciones, incluidos
la vinculación y el aviso flotante: 265 comparaciones entre hosts.
La suite general pasa con 2.176 pruebas y una omitida; se mantiene la comprobación
separada de fallos ENOSPC en contenedor. La configuración de CI queda preparada,
pero no se afirma que se haya ejecutado ya en GitHub.

## Seguimiento: validación de Cambiar contraseña

Los avisos de confirmación distinta y contraseña actual incorrecta se presentan
con `setCustomValidity`/`reportValidity` en su input correspondiente. El código
PASSWORD_POLICY se muestra en la contraseña nueva, no como error de sesión. El
texto español para INVALID_PASSWORD es «Contraseña actual incorrecta.». Escribir
en el formulario limpia los errores anteriores; no se añade texto a su layout.

Se verifican respuestas HTTP reales para INVALID_PASSWORD y PASSWORD_POLICY,
conservando la sesión tras el rechazo. La matriz añade el error de requisitos y
comprueba que ni el rectángulo del modal ni los de sus botones cambian con esos
avisos: 54 estados pasan en escritorio y móvil, con y sin bóveda. El resumen JSON
anterior conserva la evidencia original de 53 estados en cinco resoluciones;
no se presenta esa ejecución histórica como una medición nueva de este añadido.

«Confirm your identity» utiliza también el aviso nativo del campo Contraseña
para los errores de reautenticación local, incluido el límite de intentos.
El aviso de contraseña incorrecta se limpia al escribir y al cerrar/reabrir.
La comparación con y sin bóveda confirma que ni el modal ni sus botones se mueven;
los 54 estados pasan en escritorio y móvil tras este cambio.
