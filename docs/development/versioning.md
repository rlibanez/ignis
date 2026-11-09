# Versionado del fork

La versión propia comienza en **1.0.0** y se mantiene en `package.json` y en las
entradas raíz de `package-lock.json`. Los paquetes privados conservan su versión
interna. La base upstream se registra por separado en `package.json > ignis.upstream`
(versión y repositorio). La versión de Obsidian se lee del runtime instalado.

## Versión y compilación

Ignis muestra `1.0.0` en la interfaz, el registro de arranque y `/api/version`.
Ajustes > General enlaza a la release `v1.0.0`. El Gestor de bóvedas
incluye las referencias de versión a upstream y Obsidian.

Cada compilación genera un sello independiente para la caché de recursos.
Los manifiestos de plugins usan el formato SemVer `1.0.0+build`.

## Docker

```sh
docker compose up -d --build
```

Docker ejecuta Node y npm dentro de la etapa de compilación. Las imágenes
publicadas usan la versión del fork como etiqueta, por ejemplo
`rlibanez/ignis:1.0.0`.

Compose usa `IGNIS_VERSION` para la etiqueta y la comprueba contra
`package.json` al construir. El valor por defecto es `1.0.0`. Al subir la
versión del fork, actualiza el valor por defecto en los archivos Compose.

Al integrar una nueva versión de upstream, actualiza `ignis.upstream` en
`package.json`.
