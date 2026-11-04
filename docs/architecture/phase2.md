# Fase 2: identidad y cuenta

La fase conserva el contrato funcional de acceso, cuenta y administración, y
separa sus reglas de la frontera general de seguridad. El esquema inicial de la
fase 1 no cambia: las bases creadas con esa fase siguen siendo válidas.

## Responsabilidades

- `features/identity/application/identity.js` contiene los recorridos de cuenta,
  administración, contraseñas y acceso. Recibe puertos de almacenamiento, sesiones,
  proveedor, reloj y verificación de contraseña. No importa SQL, Express, cookies
  ni infraestructura del servidor.
- `features/identity/adapters/identity-store.js` proporciona las proyecciones y
  operaciones de persistencia que esos recorridos necesitan. Las operaciones
  transaccionales, criptográficas y OIDC existentes viven junto a ese adaptador.
- `transport/http/identity/` contiene los controladores de acceso, cuenta,
  administración y OIDC. Valida el formato de entrada y gestiona respuestas,
  cookies, CSRF, límites y metadatos seguros del log. No ejecuta consultas SQL.
- `transport/http/identity/router.js` declara exactamente 24 parejas método/ruta.
  Una operación desconocida se rechaza antes de resolver la sesión.
- `app/create-security.js` ensambla los puertos y sus efectos. La revocación
  durante un borrado de usuario sigue cerrando las conexiones afectadas.

La frontera `auth/http.js` pasa de aproximadamente 1.350 a 749 líneas. Sigue
encargándose de proteger recursos, adjuntos, eventos y operaciones de bóveda:
esas responsabilidades pertenecen a fases posteriores. No se presenta esta
extracción como la reescritura completa de toda la seguridad.

## Autorización independiente del transporte

Cada operación administrativa vuelve a comprobar una sesión real, rol admin y
reautenticación reciente. Los callbacks transaccionales capturan el contexto
original y lo contrastan después de esperas, como el cálculo de una contraseña.
Pasar por una validación HTTP previa no convierte ese contexto en un permiso
duradero.

Los cambios de correo actúan únicamente sobre la cuenta autenticada y rechazan
campos de destinatario o verificación. Se mantiene la verificación exclusiva del
administrador, la pérdida de verificación al cambiar email y la revocación de
sesiones. La ausencia de cambios conserva la verificación existente.

Desvincular la identidad propia exige verificar una contraseña local y conservar
el contexto y la credencial comprobados antes de la espera. No basta con volver
a capturar una sesión diferente después de comprobar la contraseña. Los grants
administrativos y la preparación asíncrona de OIDC también se revalidan.

Se mantiene el umbral de cinco minutos, el aislamiento de identidad por issuer y
subject, los controles de replay y callback, la configuración de transporte OIDC
y los retornos acotados a Ignis. Completar OIDC coordina revocación, sesión recordada
y auditoría en el caso de uso; el controlador solo serializa sus resultados.

## Persistencia y CLI

Los 21 módulos trasladados conservan sus funciones y literales: la comparación AST
contra la referencia previa solo permite diferencias en rutas relativas de imports.
Esto se complementa con la suite funcional; no se considera una prueba suficiente
de seguridad por sí sola.

Las comprobaciones SQL dentro de operaciones transaccionales siguen protegiendo
unicidad, último administrador, cambios concurrentes y revocación. No se han
eliminado para evitar una aparente duplicación con la capa de aplicación.

La CLI sigue siendo una entrada local privilegiada y comparte las operaciones
transaccionales con la aplicación. El valor interno `actorId=null` identifica
exclusivamente al operador local; ningún controlador HTTP lo deriva de una entrada
anónima. Los tests de CLI apuntan a las nuevas ubicaciones, sin fachadas de
compatibilidad en las antiguas.

El helper histórico de registro de bóvedas usado por CLI/fixtures permanece por
ahora junto al bootstrap. No interviene en los recorridos HTTP de identidad; su
ubicación definitiva se resolverá con el catálogo y registro de la fase 3. Las
pruebas históricas permanecen en `auth/` para conservar el mapa de aceptación.

## Controles y límites

`npm run lint` ahora impide que un caso de uso de identidad importe infraestructura,
que sus controladores importen persistencia y que los módulos de identidad
participen en ciclos. No cambian las once dependencias antiguas de UI pendientes
de fase 6.

El generador de inventario toma las operaciones de autenticación del registro
ejecutable en lugar de buscar literales dispersos en `auth/http.js`. Sigue siendo
documentación; no concede permisos ni constituye un registro de todos los schemas
de entrada.

Los casos de uso reciben credenciales opacas y bindings del puerto OIDC; no parsean
headers ni serializan cookies. No se reimplementan criptografía, JWT o descubrimiento.
Las ventanas y la recepción Android no cambian en esta fase.

## Aceptación

Las pruebas específicas nuevas verifican llamadas administrativas directas desde
un usuario normal, expiración exacta de reautenticación, rechazo de campos de
verificación en el correo propio, cambio de sesión/credencial durante password
verification y revocación mientras se prepara OIDC. También comprueban el rechazo
de operaciones no declaradas en el registro HTTP.

Verificación de entrega: 175 archivos, 2.160 pruebas pasadas y una omitida por
requerir el fixture ENOSPC. Lint, reglas de dependencias, filtraciones de errores y
build pasan. Los smoke tests de escritorio y móvil pasan con API sintética y CSS
nativo 1.14.5; una ronda completa del fixture HTTP de carga también termina.
Permanecen las advertencias preexistentes de build sobre eval y ListItem.

Esta ronda de carga comprueba integración, no es una nueva referencia estadística
ni una demostración de mejora de rendimiento. Los smoke tests sintéticos no
certifican un proveedor OIDC real ni el teclado del dispositivo. Las puertas de
aceptación con el runtime completo de Obsidian 1.14.4 siguen vigentes.
