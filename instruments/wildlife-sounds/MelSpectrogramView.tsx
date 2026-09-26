import { AlphaType, Canvas, ColorType, Image, Skia } from '@shopify/react-native-skia';
import { useMemo, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';

import { createColormapLookupTable } from '@/processing/dsp/spectrogram';
import { useThemePalette } from '@/ui/theme';

import { renderMelSpectrogramPixels } from './melSpectrogramPixels';

interface MelSpectrogramViewProps {
  melSpectrogram: Float32Array;
  frameCount: number;
  melBinCount: number;
  height: number;
  horizontalLabels: [string, string];
  accessibilityLabel: string;
}

/** Espectrograma log-mel de una ventana: se pinta en un buffer pequeño y Skia lo escala. */
export function MelSpectrogramView({
  melSpectrogram,
  frameCount,
  melBinCount,
  height,
  horizontalLabels,
  accessibilityLabel,
}: MelSpectrogramViewProps) {
  const themePalette = useThemePalette();
  const [viewWidth, setViewWidth] = useState(0);
  const [colormapLookupTable] = useState(createColormapLookupTable);

  const spectrogramImage = useMemo(() => {
    if (frameCount <= 0 || melBinCount <= 0) return null;
    const pixels = new Uint8Array(frameCount * melBinCount * 4);
    renderMelSpectrogramPixels(melSpectrogram, frameCount, melBinCount, pixels, colormapLookupTable);
    return Skia.Image.MakeImage(
      { width: frameCount, height: melBinCount, alphaType: AlphaType.Opaque, colorType: ColorType.RGBA_8888 },
      Skia.Data.fromBytes(pixels),
      frameCount * 4,
    );
  }, [melSpectrogram, frameCount, melBinCount, colormapLookupTable]);

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
