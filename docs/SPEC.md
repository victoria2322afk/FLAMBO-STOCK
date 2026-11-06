# Flambo Stock — Especificación

Versión 1.0 · Documento de referencia para backend, frontend y pruebas. El contrato de la API está en `openapi.yaml` (una prueba automática verifica que coincida con las rutas reales).

## 1. Propósito

Flambo Stock reemplaza la planilla/app local de control de stock de la panadería. Registra, por sucursal y por día de una semana de trabajo (lunes a sábado), las **entradas** y **salidas** de cada producto, y calcula el **total** arrastrando el stock de un día al siguiente. Hoy los datos viven solo en el navegador de un celular; la nueva versión los centraliza en un servidor, con usuarios, varias sucursales, historial, alertas y reportes.

## 2. Alcance

Incluye:

- Login real con usuarios y roles (admin / empleado).
- Varias sucursales con stock independiente.
- Catálogo único de productos, gestionado por el admin.
- Carga de entradas y salidas por día, con cálculo automático de totales.
- Cierre automático de semana cada domingo y apertura de la siguiente.
- Historial de semanas cerradas (solo lectura).
- Alertas por stock mínimo por producto y sucursal.
- Reportes y gráficos.
- Exportar e importar planilla Excel.
- Compartir resumen por WhatsApp.
- App instalable (PWA) con carga sin conexión y sincronización posterior.
- Registro de auditoría de cambios.

No incluye (fuera de alcance v1): precios y facturación, proveedores, recetas, notificaciones push, multi-idioma (la interfaz es en español rioplatense).

## 3. Roles y permisos

| Acción | Admin | Empleado |
|---|---|---|
| Iniciar sesión, cambiar su propia clave | Sí | Sí |
| Ver y cargar stock | Todas las sucursales | Solo su sucursal |
| Editar días anteriores de la semana abierta | Sí | Sí (su sucursal) |
| Editar semanas cerradas | No | No |
| Ver historial y reportes | Todas las sucursales | Solo su sucursal |
| Definir stock mínimo | Sí | No |
| Crear/editar/desactivar productos y grupos | Sí | No |
| Crear/editar/desactivar sucursales | Sí | No |
| Crear/editar/desactivar usuarios, resetear claves | Sí | No |
| Ver registro de auditoría | Sí | No |
| Importar Excel | Sí | Sí (su sucursal, semana abierta) |
| Exportar Excel, compartir por WhatsApp | Sí | Sí |

Un empleado siempre está asignado a exactamente una sucursal. Un admin no tiene sucursal fija.

## 4. Reglas de negocio

