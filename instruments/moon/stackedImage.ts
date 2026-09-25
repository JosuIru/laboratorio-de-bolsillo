import { AlphaType, ColorType, type SkImage, Skia } from '@shopify/react-native-skia';

import { type FloatRgbImage, renderImageToRgba } from '@/processing/image/lunarStacking';

/** Imagen de Skia (para mostrarla) a partir de una imagen flotante, con el contraste estirado. */
export function createSkiaImage(image: FloatRgbImage): SkImage | null {
  return Skia.Image.MakeImage(
    { width: image.size, height: image.size, alphaType: AlphaType.Opaque, colorType: ColorType.RGBA_8888 },
    Skia.Data.fromBytes(renderImageToRgba(image)),
    image.size * 4,
  );
}

