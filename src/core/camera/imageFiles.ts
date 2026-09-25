import { ImageFormat, type SkImage } from '@shopify/react-native-skia';
import { File, Paths } from 'expo-file-system';

/**
 * Guarda la imagen como PNG en la caché y devuelve el fichero (el núcleo lo copia al guardar la
 * medición). `fileNamePrefix` identifica al instrumento en el nombre: `luna`, `superzoom`…
 */
export function writeImageToCachePng(skiaImage: SkImage, fileNamePrefix: string): File {
  const pngFile = new File(Paths.cache, `${fileNamePrefix}-${Date.now()}.png`);
  pngFile.create({ overwrite: true });
  pngFile.write(skiaImage.encodeToBytes(ImageFormat.PNG));
  return pngFile;
}