1. **Semana de trabajo.** Lunes a sábado (índices de día 0 a 5: Lunes, Martes, Miércoles, Jueves, Viernes, Sábado). Cada semana pertenece a una sucursal y se identifica por la fecha de su lunes (`start_date`, formato `YYYY-MM-DD`).
2. **Zona horaria.** Todas las fechas se calculan en `America/Argentina/Buenos_Aires` (configurable con `TZ_NAME`).
3. **Total diario.** Para un producto y un día `d`: `total[d] = inicial[d] + entrada[d] − salida[d]`, donde `inicial[0]` es el stock inicial de la semana e `inicial[d] = total[d−1]` para `d > 0`. Los totales pueden ser negativos y se muestran resaltados.
4. **Stock inicial.** Se guarda por producto en cada semana. Para la primera semana de una sucursal es 0 salvo que el admin lo cargue. Para las semanas siguientes es el total del sábado de la semana anterior.
5. **Entradas y salidas.** Números decimales mayores o iguales a 0, hasta 3 decimales, máximo 100000. Vacío equivale a 0.
6. **Cierre automático.** El domingo a las 00:00 (hora local) toda semana abierta con `start_date + 6 días ≤ hoy` se cierra y se abre la semana siguiente (lunes `start_date + 7`) con el stock inicial igual al total final de la semana cerrada. El cierre corre en un proceso programado cada 15 minutos y también se verifica de forma perezosa en cada consulta, de modo que un servidor apagado el domingo se pone al día al volver. Si pasaron varias semanas sin uso, se cierran todas en orden (con movimientos en cero) hasta llegar a la semana vigente.
7. **Semana cerrada.** Es de solo lectura. Cualquier intento de modificarla devuelve `409`.
8. **Catálogo compartido.** Grupos y productos son globales. Cada producto tiene un `code` entero único. Desactivar un producto lo oculta de la carga pero conserva su historial. Eliminar no está permitido si tiene movimientos.
9. **Productos nuevos.** Al crear un producto, aparece en las semanas abiertas con stock inicial 0.
10. **Stock mínimo.** Valor opcional por producto y sucursal. Hay alerta cuando el stock actual es menor al mínimo. El stock actual es el total del día vigente (si hoy es domingo, el del sábado).
11. **Auditoría.** Cada alta, modificación, baja, importación, cierre de semana e inicio de sesión fallido relevante queda registrado con usuario, sucursal, fecha y detalle.
12. **Sincronización offline.** Los cambios se aplican con "gana el último en escribir" por celda (producto + día), usando el instante del cambio en el cliente. El instante del cliente se limita a ahora + 5 minutos para que un reloj adelantado no gane siempre. Si la semana ya se cerró cuando llega el cambio (409 `week_closed`), el cambio se descarta y se avisa al usuario; también se descartan los rechazos 400/403/404.
14. **Importar Excel.** Todo o nada: si una fila es inválida no se aplica nada. Para los productos presentes en el archivo, una celda vacía equivale a 0 y pisa el valor guardado; los códigos desconocidos solo generan avisos. El stock inicial del archivo lo aplica únicamente el admin (para un empleado se ignora y se informa). No se crean filas con valores en cero.
15. **Usuarios.** Un usuario no puede desactivarse ni quitarse el rol admin a sí mismo. La clave inicial del admin y toda clave restablecida obligan a cambiarla en el siguiente ingreso: mientras tanto la API responde 403 `password_change_required` salvo `/auth/me` y `/auth/change-password`.
16. **Productos inactivos.** Se ocultan de la carga, salvo en las semanas donde ya tienen datos.
13. **Claves.** Mínimo 8 caracteres. Se guardan con hash scrypt (`scrypt$N$r$p$sal$hash`, módulo `crypto` de Node). Tras 10 intentos fallidos en 15 minutos desde una misma IP, el login se bloquea temporalmente.

## 5. Modelo de datos (SQLite)

```
branches(id PK, name UNIQUE, active, created_at)
users(id PK, username UNIQUE, name, password_hash, role CHECK(admin|employee),
      branch_id FK NULL, active, must_change_password, created_at)
product_groups(id PK, name UNIQUE, sort_order)
products(id PK, code INT UNIQUE, name, group_id FK, active, created_at)
min_stock(branch_id FK, product_id FK, min_qty REAL, PK(branch_id, product_id))
weeks(id PK, branch_id FK, start_date TEXT, status CHECK(open|closed),
      closed_at, UNIQUE(branch_id, start_date))
week_initial_stock(week_id FK, product_id FK, qty REAL, PK(week_id, product_id))
movements(week_id FK, product_id FK, day_index INT 0..5, entrada REAL, salida REAL,
          updated_at, updated_by FK, PK(week_id, product_id, day_index))
audit_log(id PK, user_id FK NULL, branch_id FK NULL, action, entity, entity_id,
          detail JSON, created_at)
```

Índices: `weeks(branch_id, status)`, `movements(week_id)`, `audit_log(created_at)`.

## 6. API

Todas las rutas cuelgan de `/api`, usan JSON y requieren `Authorization: Bearer <token>` salvo login y health (el import de Excel recibe el archivo como cuerpo binario). El contrato completo está en `openapi.yaml`. Resumen:

- Autenticación: `POST /auth/login`, `GET /auth/me`, `POST /auth/change-password`.
- Sucursales: `GET/POST /branches`, `PATCH /branches/:id`.
- Usuarios (admin): `GET/POST /users`, `PATCH /users/:id`, `POST /users/:id/reset-password`.
- Catálogo: `GET /catalog`, `POST/PATCH/DELETE /groups`, `POST/PATCH/DELETE /products` (un producto con historial solo se desactiva).
- Stock mínimo (admin): `GET/PUT /branches/:id/min-stock`.
- Semanas: `GET /branches/:id/weeks` (historial), `GET /branches/:id/weeks/current`, `GET /weeks/:id`.
- Movimientos: `PUT /weeks/:id/movements` (lote idempotente), `PUT /weeks/:id/initial-stock` (admin).
- Alertas: `GET /branches/:id/alerts`.
- Reportes: `GET /reports/week-summary`, `/reports/top-products`, `/reports/trend`, `/reports/compare-weeks`.
- Excel: `GET /weeks/:id/export.xlsx`, `POST /weeks/:id/import`.
- Auditoría (admin): `GET /audit`.
- Salud: `GET /health`.

