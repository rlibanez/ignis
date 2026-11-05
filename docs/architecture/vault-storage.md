# Almacenamiento de bóvedas por propietario

Las instalaciones nuevas con esquema 3 utilizan:

```text
VAULT_ROOT/
├── roberto/
│   ├── Personal/
│   └── Trabajo/
└── lucia/
    └── Personal/
```

El username normalizado proporciona el nombre del directorio de usuario. El nombre
visible proporciona el segundo nivel. El usuario nunca envía una ruta de destino:
el servidor la deriva del usuario autenticado (o del nuevo propietario validado).
No se admiten separadores, traversal, componentes ocultos ni enlaces simbólicos en
ninguno de los dos niveles, aunque apunten a otra ubicación dentro de VAULT_ROOT.

`vaults.id` conserva el UUID independiente de la ruta. `vaults.name` conserva el
nombre visible y `vaults.directory` la ruta relativa canónica `usuario/bóveda`.
La unicidad de directory reserva el nombre dentro del propietario, no del servidor.
Las membresías, concesiones, destinos compartidos y cachés privadas del navegador
siguen vinculados a UUIDs; el árbol de directorios no concede autorización. Un
administrador tampoco obtiene acceso al contenido por su rol de instancia.

## Ciclo de vida

- Crear e importar asignan siempre la bóveda al usuario autenticado. No sobrescriben
  carpetas existentes, registradas o no. Los directorios nuevos tienen modo 0700.
- Renombrar conserva UUID y permisos y mueve el directorio dentro del propietario.
- Transferir requiere el propietario actual, un miembro activo como destinatario,
  confirmación explícita y la revisión vigente. Rechaza un nombre ocupado en el
  nuevo propietario, reserva ambas rutas, detiene escrituras/watchers y mueve los
  datos antes de publicar la nueva propiedad. El antiguo propietario queda editor;
  los demás miembros y recursos compartidos conservan sus identidades.
- Transferir la bóveda abierta coordina el guardado del editor y el regreso al
  gestor. El servidor anuncia el movimiento a los otros sockets con código 4004;
  reconectan usando el mismo UUID. Se admite un hueco temporal máximo de diez
  segundos, con una única comprobación diferida y sin polling adicional. Si el
  mismo UUID reaparece con el mismo nombre en otra cuenta, se conserva el editor;
  una identidad distinta o una pérdida persistente bloquea el acceso. Los permisos
  del servidor se comprueban durante todo el proceso, sin periodo de gracia.
- Renombrar y transferir requieren desactivar los complementos de servidor de la
  bóveda. Los sockets de la ubicación anterior se cierran y las nuevas aperturas
  por UUID resuelven la ubicación actual. Las operaciones fallidas después de una
  reserva se ponen en cuarentena: no se adivina cuál es la ubicación autorizada.
- Eliminar retira únicamente el UUID seleccionado y utiliza la papelera privada
  común, con nombre interno aleatorio. No afecta a homónimos de otras cuentas.
- Los directorios vacíos de usuario pueden permanecer tras eliminar sus bóvedas.
  No se recorren ni eliminan recursivamente como parte de borrar una cuenta.

## Incorporación y administración manual

El runtime obtiene su catálogo exclusivamente de registros activos cuya ruta física
sea válida. No descubre bóvedas por `.obsidian` ni por enumerar las carpetas de los
usuarios. Crear una carpeta en el servidor no crea identidad ni membresías. Se han
retirado los endpoints de registro directo, su interfaz y el comando register-vault.
El importador desde el dispositivo sigue siendo la única vía para incorporar datos
existentes. La recepción Android mantiene su comportamiento y límites.

Los nombres legibles facilitan inspeccionar y editar archivos en el servidor.
Mover o renombrar carpetas de usuario/bóveda manualmente no actualiza la base de
datos: esas operaciones deben realizarse desde Ignis. La modificación concurrente
por un administrador del host no forma parte del contrato de operaciones del
proceso; las comprobaciones de rutas, identidad e integridad rechazan estados
inseguros detectados. No se siguen enlaces ni se sobrescriben destinos observados.

No se realiza migración del antiguo almacenamiento plano. El esquema 3 exige una
instalación limpia; se conserva el almacenamiento anterior y se utiliza el
importador para incorporar los datos que se quieran recuperar.

## Validación

`auth/vault-storage.test.mjs` cubre homónimos entre cuentas, aislamiento y permisos,
importación, renombrado, transferencia, colisiones, revocación durante el movimiento,
borrado selectivo, rutas inválidas y namespaces enlazados. Las suites del ciclo de
vida mantienen sus pruebas de fallos, cuarentena y recuperación. Las pruebas HTTP,
WebSocket, multiusuario y del navegador utilizan las rutas por propietario y UUIDs.
