/**
 * Forma de onda cruda de la estación en CSV, con el tiempo contado desde el golpe de
 * sincronización (la misma escala que la hora de llegada que se muestra en pantalla).
 */
export function formatStationWaveformCsv(
  timestampsSeconds: ArrayLike<number>,
  xValues: ArrayLike<number>,
  yValues: ArrayLike<number>,
  zValues: ArrayLike<number>,
  syncTimestampSeconds: number,
): string {
  const csvLines = ['time_since_sync_s,acceleration_x_m_s2,acceleration_y_m_s2,acceleration_z_m_s2'];
  for (let sampleIndex = 0; sampleIndex < timestampsSeconds.length; sampleIndex++) {
    csvLines.push(
      [
        (timestampsSeconds[sampleIndex]! - syncTimestampSeconds).toFixed(6),
        xValues[sampleIndex]!.toFixed(5),
        yValues[sampleIndex]!.toFixed(5),
        zValues[sampleIndex]!.toFixed(5),
      ].join(','),
    );
  }
  return csvLines.join('\n') + '\n';
}