Errores: `{ "error": { "code": "…", "message": "…" } }` con códigos HTTP 400 (validación), 401, 403, 404, 409 (semana cerrada o duplicado), 429.

## 7. Frontend

- Aplicación de una página (React 18 incluido en el repositorio, módulos ES nativos, **sin paso de compilación**), mobile first, con el diseño crema/miel actual de Flambo (tipografías Fraunces, Space Grotesk y JetBrains Mono).
- Pantallas: Login, Stock (tira de días, búsqueda, tarjetas por producto con Entrada/Salida/Total, barra inferior de resumen), Historial, Reportes, Alertas, Administración (sucursales, usuarios, catálogo, stock mínimo, auditoría), Ayuda.
- Selector de sucursal para admin; el empleado ve solo la suya.
- PWA: instalable, con caché de la aplicación y de la última semana consultada; cola de cambios pendientes con indicador de estado (en línea / sin conexión / sincronizando / N pendientes).
- Exportar/Importar Excel y compartir resumen por WhatsApp (`https://wa.me/?text=…`).

## 8. Requisitos no funcionales

- Seguridad: hash scrypt, JWT HS256 propio con vencimiento de 12 horas (`TOKEN_TTL_SECONDS`), cabeceras de seguridad y Content-Security-Policy estricta (sin `unsafe-inline`), CORS restringido a `CORS_ORIGIN`, validación de entrada propia, consultas SQL parametrizadas, protección contra recorrido de rutas en archivos estáticos, límite de tamaño de cuerpo (`MAX_BODY_BYTES`).
- Sin dependencias externas: el backend usa solo Node.js ≥ 22.13 (`node:http`, `node:sqlite`, `crypto`, `zlib`); no hay `npm install`.
- Rendimiento: respuesta de la pantalla de stock en menos de 300 ms para 100 productos.
- Persistencia: SQLite en modo WAL, archivo configurable con `DB_PATH`. Copia de seguridad consistente con `npm run backup` (usa `VACUUM INTO`, verifica la integridad y rota las últimas 14 copias). SQLite exige una única instancia del servidor.
- Calidad: pruebas automatizadas del backend con el runner nativo de Node.
- Fechas del registro de auditoría: los filtros `from`/`to` se interpretan en UTC.
- Operación: contenedor Docker (la imagen no pudo construirse en el entorno de desarrollo; sus pasos se ensayaron a mano), variables de entorno documentadas, endpoint `/api/health`.

## 9. Criterios de aceptación

1. Un empleado de la sucursal A no puede ver ni modificar datos de la sucursal B (403).
2. Cargar entrada 10 y salida 4 el lunes sobre inicial 5 muestra total 11 el lunes y se arrastra como inicial del martes.
3. Un cambio sobre una semana cerrada devuelve 409 y no altera datos.
4. Pasado el domingo, la semana anterior queda cerrada y la nueva abre con el stock inicial correcto.
5. Un producto por debajo de su mínimo aparece en alertas.
6. Un lote de movimientos enviado dos veces deja el mismo resultado.
7. Exportar y reimportar una semana reproduce los mismos valores.
8. Sin conexión se puede cargar stock; al volver internet los cambios se sincronizan.
9. Solo el admin puede crear usuarios, productos y sucursales.
10. La clave inicial del admin obliga a cambiarla en el primer ingreso.

## 10. Estructura del repositorio

```
backend/    API (src/, scripts/backup.js, test/)
frontend/   app web estática (index.html, js/, css/, sw.js, manifest)
e2e/        prueba de punta a punta con navegador real (Playwright)
docs/       SPEC, OpenAPI, guía de despliegue, manual de usuario
Dockerfile, docker-compose.yml, render.yaml, fly.toml, netlify.toml
```

## 11. Catálogo inicial (migración)

El alta inicial (automática al arrancar con la base vacía, o `npm run seed`) carga los grupos y productos de la app anterior: Bizcochos sueltos, Cajas x8, Frola y Ricota, Otros, Cumpleaños y Premium, con sus códigos originales; una sucursal "Casa Central" y un usuario admin cuyo nombre y clave inicial se toman de `ADMIN_USER` y `ADMIN_PASSWORD`.
