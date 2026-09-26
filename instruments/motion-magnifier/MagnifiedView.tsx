import {
  AlphaType,
  Blur,
  Canvas,
  ColorType,
  Group,
  Image as SkiaImageView,
  type SkImage,
  Skia,
} from '@shopify/react-native-skia';
import { useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';

/** Imagen RGBA pequeña que se dibuja ampliada (la amplificada o uno de los mapas). */
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

/**
 * Remuestreo cúbico de Mitchell-Netravali (B = C = 1/3): amplía la rejilla (96 × 128, o los mapas
 * de 48 × 64 y 24 × 32) sin escalones y sin el halo de un filtro más «afilado».
 */
const smoothUpscaling = { B: 1 / 3, C: 1 / 3 };
/**
 * Desenfoque de reconstrucción, en fracciones del tamaño en pantalla de una celda: borra lo que
 * queda de la retícula de la rejilla tras el cúbico sin llegar a emborronar los bordes.
 */
const reconstructionBlurPerCell = 0.3;

/**
 * Lienzo Skia que cubre la vista previa y dibuja la imagen del almacén en el rectángulo que
 * ocupa el fotograma (`contain`, como la vista de la cámara). Con cortina (`curtainX`), solo se
 * dibuja a su derecha: a la izquierda se ve la cámara original, que está debajo.
 */
export function MagnifiedView({
  imageStore,
  viewWidth,
  viewHeight,
  curtainX,
}: {
  imageStore: DisplayedImageStore;
  viewWidth: number;
  viewHeight: number;
  curtainX: number | null;
}) {
  const skiaImage = useSyncExternalStore(imageStore.subscribe, imageStore.getSnapshot);
  if (!skiaImage || viewWidth <= 0 || viewHeight <= 0) return null;
  const imageWidth = skiaImage.width();
  const imageHeight = skiaImage.height();
  const displayedCellSize = imageWidth > 0 && imageHeight > 0 ? Math.min(viewWidth / imageWidth, viewHeight / imageHeight) : 0;
  const blurSigma = displayedCellSize * reconstructionBlurPerCell;
  const clipRectangle =
    curtainX === null ? undefined : { x: curtainX, y: 0, width: Math.max(0, viewWidth - curtainX), height: viewHeight };
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Canvas style={{ width: viewWidth, height: viewHeight }}>
        <Group clip={clipRectangle}>
          <SkiaImageView
            image={skiaImage}
            x={0}
            y={0}
            width={viewWidth}
            height={viewHeight}
            fit="contain"
            sampling={smoothUpscaling}>
            {blurSigma >= 0.5 ? <Blur blur={blurSigma} mode="clamp" /> : null}
          </SkiaImageView>
        </Group>
      </Canvas>
    </View>
  );
}
