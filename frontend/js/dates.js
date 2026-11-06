// Fechas de negocio ('AAAA-MM-DD'), sin depender de la zona horaria del dispositivo.
const MS_DAY = 24 * 60 * 60 * 1000;

export function addDays(iso, n) {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * MS_DAY).toISOString().slice(0, 10);
}
