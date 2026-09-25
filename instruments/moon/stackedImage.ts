import { AlphaType, ColorType, ImageFormat, type SkImage, Skia } from '@shopify/react-native-skia';
import { File, Paths } from 'expo-file-system';

import { type FloatRgbImage, renderImageToRgba } from '@/processing/image/lunarStacking';

/** Imagen de Skia (para mostrarla) a partir de una imagen flotante, con el contraste estirado. */
export function createSkiaImage(image: FloatRgbImage): SkImage | null {
  return Skia.Image.MakeImage(
    { width: image.size, height: image.size, alphaType: AlphaType.Opaque, colorType: ColorType.RGBA_8888 },
    Skia.Data.fromBytes(renderImageToRgba(image)),
    image.size * 4,
  );
}

/** Guarda la imagen como PNG en la caché y devuelve el fichero (el núcleo lo copia al guardar). */
export function writeImageToCachePng(skiaImage: SkImage): File {
  const pngFile = new File(Paths.cache, `luna-${Date.now()}.png`);
  pngFile.create({ overwrite: true });
  pngFile.write(skiaImage.encodeToBytes(ImageFormat.PNG));
  return pngFile;
}
