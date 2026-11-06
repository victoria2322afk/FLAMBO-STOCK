# Flambo Stock

Control de stock para panaderías: entradas, salidas y total por producto y por día (lunes a sábado), con varias sucursales, usuarios, alertas de stock mínimo, historial, reportes, Excel y WhatsApp. Funciona en el celular como app instalable y permite cargar sin conexión.

- **Backend:** Node.js ≥ 22.13 **sin dependencias** (no hay `npm install`). Base SQLite.
- **Frontend:** página estática (React incluido en el repositorio, sin compilar).
- **Un solo servicio** puede servir la API y la app, o el frontend puede ir aparte (Netlify).

## Probarlo en tu computadora

Requisitos: Node.js 22.13 o más nuevo.

```bash
cd backend
ADMIN_PASSWORD=ClaveInicial123 STATIC_DIR=../frontend npm start
```

Abrí http://localhost:3000 e ingresá con usuario `admin` y esa clave. La app te pedirá cambiarla. La primera vez se crea la base (`backend/data/flambo.db`) con el catálogo de productos original y la sucursal "Casa Central".

Sin `ADMIN_PASSWORD`, el servidor genera una al azar y la muestra una sola vez en la consola.

## Con Docker

```bash
cp .env.example .env     # completá JWT_SECRET y ADMIN_PASSWORD
docker compose up -d --build
```

> La imagen no se pudo construir en el entorno donde se desarrolló (no había Docker). Se ensayaron a mano los mismos pasos del `Dockerfile`, pero conviene verificar el primer build.

## Publicarlo en internet

Ver [docs/DEPLOY.md](docs/DEPLOY.md) (Render o Fly para la API, Netlify opcional para el frontend, copias de seguridad).

## Documentación

| Documento | Para qué |
|---|---|
| [docs/MANUAL.md](docs/MANUAL.md) | Manual para empleados y administradores |
| [docs/SPEC.md](docs/SPEC.md) | Especificación: reglas de negocio, datos, permisos |
| [docs/openapi.yaml](docs/openapi.yaml) | Contrato de la API |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Puesta en producción y mantenimiento |

## Pruebas

```bash
cd backend && npm test            # pruebas de la API (sin dependencias)
```

La prueba de punta a punta con navegador real está en `e2e/run.cjs`; necesita Playwright con Chromium instalado (no es parte de la app):

```bash
node e2e/run.cjs
```

## Estructura

```
backend/    API: src/ (rutas, servicios, base, Excel), scripts/backup.js, test/
frontend/   index.html, js/ (pantallas, offline, API), css/, sw.js, manifest
e2e/        prueba de punta a punta
docs/       SPEC, OpenAPI, DEPLOY, MANUAL
```

## Variables de entorno principales

`JWT_SECRET` (obligatoria en producción, ≥ 32 caracteres), `ADMIN_PASSWORD`, `ADMIN_USER`, `PORT`, `DB_PATH`, `TZ_NAME`, `CORS_ORIGIN`, `TRUST_PROXY`, `STATIC_DIR`. Lista completa comentada en [.env.example](.env.example).
