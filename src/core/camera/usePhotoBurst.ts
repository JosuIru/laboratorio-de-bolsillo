/**
 * Ráfaga de fotos a resolución completa con VisionCamera, para apilar o fusionar.
 *
 * Los fotogramas del flujo de vídeo traen mucho menos detalle que una foto: reducción de ruido de
 * vídeo, compresión, sin el afinado de las fotos y con la exposición larga del vídeo. Aquí se
 * toman fotos de verdad con la salida de fotos (`usePhotoOutput`):
 *
 * 1. Se disparan N fotos seguidas directamente a ficheros JPEG (`capturePhotoToFile`): el móvil
 *    libera cada foto al escribirla, así que no se acumulan 12 fotos de 12 MP en memoria y la
 *    ráfaga va lo más rápido que da la cámara.
 * 2. Después se decodifica cada fichero de uno en uno (en hilos nativos, con
 *    `react-native-nitro-image`), se recorta SOLO la zona que pide el instrumento, se gira el
 *    recorte según el EXIF para que coincida con la pantalla y se pasa a RGB. El fichero se borra.
 *
 * El recorte se planea en la foto «derecha» (como se ve en pantalla). Para que coincida, la
 * `<Camera>` debe llevar `orientationSource="interface"`: con la orientación del aparato (la
 * opción por defecto), apuntar al cielo o girar el móvil giraría las fotos respecto a la pantalla.
 */
import { File } from 'expo-file-system';
import type { Image as NitroImage } from 'react-native-nitro-image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type CameraController, type CameraPhotoOutput, CommonResolutions, usePhotoOutput } from 'react-native-vision-camera';

import {
  exifOrientationToTransform,
  isSupportedPixelFormat,
  rawPixelsToRgb,
  readJpegExifOrientation,
} from '@/processing/image/jpegPhoto';

import { type BurstExposurePlan, planHandheldBurstExposure } from './burstExposure';
import {
  clampRectToImage,
  type PixelRect,
  type PixelSize,
  portraitSize,
  rotatedSize,
  rotationStillNeeded,
  uprightRectToStoredRect,
} from './photoCropGeometry';

/** Bytes del principio del JPEG que se leen para encontrar la orientación EXIF. */
const exifHeaderByteCount = 64 * 1024;
/**
 * Resolución pedida: la normal de 12 MP de casi todos los móviles (4:3). Pedir la máxima podría
 * elegir modos de 50 MP, lentísimos de decodificar y sin más detalle real.
 */
const burstPhotoResolution = CommonResolutions.UHD_4_3;
/** Tamaño supuesto de la foto derecha mientras la cámara no dice el suyo. */
const fallbackUprightPhotoSize: PixelSize = { width: 3024, height: 4032 };

export interface PhotoBurstCrop {
  /** RGB de 8 bits, `width`×`height`×3. */
  rgbPixels: Uint8Array;
  width: number;
  height: number;
  /** Tamaño de la foto derecha de la que sale el recorte. */
  uprightPhotoSize: PixelSize;
  /** Recorte en coordenadas de la foto derecha (tras ajustarlo a la foto). */
  cropRect: PixelRect;
  /** Píxeles del recorte entregado por cada píxel de la foto (< 1 si se redujo). */
  outputScale: number;
  /** Lo que devolvió `isPhotoUsable` al tomar la foto (p. ej., si el móvil estaba quieto). */
  wasMarkedUsable: boolean;
}

export interface PhotoBurstTimings {
  /** Desde el primer disparo hasta que se guardó la última foto. */
  captureMilliseconds: number;
  /** Decodificar, recortar y girar todas las fotos. */
  decodeMilliseconds: number;
  capturedPhotoCount: number;
}

export interface PhotoBurstResult {
  crops: PhotoBurstCrop[];
  timings: PhotoBurstTimings;
  /** Fotos tomadas que no se pudieron decodificar. */
  failedPhotoCount: number;
  /** El primer error (captura o decodificación), para mostrarlo si no hay ningún recorte. */
  firstErrorMessage: string | null;
}

