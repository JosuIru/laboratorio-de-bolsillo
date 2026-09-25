/**
 * Serie cruda del acelerómetro en CSV: tiempo relativo a la primera muestra y los tres ejes
 * en m/s² (gravedad incluida). Es lo que permite reanalizar la medición fuera de la app.
 */
export function formatAccelerationSeriesCsv(
  timestampsSeconds: ArrayLike<number>,
  xValues: ArrayLike<number>,
  yValues: ArrayLike<number>,
  zValues: ArrayLike<number>,
): string {
  const csvLines = ['time_s,acceleration_x_m_s2,acceleration_y_m_s2,acceleration_z_m_s2'];
  const firstTimestampSeconds = timestampsSeconds[0] ?? 0;
  for (let sampleIndex = 0; sampleIndex < timestampsSeconds.length; sampleIndex++) {
    csvLines.push(
      [
        (timestampsSeconds[sampleIndex]! - firstTimestampSeconds).toFixed(6),
        xValues[sampleIndex]!.toFixed(5),
        yValues[sampleIndex]!.toFixed(5),
        zValues[sampleIndex]!.toFixed(5),
      ].join(','),
    );
  }
  return csvLines.join('\n') + '\n';
}
