import { h } from '../ui.js';

export function Help({ user }) {
  const isAdmin = user.role === 'admin';
  return h(
    'div',
    { className: 'help' },
    h('h2', { className: 'page-title' }, 'Cómo usar la app'),

    h('h3', null, 'Cargar stock'),
    h(
      'ul',
      null,
      h('li', null, 'Elegí el día en la tira de arriba (Lun a Sáb). Por defecto se abre el de hoy.'),
      h('li', null, 'En cada producto escribí la ', h('strong', null, 'entrada'), ' (lo que ingresó) y la ', h('strong', null, 'salida'), ' (lo que se vendió o se retiró). Podés usar coma o punto para los decimales.'),
      h('li', null, 'El ', h('strong', null, 'total'), ' se calcula solo: inicial + entradas − salidas. El total de un día es el inicial del día siguiente.'),
      h('li', null, 'Todo se guarda automáticamente. Podés corregir días anteriores mientras la semana esté abierta.'),
      h('li', null, 'Si un total queda en rojo es porque salió más de lo que había: revisá las cantidades.'),
    ),

    h('h3', null, 'Semanas'),
    h('p', null, 'La semana va de lunes a sábado. El domingo a las 00:00 se cierra sola y se abre la siguiente, que arranca con el stock final de la anterior. Las semanas cerradas quedan en el Historial, solo para consultar.'),

    h('h3', null, 'Sin conexión'),
    h('p', null, 'Si te quedás sin internet podés seguir cargando. Arriba vas a ver "Sin conexión" y la cantidad de cambios pendientes; cuando vuelve la señal se envían solos. Para que funcione, abrí la app al menos una vez con internet. Si cerrás sesión con cambios pendientes, se pierden.'),

    h('h3', null, 'Excel y WhatsApp'),
    h(
      'ul',
      null,
      h('li', null, h('strong', null, 'Excel'), ': descarga la planilla de la semana que estás viendo.'),
      h('li', null, h('strong', null, 'Importar'), ': carga una planilla exportada desde esta app. Las celdas vacías cuentan como 0 y reemplazan lo que había para los productos de la planilla. Si hay un error en alguna fila no se importa nada.'),
      h('li', null, h('strong', null, 'WhatsApp'), ': arma un resumen del día con los movimientos para enviar.'),
    ),

    h('h3', null, 'Alertas'),
    h('p', null, 'Si un producto tiene stock mínimo definido y el stock de hoy baja de ese valor, aparece en la solapa Alertas y marcado como "Bajo mínimo" en la carga.'),

    isAdmin &&
      h(
        'div',
        null,
        h('h3', null, 'Administración'),
        h(
          'ul',
          null,
          h('li', null, h('strong', null, 'Sucursales'), ': cada una tiene su propio stock. No se eliminan, se desactivan.'),
          h('li', null, h('strong', null, 'Usuarios'), ': los empleados ven solo su sucursal. La clave inicial se cambia en el primer ingreso. Si alguien la olvida, reiniciala.'),
          h('li', null, h('strong', null, 'Catálogo'), ': los productos son los mismos para todas las sucursales. Un producto con historial se desactiva, no se elimina.'),
          h('li', null, h('strong', null, 'Stock inicial'), ': en el día Lunes de la carga podés editar el inicial de cada producto (solo admin).'),
          h('li', null, h('strong', null, 'Auditoría'), ': registro de quién hizo qué y cuándo.'),
        ),
      ),
  );
}
