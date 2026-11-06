# Manual de uso — Flambo Stock

## Para todos

### Ingresar
Abrí la app con tu usuario y clave. La primera vez (o si el administrador te restableció la clave) la app te pide elegir una clave nueva de al menos 8 caracteres. Si te equivocás muchas veces seguidas, el ingreso se bloquea unos minutos.

En el celular podés instalarla desde el menú del navegador ("Agregar a la pantalla de inicio") y abrirla como cualquier app.

### Cargar stock
1. En **Stock** elegí el día con la tira de Lun a Sáb (por defecto, hoy). Podés cargar cualquier día de la semana abierta.
2. Cada producto tiene **Entrada** (lo que ingresa o producís), **Salida** (lo que sale o se vende) y **Total** (se calcula solo).
3. Escribí las cantidades con coma o punto (por ejemplo `2,5`). Vacío es 0.
4. El total de cada día se arrastra al día siguiente: lo que sobra el lunes es el inicial del martes, y el del sábado es el inicial de la semana siguiente.
5. Un total negativo se resalta: suele indicar una salida cargada de más o una entrada que falta.
6. Usá la búsqueda para encontrar un producto; la barra inferior resume el día.

Los cambios se guardan solos. El indicador de estado muestra **Al día**, **N pendientes**, **Enviando…** o **Sin conexión**.

### Sin conexión
Si se corta internet podés seguir cargando: los cambios quedan en tu dispositivo y se envían solos al volver la conexión. Si cerrás sesión con cambios pendientes, la app te avisa para que no los pierdas. Si una semana se cerró mientras estabas sin conexión, esos cambios ya no pueden aplicarse y la app te lo informa.

### Semanas
Van de lunes a sábado y **se cierran solas el domingo a las 00:00**. La semana nueva empieza con el stock con el que terminó la anterior. Las semanas cerradas se ven en **Historial** pero no se pueden modificar.

### Alertas
**Alertas** lista los productos cuyo total de hoy está por debajo del mínimo definido por el administrador (los domingos se usa el total del sábado). El número en el menú indica cuántos hay.

### Historial y reportes
- **Historial:** semanas anteriores de tu sucursal, con detalle y descarga.
- **Reportes:** *Resumen* de una semana, *Más vendidos* (por salidas), *Tendencia* de entradas y salidas semana a semana, y *Comparar* dos semanas.

### Excel y WhatsApp
- **Excel:** descarga la planilla de la semana que estás viendo.
- **Importar:** carga una planilla exportada desde esta app. Se valida todo antes de aplicar: si algo está mal no se cambia nada y la app explica qué corregir. Atención: para los productos que están en el archivo, una celda vacía cuenta como 0 y reemplaza lo guardado. Solo se puede importar en la semana abierta.
- **WhatsApp:** comparte un resumen de texto para enviar a quien quieras.

### Agregar un producto
Lo agrega el administrador desde **Admin → Catálogo**, y queda disponible para todas las sucursales.

## Para administradores

Además de lo anterior, el administrador ve todas las sucursales (selector arriba) y tiene la sección **Admin**:

- **Sucursales:** crear, renombrar, desactivar. Una sucursal nueva empieza con stock inicial 0; cargalo desde Stock (solo el administrador puede editar el stock inicial de la semana).
- **Usuarios:** crear con rol *empleado* (una sola sucursal) o *administrador*; editar, desactivar y restablecer la clave (la persona deberá cambiarla al ingresar). No podés desactivarte ni quitarte el rol de administrador a vos mismo.
- **Catálogo:** productos y grupos. Un producto con historial no se elimina: se desactiva (deja de aparecer para cargar, salvo en las semanas donde ya tiene datos). Un grupo solo se elimina si está vacío.
- **Stock mínimo:** por producto y sucursal; vacío = sin alerta.
- **Auditoría:** quién hizo qué y cuándo; se puede filtrar por usuario, sucursal, acción y fechas (las fechas se interpretan en UTC).

### Buenas prácticas
- Cambiá la clave inicial en el primer ingreso y no compartas usuarios: la auditoría registra quién cargó cada cosa.
- Desactivá a quien deje de trabajar: pierde el acceso de inmediato.
- Hacé copias de seguridad periódicas (ver la guía de despliegue).

## Problemas frecuentes

| Situación | Qué hacer |
|---|---|
| "Sin conexión" | Seguí cargando; se sincroniza al volver. |
| No puedo editar una semana | Está cerrada. Es de solo lectura. |
| Olvidé mi clave | Pedile al administrador que la restablezca. |
| El ingreso está bloqueado | Esperá unos minutos (límite de intentos fallidos). |
| La importación falla | Usá una planilla exportada desde la app y respetá el código de cada producto. |
