# Guía de despliegue

Hay dos formas de publicar Flambo Stock. La **A** es la más simple.

## Importante antes de empezar

- La base es un archivo SQLite: el servidor debe tener **disco persistente** y correr como **una sola instancia**. En un servicio sin disco persistente, los datos se pierden en cada despliegue.
- En producción `JWT_SECRET` es obligatorio (mínimo 32 caracteres). Generá uno:
  `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
- Poné `ADMIN_PASSWORD`: es la clave inicial del usuario `admin`. La app obliga a cambiarla al primer ingreso. Solo se usa cuando la base está vacía.

## Opción A: todo en un servicio (API + app)

El contenedor sirve la API y el frontend juntos, en el mismo dominio: no hace falta CORS ni tocar `config.js`.

### Render
1. Subí el proyecto a un repositorio de GitHub.
2. En Render: **New → Blueprint** y elegí el repositorio (usa `render.yaml`).
3. Cuando lo pida, completá `ADMIN_PASSWORD`. `JWT_SECRET` se genera solo.
4. El plan indicado (Starter) incluye disco persistente de 1 GB montado en `/data`.
5. Abrí la URL que te da Render e ingresá como `admin`.

### Fly.io
```bash
fly launch --no-deploy --copy-config
fly volumes create flambo_data --size 1 --region gru
fly secrets set JWT_SECRET="$(openssl rand -base64 48)" ADMIN_PASSWORD="una-clave-inicial"
fly deploy
```
No escales a más de una máquina.

### Servidor propio (VPS)
Con Docker: `cp .env.example .env`, completalo y `docker compose up -d --build`. Poné delante un proxy con HTTPS (Caddy, Nginx) y dejá `TRUST_PROXY=true`.
Sin Docker: Node ≥ 22.13, `cd backend && NODE_ENV=production JWT_SECRET=… ADMIN_PASSWORD=… DB_PATH=/var/lib/flambo/flambo.db STATIC_DIR=../frontend node --disable-warning=ExperimentalWarning src/server.js`.

## Opción B: frontend en Netlify + API aparte

1. Desplegá la API como en la opción A (puede ser el mismo contenedor; también sirve el frontend, simplemente no lo uses).
2. En el servicio de la API definí `CORS_ORIGIN=https://tu-sitio.netlify.app` (varios, separados por coma).
3. Editá `frontend/config.js`: `window.FLAMBO_CONFIG = { API_URL: 'https://tu-api.onrender.com' };` (sin barra final).
4. Editá `frontend/_headers`: reemplazá `https://TU-API.example.com` por la misma URL. Sin esto, la política de seguridad bloquea las llamadas.
5. En Netlify: **Add new site → Import from Git** (usa `netlify.toml`; publica la carpeta `frontend`, sin comando de build).

## Primer ingreso

1. Entrá como `admin` con `ADMIN_PASSWORD` y elegí una clave nueva.
2. **Administración → Sucursales:** renombrá "Casa Central" o creá las demás.
3. **Administración → Usuarios:** creá los empleados (cada uno con su sucursal). Quedan obligados a cambiar la clave al primer ingreso.
4. **Administración → Catálogo** y **Stock mínimo:** ajustá productos y mínimos.
5. Cargá el stock inicial de la semana desde la pantalla Stock (solo admin).

## Copias de seguridad

```bash
cd backend
DB_PATH=/data/flambo.db npm run backup /data/backups     # copia consistente, con verificación; guarda las últimas 14
```
Programalo una vez por día (cron, o una tarea programada de tu proveedor) y llevá las copias fuera del servidor. Para restaurar: parar el servicio, reemplazar el archivo de la base por la copia y arrancar.
En Fly: `fly ssh console -C "node /app/backend/scripts/backup.js /data/backups"` y `fly ssh sftp get` para bajarlas.

## Mantenimiento

- **Salud:** `GET /api/health` → `{"status":"ok"}`.
- **Cierre de semana:** automático el domingo 00:00 hora local (`TZ_NAME`); si el servidor estaba apagado, se pone al día al volver.
- **Actualizar la app:** desplegá la nueva versión. Los celulares reciben la actualización la próxima vez que abren la app con conexión (service worker).
- **Registro de actividad:** Administración → Auditoría.
- **Intentos de ingreso:** 10 fallidos en 15 minutos por IP bloquean el ingreso temporalmente. Con un proxy, `TRUST_PROXY=true` es necesario para ver la IP real.

## Cuestiones a tener en cuenta

- Las tipografías se cargan desde Google Fonts; sin internet se usa una tipografía del sistema (la app se ve distinta pero funciona).
- Los íconos de la app son los de la versión original; el de 512 px es una ampliación del de 180 px y se ve algo borroso. Reemplazalo por uno de 512 px en `frontend/img/icon-512.png`.
