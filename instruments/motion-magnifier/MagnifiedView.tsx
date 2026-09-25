import { AlphaType, Canvas, ColorType, Image as SkiaImageView, type SkImage, Skia } from '@shopify/react-native-skia';
import { useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';

/** Imagen RGBA pequeña que se dibuja ampliada (la amplificada o el mapa de variación). */
export interface DisplayedGridImage {
  rgba: Uint8Array;
  width: number;
  height: number;
  isOpaque: boolean;
}

/**
 * Almacén de la última imagen procesada. La pantalla publica a ritmo de cámara y solo se vuelve
 * a pintar el lienzo que lo lee, no la pantalla entera.
 */
export function createDisplayedImageStore() {
  let latestSkiaImage: SkImage | null = null;
  const listeners = new Set<() => void>();
  return {
    publish(displayedImage: DisplayedGridImage | null) {
      latestSkiaImage = displayedImage
        ? Skia.Image.MakeImage(
            {
              width: displayedImage.width,
              height: displayedImage.height,
              alphaType: displayedImage.isOpaque ? AlphaType.Opaque : AlphaType.Unpremul,
              colorType: ColorType.RGBA_8888,
            },
            Skia.Data.fromBytes(displayedImage.rgba),
            displayedImage.width * 4,
          )
        : null;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => latestSkiaImage,
  };
}

export type DisplayedImageStore = ReturnType<typeof createDisplayedImageStore>;

/** Remuestreo cúbico de Mitchell: amplía la rejilla de 96 × 128 sin escalones visibles. */
const smoothUpscaling = { B: 1 / 3, C: 1 / 3 };

/**
 * Lienzo Skia que cubre la vista previa y dibuja la imagen del almacén en el rectángulo que
 * ocupa el fotograma (`contain`, como la vista de la cámara).
 */
export function MagnifiedView({
  imageStore,
  viewWidth,
  viewHeight,
}: {
  imageStore: DisplayedImageStore;
  viewWidth: number;
  viewHeight: number;
}) {
  const skiaImage = useSyncExternalStore(imageStore.subscribe, imageStore.getSnapshot);
  if (!skiaImage || viewWidth <= 0) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Canvas style={{ width: viewWidth, height: viewHeight }}>
      <SkiaImageView
        image={skiaImage}
        x={0}
        y={0}
        width={viewWidth}
        height={viewHeight}
        fit="contain"
          sampling={smoothUpscaling}
        />
      </Canvas>
    </View>
  );
}
