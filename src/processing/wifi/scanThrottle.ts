/**
 * Android (9+) permite a una app en primer plano 4 escaneos Wi‑Fi cada 2 minutos; los demás
 * los rechaza en silencio. Llevar la cuenta aquí permite decir al usuario cuándo podrá repetir.
 */

export const maximumScansPerWindow = 4;
export const scanThrottleWindowMilliseconds = 120_000;

/** Solo los escaneos que siguen dentro de la ventana. */
export function pruneScanTimestamps(scanTimestampsMilliseconds: readonly number[], nowMilliseconds: number): number[] {
  return scanTimestampsMilliseconds.filter(
    (scanTimestamp) => nowMilliseconds - scanTimestamp < scanThrottleWindowMilliseconds,
  );
}

/** Milisegundos hasta poder escanear otra vez (0 = ya). */
export function millisecondsUntilNextScan(
  scanTimestampsMilliseconds: readonly number[],
  nowMilliseconds: number,
): number {
  const recentScans = pruneScanTimestamps(scanTimestampsMilliseconds, nowMilliseconds).sort(
    (first, second) => first - second,
  );
  if (recentScans.length < maximumScansPerWindow) return 0;
  const oldestBlockingScan = recentScans[recentScans.length - maximumScansPerWindow]!;
  return Math.max(0, oldestBlockingScan + scanThrottleWindowMilliseconds - nowMilliseconds);
}
