import { AlphaType, Canvas, ColorType, Image as SkiaImageView, Line, type SkImage, Skia, vec } from '@shopify/react-native-skia';
import { useState } from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';

import type { LineSegment } from '@/processing/image/meteorDetection';

import { bytesToRgba } from './skyCapturePlanning';

/** Imagen de Skia a partir de bytes en gris (1 canal) o RGB entrelazado (3). */
export function createSkyImage(pixelBytes: Uint8Array, width: number, height: number, channelCount: 1 | 3): SkImage | null {
  return Skia.Image.MakeImage(
    { width, height, alphaType: AlphaType.Opaque, colorType: ColorType.RGBA_8888 },
    Skia.Data.fromBytes(bytesToRgba(pixelBytes, width * height, channelCount)),
    width * 4,
  );
}

/**
 * Resultado a lo ancho del panel, con su proporción. Con `highlightedSegment` se marca (en
 * coordenadas de la imagen) el trazo de un meteoro.
 */
export function SkyResultImage({
  skiaImage,
  label,
  onPress,
  highlightedSegment,
}: {
  skiaImage: SkImage;
  label: string;
  onPress?(): void;
  highlightedSegment?: LineSegment;
}) {
  const [frameWidth, setFrameWidth] = useState(0);
  const imageWidth = skiaImage.width();
  const imageHeight = skiaImage.height();
  const displayScale = imageWidth > 0 ? frameWidth / imageWidth : 0;
  const displayHeight = imageHeight * displayScale;
  return (
    <Pressable accessibilityRole={onPress ? 'button' : 'image'} accessibilityLabel={label} onPress={onPress} disabled={!onPress}>
      <View
        style={[styles.frame, { aspectRatio: imageHeight > 0 ? imageWidth / imageHeight : 1 }]}
        onLayout={(layoutEvent: LayoutChangeEvent) => setFrameWidth(layoutEvent.nativeEvent.layout.width)}>
        {frameWidth > 0 ? (
          <Canvas style={{ width: frameWidth, height: displayHeight }}>
            <SkiaImageView image={skiaImage} x={0} y={0} width={frameWidth} height={displayHeight} fit="fill" />
            {highlightedSegment ? (
              <Line
                p1={vec(highlightedSegment.startX * displayScale, highlightedSegment.startY * displayScale)}
                p2={vec(highlightedSegment.endX * displayScale, highlightedSegment.endY * displayScale)}
                color="rgba(250, 204, 21, 0.55)"
                strokeWidth={6}
                style="stroke"
              />
            ) : null}
          </Canvas>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  frame: { width: '100%', backgroundColor: '#000000', borderRadius: 8, overflow: 'hidden' },
});
