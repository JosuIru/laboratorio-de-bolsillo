/** Duración como «1:05:09» o «5:09» (horas solo si las hay). */
export function formatCycleDuration(totalSeconds: number): string {
  const roundedSeconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(roundedSeconds / 3600);
  const minutes = Math.floor((roundedSeconds % 3600) / 60);
  const seconds = roundedSeconds % 60;
  const paddedSeconds = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}` : `${minutes}:${paddedSeconds}`;
}

/** Fecha y hora locales «2026-09-26 10:05», para guardar en la medición de forma legible. */
export function formatLocalDateTime(date: Date): string {
  const twoDigits = (numericValue: number) => String(numericValue).padStart(2, '0');
  return (
    `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())} ` +
    `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`
  );
}

/** Solo la hora local, «10:05». */
export function formatLocalTime(date: Date): string {
  return formatLocalDateTime(date).slice(11);
}