export interface PhotoBurstRequest {
  photoCount: number;
  /**
   * Recorte que interesa de cada foto, en coordenadas de la foto derecha (se ajusta a la foto si
   * se sale). null: se descarta la foto.
   */
  planCrop(uprightPhotoSize: PixelSize, photoIndex: number): PixelRect | null;
  /** Se consulta justo al tomar cada foto (p. ej., si el móvil estaba quieto). */
  isPhotoUsable?(): boolean;
  /** Si el recorte es más grande, se reduce (en nativo) hasta este lado. */
  maximumOutputSide?: number;
}

export interface PhotoBurstProgress {
  phase: 'capturing' | 'decoding';
  completedCount: number;
  totalCount: number;
}

interface CapturedPhotoFile {
  fileUri: string;
  wasMarkedUsable: boolean;
}

function fileUriFromPath(filePath: string): string {
  return filePath.startsWith('file://') ? filePath : `file://${filePath}`;
}

function deleteQuietly(fileUri: string) {
  try {
    const photoFile = new File(fileUri);
    if (photoFile.exists) photoFile.delete();
  } catch {
    // Es un fichero temporal de la caché: si no se puede borrar, lo borrará el sistema.
  }
}

function readFileHeader(fileUri: string): Uint8Array {
  const fileHandle = new File(fileUri).open();
  try {
    const fileSize = fileHandle.size ?? exifHeaderByteCount;
    return fileHandle.readBytes(Math.min(exifHeaderByteCount, fileSize));
  } finally {
    fileHandle.close();
  }
}

function disposeQuietly(image: NitroImage) {
  try {
    image.dispose();
  } catch {
    // Ya liberada.
  }
}

/**
 * Decodifica una foto, recorta la zona pedida y la devuelve derecha y en RGB. Solo se gira el
 * recorte: girar la foto entera (12 MP) costaría otros 48 MB y bastante tiempo.
 */
