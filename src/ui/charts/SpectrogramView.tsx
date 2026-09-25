import { AlphaType, Canvas, ColorType, Image, Skia } from '@shopify/react-native-skia';
import { useMemo, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';

import {
  createColormapLookupTable,
  renderSpectrogramPixels,
  type SpectrogramHistory,
} from '@/processing/dsp/spectrogram';
import { useThemePalette } from '@/ui/theme';

interface SpectrogramViewProps {
  history: SpectrogramHistory;
  /** Cambia cuando el historial tiene filas nuevas. */
  revision: number;
  height: number;
  minimumDecibels: number;
  maximumDecibels: number;
  horizontalLabels: [string, string];
  accessibilityLabel: string;
}

/**
 * Espectrograma en cascada: el historial se pinta en un buffer RGBA pequeño (columnas × filas)
 * y Skia lo escala al tamaño de la vista. La fila más reciente queda arriba.
 */
export function SpectrogramView({
  history,
  revision,
  height,
  minimumDecibels,
  maximumDecibels,
  horizontalLabels,
  accessibilityLabel,
}: SpectrogramViewProps) {
  const themePalette = useThemePalette();
  const [viewWidth, setViewWidth] = useState(0);
  const [pixels] = useState(() => new Uint8Array(history.columnCount * history.rowCount * 4));
  const [colormapLookupTable] = useState(createColormapLookupTable);

  const spectrogramImage = useMemo(() => {
    renderSpectrogramPixels(history, pixels, minimumDecibels, maximumDecibels, colormapLookupTable);
    return Skia.Image.MakeImage(
      {
        width: history.columnCount,
        height: history.rowCount,
        alphaType: AlphaType.Opaque,
        colorType: ColorType.RGBA_8888,
      },
      Skia.Data.fromBytes(pixels),
      history.columnCount * 4,
    );
    // `revision` indica que el historial (mutable) tiene filas nuevas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, pixels, minimumDecibels, maximumDecibels, colormapLookupTable, revision]);

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={[styles.container, { borderColor: themePalette.border, backgroundColor: themePalette.surface }]}>
      <View style={{ height }} onLayout={(layoutEvent: LayoutChangeEvent) => setViewWidth(layoutEvent.nativeEvent.layout.width)}>
        {viewWidth > 0 && spectrogramImage ? (
          <Canvas style={{ width: viewWidth, height }}>
            <Image image={spectrogramImage} x={0} y={0} width={viewWidth} height={height} fit="fill" />
          </Canvas>
        ) : null}
      </View>
      <View style={styles.horizontalLabels}>
        <Text style={[styles.axisLabel, { color: themePalette.textSecondary }]}>{horizontalLabels[0]}</Text>
        <Text style={[styles.axisLabel, { color: themePalette.textSecondary }]}>{horizontalLabels[1]}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 8, gap: 4, overflow: 'hidden' },
  axisLabel: { fontSize: 11, fontVariant: ['tabular-nums'] },
  horizontalLabels: { flexDirection: 'row', justifyContent: 'space-between' },
});
