import { Canvas, Line, Path, Skia, vec } from '@shopify/react-native-skia';
import { useMemo, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';

import { useThemePalette } from '@/ui/theme';

export interface ChartSeries {
  /** Se leen `sampleCount` valores empezando en `startIndex`. */
  values: ArrayLike<number>;
  color: string;
  startIndex?: number;
  sampleCount?: number;
}

export type ChartVerticalRange =
  /** Simétrico alrededor de 0, con un mínimo para que el ruido no llene la pantalla. */
  | { mode: 'symmetric'; minimumHalfRange: number }
  /** De 0 al máximo de los datos (espectros). */
  | { mode: 'from-zero'; minimumMaximum: number }
  | { mode: 'fixed'; minimum: number; maximum: number };

interface SignalChartProps {
  series: readonly ChartSeries[];
  height: number;
  verticalRange: ChartVerticalRange;
  /** Cambia cuando cambian los datos (los arrays se reutilizan y mutan). */
  revision: number;
  unitLabel?: string;
  /** Etiquetas del eje horizontal (izquierda y derecha). */
  horizontalLabels?: [string, string];
  accessibilityLabel?: string;
}

const strokeWidth = 1.5;

function readSeriesBounds(series: ChartSeries) {
  const startIndex = series.startIndex ?? 0;
  const sampleCount = series.sampleCount ?? series.values.length - startIndex;
  return { startIndex, sampleCount };
}

function resolveVerticalRange(series: readonly ChartSeries[], verticalRange: ChartVerticalRange) {
  if (verticalRange.mode === 'fixed') return { minimum: verticalRange.minimum, maximum: verticalRange.maximum };
  let largestMagnitude = 0;
  for (const singleSeries of series) {
    const { startIndex, sampleCount } = readSeriesBounds(singleSeries);
    for (let sampleIndex = startIndex; sampleIndex < startIndex + sampleCount; sampleIndex++) {
      const absoluteValue = Math.abs(singleSeries.values[sampleIndex] ?? 0);
      if (Number.isFinite(absoluteValue) && absoluteValue > largestMagnitude) largestMagnitude = absoluteValue;
    }
  }
  if (verticalRange.mode === 'symmetric') {
    const halfRange = Math.max(verticalRange.minimumHalfRange, largestMagnitude * 1.1);
    return { minimum: -halfRange, maximum: halfRange };
  }
  return { minimum: 0, maximum: Math.max(verticalRange.minimumMaximum, largestMagnitude * 1.1) };
}

function formatAxisValue(axisValue: number): string {
  const absoluteValue = Math.abs(axisValue);
  if (absoluteValue === 0) return '0';
  if (absoluteValue >= 100) return axisValue.toFixed(0);
  if (absoluteValue >= 1) return axisValue.toFixed(1);
  return axisValue.toPrecision(2);
}

/**
 * Gráfica de líneas con Skia para señales en tiempo real. Reconstruye los trazos solo cuando
 * cambia `revision`; pensada para refrescarse a ritmo de pantalla con cientos de puntos.
 */
export function SignalChart({
  series,
  height,
  verticalRange,
  revision,
  unitLabel,
  horizontalLabels,
  accessibilityLabel,
}: SignalChartProps) {
  const themePalette = useThemePalette();
  const [chartWidth, setChartWidth] = useState(0);

  const { seriesPaths, resolvedRange } = useMemo(() => {
    const currentRange = resolveVerticalRange(series, verticalRange);
    const verticalSpan = currentRange.maximum - currentRange.minimum || 1;
    const paths = series.map((singleSeries) => {
      const { startIndex, sampleCount } = readSeriesBounds(singleSeries);
      const seriesPath = Skia.Path.Make();
      if (chartWidth <= 0 || sampleCount < 2) return seriesPath;
      const horizontalStep = chartWidth / (sampleCount - 1);
      for (let pointIndex = 0; pointIndex < sampleCount; pointIndex++) {
        const sampleValue = singleSeries.values[startIndex + pointIndex] ?? 0;
        const clampedValue = Math.min(currentRange.maximum, Math.max(currentRange.minimum, sampleValue));
        const pointX = pointIndex * horizontalStep;
        const pointY = height - ((clampedValue - currentRange.minimum) / verticalSpan) * height;
        if (pointIndex === 0) seriesPath.moveTo(pointX, pointY);
        else seriesPath.lineTo(pointX, pointY);
      }
      return seriesPath;
    });
    return { seriesPaths: paths, resolvedRange: currentRange };
    // `revision` indica que los arrays (mutables) tienen datos nuevos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, verticalRange, chartWidth, height, revision]);

  const zeroLineY =
    resolvedRange.minimum < 0 && resolvedRange.maximum > 0
      ? height - ((0 - resolvedRange.minimum) / (resolvedRange.maximum - resolvedRange.minimum)) * height
      : null;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={[styles.container, { borderColor: themePalette.border, backgroundColor: themePalette.surface }]}>
      <View
        style={{ height }}
        onLayout={(layoutEvent: LayoutChangeEvent) => setChartWidth(layoutEvent.nativeEvent.layout.width)}>
        {chartWidth > 0 ? (
          <Canvas style={{ width: chartWidth, height }}>
            {zeroLineY !== null ? (
              <Line
                p1={vec(0, zeroLineY)}
                p2={vec(chartWidth, zeroLineY)}
                color={themePalette.border}
                strokeWidth={1}
              />
            ) : null}
            {seriesPaths.map((seriesPath, seriesIndex) => (
              <Path
                key={seriesIndex}
                path={seriesPath}
                style="stroke"
                strokeWidth={strokeWidth}
                strokeJoin="round"
                color={series[seriesIndex]!.color}
              />
            ))}
          </Canvas>
        ) : null}
        <Text style={[styles.axisLabel, styles.topLabel, { color: themePalette.textSecondary }]}>
          {`${formatAxisValue(resolvedRange.maximum)}${unitLabel ? ` ${unitLabel}` : ''}`}
        </Text>
        <Text style={[styles.axisLabel, styles.bottomLabel, { color: themePalette.textSecondary }]}>
          {formatAxisValue(resolvedRange.minimum)}
        </Text>
      </View>
      {horizontalLabels ? (
        <View style={styles.horizontalLabels}>
          <Text style={[styles.axisLabel, { color: themePalette.textSecondary }]}>{horizontalLabels[0]}</Text>
          <Text style={[styles.axisLabel, { color: themePalette.textSecondary }]}>{horizontalLabels[1]}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 8, gap: 4, overflow: 'hidden' },
  axisLabel: { fontSize: 11, fontVariant: ['tabular-nums'] },
  topLabel: { position: 'absolute', top: 0, left: 2 },
  bottomLabel: { position: 'absolute', bottom: 0, left: 2 },
  horizontalLabels: { flexDirection: 'row', justifyContent: 'space-between' },
});