async function decodePhotoCrop(
  capturedPhoto: CapturedPhotoFile,
  photoIndex: number,
  burstRequest: PhotoBurstRequest,
): Promise<PhotoBurstCrop | null> {
  const { Images } = await import('react-native-nitro-image');
  const exifTransform = exifOrientationToTransform(readJpegExifOrientation(readFileHeader(capturedPhoto.fileUri)));
  // Cada paso crea una imagen nativa nueva; se liberan todas al final aunque algo falle.
  const nativeImages: NitroImage[] = [];
  function keep(nativeImage: NitroImage): NitroImage {
    if (!nativeImages.includes(nativeImage)) nativeImages.push(nativeImage);
    return nativeImage;
  }
  try {
    const decodedImage = keep(await Images.loadFromFileAsync(capturedPhoto.fileUri.replace(/^file:\/\//, '')));
    const storedSize = { width: decodedImage.width, height: decodedImage.height };
    const pendingRotation = rotationStillNeeded(storedSize, exifTransform.clockwiseDegrees);
    const uprightPhotoSize = rotatedSize(storedSize, pendingRotation);
    const plannedRect = burstRequest.planCrop(uprightPhotoSize, photoIndex);
    if (!plannedRect) return null;
    const uprightRect = clampRectToImage(plannedRect, uprightPhotoSize);
    // El espejo (solo cámara frontal) se aplica después del giro: se deshace antes de traducir.
    const rotatedOnlyRect = exifTransform.isMirrored
      ? { ...uprightRect, left: uprightPhotoSize.width - uprightRect.left - uprightRect.width }
      : uprightRect;
    const storedRect = uprightRectToStoredRect(rotatedOnlyRect, storedSize, pendingRotation);
    let workingImage = keep(
      await decodedImage.cropAsync(
        storedRect.left,
        storedRect.top,
        storedRect.left + storedRect.width,
        storedRect.top + storedRect.height,
      ),
    );
    // La foto entera ya no hace falta: se libera antes de seguir (son ~48 MB).
    disposeQuietly(decodedImage);
    nativeImages.splice(nativeImages.indexOf(decodedImage), 1);
    if (pendingRotation !== 0) workingImage = keep(await workingImage.rotateAsync(pendingRotation));
    if (exifTransform.isMirrored) workingImage = keep(await workingImage.mirrorHorizontallyAsync());
    let outputScale = 1;
    const { maximumOutputSide } = burstRequest;
    if (maximumOutputSide !== undefined && Math.max(workingImage.width, workingImage.height) > maximumOutputSide) {
      outputScale = maximumOutputSide / Math.max(workingImage.width, workingImage.height);
      workingImage = keep(
        await workingImage.resizeAsync(
          Math.max(1, Math.round(workingImage.width * outputScale)),
          Math.max(1, Math.round(workingImage.height * outputScale)),
        ),
      );
    }
    const rawPixelData = await workingImage.toRawPixelDataAsync();
    if (!isSupportedPixelFormat(rawPixelData.pixelFormat)) {
      throw new Error(`Formato de píxel no admitido: ${rawPixelData.pixelFormat}`);
    }
    const rawPixels = new Uint8Array(rawPixelData.buffer);
    const cropWidth = Math.round(rawPixelData.width);
    const cropHeight = Math.round(rawPixelData.height);
    return {
      rgbPixels: rawPixelsToRgb(rawPixels, cropWidth, cropHeight, rawPixels.length / cropHeight, rawPixelData.pixelFormat),
      width: cropWidth,
      height: cropHeight,
      uprightPhotoSize,
      cropRect: uprightRect,
      outputScale,
      wasMarkedUsable: capturedPhoto.wasMarkedUsable,
    };
  } finally {
    for (const nativeImage of nativeImages) disposeQuietly(nativeImage);
  }
}

/**
 * Salida de fotos y ráfaga. Pasa `photoOutput` a `outputs` de la `<Camera>` (puede ir junto a una
 * salida de fotogramas) y llama a `handleCameraStarted` desde `onStarted` para conocer el tamaño
 * real de las fotos.
 */
export function usePhotoBurst() {
  const photoOutput: CameraPhotoOutput = usePhotoOutput({
    targetResolution: burstPhotoResolution,
    containerFormat: 'jpeg',
    // Poca compresión: los artefactos JPEG se confundirían con detalle al fusionar.
    quality: 0.95,
    // «balanced» = mínima latencia en Android: fotos rápidas sin el procesado multifoto lento.
    qualityPrioritization: 'balanced',
  });
  const [uprightPhotoSize, setUprightPhotoSize] = useState<PixelSize | null>(null);
  const [captureProgress, setCaptureProgress] = useState<PhotoBurstProgress | null>(null);
  const isStopRequestedRef = useRef(false);
  const isUnmountedRef = useRef(false);
  const isBurstRunningRef = useRef(false);

  useEffect(() => {
    isUnmountedRef.current = false;
    return () => {
      isUnmountedRef.current = true;
    };
  }, []);

  const handleCameraStarted = useCallback(() => {
    const photoResolution = photoOutput.currentResolution;
    if (photoResolution && photoResolution.width > 0 && photoResolution.height > 0) {
      setUprightPhotoSize(portraitSize(photoResolution));
    }
  }, [photoOutput]);

  const captureBurst = useCallback(
    async (burstRequest: PhotoBurstRequest): Promise<PhotoBurstResult> => {
      if (isBurstRunningRef.current) throw new Error('Ya hay una ráfaga en marcha');
      isBurstRunningRef.current = true;
      isStopRequestedRef.current = false;
      const { photoCount, isPhotoUsable } = burstRequest;
      const capturedPhotos: CapturedPhotoFile[] = [];
      let firstErrorMessage: string | null = null;
      try {
        // 1. Ráfaga: se dispara la siguiente en cuanto se guarda la anterior.
        setCaptureProgress({ phase: 'capturing', completedCount: 0, totalCount: photoCount });
        const captureStartTime = Date.now();
        for (let photoIndex = 0; photoIndex < photoCount; photoIndex++) {
          if (isStopRequestedRef.current || isUnmountedRef.current) break;
          try {
            const photoFile = await photoOutput.capturePhotoToFile({ flashMode: 'off', enableShutterSound: false }, {});
            capturedPhotos.push({
              fileUri: fileUriFromPath(photoFile.filePath),
              wasMarkedUsable: isPhotoUsable ? isPhotoUsable() : true,
            });
          } catch (captureError) {
            firstErrorMessage = captureError instanceof Error ? captureError.message : String(captureError);
            break;
          }
          if (!isUnmountedRef.current) {
            setCaptureProgress({ phase: 'capturing', completedCount: capturedPhotos.length, totalCount: photoCount });
          }
        }
        const captureMilliseconds = Date.now() - captureStartTime;

        // 2. Decodificar y recortar de una en una (siempre se borran los ficheros).
        const crops: PhotoBurstCrop[] = [];
        let failedPhotoCount = 0;
        const decodeStartTime = Date.now();
        for (let photoIndex = 0; photoIndex < capturedPhotos.length; photoIndex++) {
          const capturedPhoto = capturedPhotos[photoIndex]!;
          if (isUnmountedRef.current) {
            deleteQuietly(capturedPhoto.fileUri);
            continue;
          }
          setCaptureProgress({ phase: 'decoding', completedCount: photoIndex, totalCount: capturedPhotos.length });
          try {
            const photoCrop = await decodePhotoCrop(capturedPhoto, photoIndex, burstRequest);
            if (photoCrop) crops.push(photoCrop);
          } catch (decodeError) {
            failedPhotoCount++;
            firstErrorMessage ??= decodeError instanceof Error ? decodeError.message : String(decodeError);
          } finally {
            deleteQuietly(capturedPhoto.fileUri);
          }
        }
        return {
          crops: isUnmountedRef.current ? [] : crops,
          timings: {
            captureMilliseconds,
            decodeMilliseconds: Date.now() - decodeStartTime,
            capturedPhotoCount: capturedPhotos.length,
          },
          failedPhotoCount,
          firstErrorMessage,
        };
      } finally {
        isBurstRunningRef.current = false;
        if (!isUnmountedRef.current) setCaptureProgress(null);
      }
    },
    [photoOutput],
  );

  /** Deja de disparar: se decodifican las fotos ya tomadas. */
  const stopCapture = useCallback(() => {
    isStopRequestedRef.current = true;
  }, []);

  return {
    photoOutput,
    /** Tamaño de las fotos derechas (vertical); uno típico mientras la cámara no ha arrancado. */
    uprightPhotoSize: uprightPhotoSize ?? fallbackUprightPhotoSize,
    hasKnownPhotoSize: uprightPhotoSize !== null,
    handleCameraStarted,
    captureProgress,
    isCapturing: captureProgress !== null,
    captureBurst,
    stopCapture,
  };
}

/**
 * Acorta la exposición para la ráfaga a mano (tiempo × ISO constante), si el móvil permite fijar
 * tiempo e ISO. Devuelve lo aplicado o null si no se ha tocado. Para volver a la exposición
 * automática, `resetFocus()` de la cámara.
 */
export async function applyHandheldBurstExposure(
  cameraController: CameraController | undefined,
  supportsExposureLocking: boolean,
): Promise<BurstExposurePlan | null> {
  if (!cameraController || !supportsExposureLocking || cameraController.maxExposureDuration <= 0) return null;
  const exposurePlan = planHandheldBurstExposure(
    { exposureSeconds: cameraController.exposureDuration, iso: cameraController.iso },
    {
      minimumExposureSeconds: cameraController.minExposureDuration,
      maximumExposureSeconds: cameraController.maxExposureDuration,
      minimumIso: cameraController.minISO,
      maximumIso: cameraController.maxISO,
    },
  );
  if (!exposurePlan) return null;
  await cameraController.setExposureLocked(exposurePlan.exposureSeconds, exposurePlan.iso);
  return exposurePlan;
}
