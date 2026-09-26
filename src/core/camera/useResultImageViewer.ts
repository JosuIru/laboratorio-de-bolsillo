import type { SkImage } from '@shopify/react-native-skia';
import { File } from 'expo-file-system';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Attachment } from '@/core/measurements/types';

import { writeImageToCachePng } from './imageFiles';

export interface ResultImageToView {
  skiaImage: SkImage;
  /** Texto bajo la imagen en el visor. */
  caption: string;
  /** Prefijo del fichero temporal (`superzoom`, `luna`…). */
  fileNamePrefix: string;
}

/** Imagen lista para el visor a pantalla completa (misma forma que `ImageViewerItem`). */
export interface ResultViewerImage {
  attachment: Attachment;
  caption: string;
}

function deleteFilesQuietly(viewerImages: readonly ResultViewerImage[]) {
  for (const viewerImage of viewerImages) {
    try {
      const temporaryFile = new File(viewerImage.attachment.fileUri);
      if (temporaryFile.exists) temporaryFile.delete();
    } catch {
      // Fichero temporal de la caché: lo borrará el sistema.
    }
  }
}

/**
 * Para ver resultados recién calculados (aún sin guardar) en el visor a pantalla completa, con
 * pellizco y arrastre: escribe cada imagen en un PNG temporal y lo borra al cerrar el visor.
 * Pasa `viewerImages`, `openedIndex` y `closeViewer` al `ImageViewer`.
 */
export function useResultImageViewer() {
  const [viewerImages, setViewerImages] = useState<ResultViewerImage[]>([]);
  const [openedIndex, setOpenedIndex] = useState<number | null>(null);
  const viewerImagesRef = useRef<ResultViewerImage[]>([]);

  useEffect(() => () => deleteFilesQuietly(viewerImagesRef.current), []);

  const openViewer = useCallback((resultImages: readonly ResultImageToView[], initialIndex = 0) => {
    deleteFilesQuietly(viewerImagesRef.current);
    const nextViewerImages = resultImages.map((resultImage, imageIndex): ResultViewerImage => {
      const pngFile = writeImageToCachePng(resultImage.skiaImage, `${resultImage.fileNamePrefix}-${imageIndex}`);
      return {
        attachment: {
          id: `${resultImage.fileNamePrefix}-${imageIndex}-${Date.now()}`,
          kind: 'photo',
          fileUri: pngFile.uri,
          fileName: `${resultImage.fileNamePrefix}.png`,
          mimeType: 'image/png',
        },
        caption: resultImage.caption,
      };
    });
    viewerImagesRef.current = nextViewerImages;
    setViewerImages(nextViewerImages);
    setOpenedIndex(Math.min(initialIndex, nextViewerImages.length - 1));
  }, []);

  const closeViewer = useCallback(() => {
    setOpenedIndex(null);
    deleteFilesQuietly(viewerImagesRef.current);
    viewerImagesRef.current = [];
    setViewerImages([]);
  }, []);

  return { viewerImages, openedIndex, openViewer, closeViewer };
}
