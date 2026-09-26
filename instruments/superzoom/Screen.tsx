import { AlphaType, Canvas, ColorType, Image as SkiaImageView, type SkImage, Skia } from '@shopify/react-native-skia';
import { lazy, type ReactNode, type RefObject, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type GestureResponderEvent, type LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';
import { Camera, type CameraRef, type MeteringMode, useCameraDevice } from 'react-native-vision-camera';

import { writeImageToCachePng } from '@/core/camera/imageFiles';
import { centeredSquareCrop, type PixelSize, photoRectToViewRect } from '@/core/camera/photoCropGeometry';
import type { PreviewPoint } from '@/core/camera/previewGeometry';
import { useCameraZoomAndExposure } from '@/core/camera/useCameraZoomAndExposure';
import { useCameraPointsInView } from '@/core/camera/useCameraPointsInView';
import { useDeviceSteadiness } from '@/core/camera/useDeviceSteadiness';
import { applyHandheldBurstExposure, type PhotoBurstTimings, usePhotoBurst } from '@/core/camera/usePhotoBurst';
import { useResultImageViewer } from '@/core/camera/useResultImageViewer';
import type { InstrumentScreenProps } from '@/core/instruments/types';
import { isExpectedCameraInterruption } from '@/core/sensors/cameraErrors';
import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import type { DeconvolutionLevel, DeconvolvedVersions } from '@/processing/image/burstDeconvolution';
import { defaultSuperResolutionOptions, floatImageToRgba, sharpeningSigmaForScale } from '@/processing/image/burstSuperResolution';
import { type FloatRgbImage, sharpenImage } from '@/processing/image/lunarStacking';
import { AppButton, BodyText, Card, LoadingState, SectionTitle } from '@/ui/components';
import { CameraOverlayButton, CameraOverlayText, CameraScreenLayout } from '@/ui/FullScreenCamera';
import { useThemePalette } from '@/ui/theme';

import {
  type ChromaticCorrectionMode,
  deconvolveSingleFrame,
  processSuperzoomBurst,
  type SuperzoomProcessingResult,
} from './processSuperzoomBurst';
import type { SuperzoomMeasurementValues } from './schema';
import { type FocusTuningOutcome, useSuperzoomFocusTuning } from './useSuperzoomFocusTuning';

export const superzoomInstrumentId = 'superzoom';

/**
 * El visor se carga al abrirlo: arrastra módulos nativos (galería, compartir) que no hacen falta
 * hasta entonces y que no existen en los tests que importan todos los instrumentos.
 */
const ImageViewer = lazy(() => import('@/ui/ImageViewer').then((viewerModule) => ({ default: viewerModule.ImageViewer })));

/**
 * Lado del recorte central de cada foto, en píxeles de la foto a resolución completa (el resultado
 * mide el doble). Más grande abarca más escena, pero el cálculo crece con el área: el grande
 * tarda unas cuatro veces lo que el pequeño.
 */
const cropSizeOptions = [
  { labelKey: 'cropSizes.small', cropSizePixels: 512 },
  { labelKey: 'cropSizes.medium', cropSizePixels: 768 },
  { labelKey: 'cropSizes.large', cropSizePixels: 1024 },
] as const;
const defaultCropSizeOptionIndex = 1;
/**
 * Fotos de cada ráfaga (unos 3 s en un móvil de gama media). Se fusiona la mitad más nítida
 * (`keptFraction` 0,5): con fotos a mano, las movidas se notan en la nitidez y es mejor
 * descartarlas; con 5-6 fotos buenas la ganancia de la superresolución ya casi no crece.
 */
const capturedPhotoTarget = 10;
/** Cuenta atrás antes de capturar, para que el toque en la pantalla no mueva la imagen. */
const captureCountdownSeconds = 2;
const zoomStepFactor = Math.SQRT2;
const meteringMarkerRadius = 28;
/**
 * Niveles de nitidez: con deconvolución, iteraciones de Richardson–Lucy (`burstDeconvolution`);
 * con máscara de enfoque, la cantidad de detalle que se suma.
 */
const sharpeningLevels: readonly { labelKey: string; deconvolutionLevel: DeconvolutionLevel | null; unsharpAmount: number }[] = [
  { labelKey: 'sharpening.none', deconvolutionLevel: null, unsharpAmount: 0 },
  { labelKey: 'sharpening.soft', deconvolutionLevel: 'soft', unsharpAmount: 0.5 },
  { labelKey: 'sharpening.medium', deconvolutionLevel: 'medium', unsharpAmount: 1 },
  { labelKey: 'sharpening.strong', deconvolutionLevel: 'strong', unsharpAmount: 1.6 },
];
const defaultSharpeningLevelIndex = 2;
type SharpeningMethod = 'deconvolution' | 'unsharpMask';
const sharpeningMethods: readonly SharpeningMethod[] = ['deconvolution', 'unsharpMask'];
const chromaticCorrectionModes: readonly ChromaticCorrectionMode[] = ['auto', 'profile', 'off'];
type OnOffChoice = 'on' | 'off';
const onOffChoices: readonly OnOffChoice[] = ['on', 'off'];

type DisplayedVersion = 'superzoom' | 'singleFrame';

interface SuperzoomOutcome {
  processing: SuperzoomProcessingResult;
  capturedFrameCount: number;
  cropSizePixels: number;
  zoomFactor: number;
  burstTimings: PhotoBurstTimings;
  /** Se congeló el balance de blancos durante la ráfaga (si el móvil lo permite). */
  hasLockedWhiteBalance: boolean;
  focusTuning: FocusTuningOutcome | null;
  wasLocalAlignmentRequested: boolean;
}

/**
 * Deconvolución del fotograma suelto de cada resultado: se calcula al mirarla por primera vez
 * (tarda casi lo mismo que la del superzoom) y se guarda mientras exista el resultado.
 */
const singleFrameDeconvolutionCache = new WeakMap<SuperzoomProcessingResult, DeconvolvedVersions>();

function singleFrameDeconvolution(processing: SuperzoomProcessingResult): DeconvolvedVersions {
  let deconvolvedVersions = singleFrameDeconvolutionCache.get(processing);
  if (!deconvolvedVersions) {
    deconvolvedVersions = deconvolveSingleFrame(processing);
    singleFrameDeconvolutionCache.set(processing, deconvolvedVersions);
  }
  return deconvolvedVersions;
}

/** La versión pedida con la nitidez elegida (solo cálculo, sin React). */
function sharpenedImageFor(
  outcome: SuperzoomOutcome,
  version: DisplayedVersion,
  sharpeningMethod: SharpeningMethod,
  sharpeningLevelIndex: number,
): FloatRgbImage {
  const { processing } = outcome;
  const baseImage = version === 'superzoom' ? processing.superzoomImage : processing.singleFrameImage;
  const sharpeningLevel = sharpeningLevels[sharpeningLevelIndex];
  if (!sharpeningLevel?.deconvolutionLevel) return baseImage;
  if (sharpeningMethod === 'unsharpMask') {
    return sharpenImage(baseImage, sharpeningSigmaForScale(defaultSuperResolutionOptions.scale), sharpeningLevel.unsharpAmount);
  }
  const deconvolvedVersions = version === 'superzoom' ? processing.superzoomDeconvolution : singleFrameDeconvolution(processing);
  return deconvolvedVersions.images[sharpeningLevel.deconvolutionLevel];
}

function secondsText(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(1);
}

function waitMilliseconds(durationMilliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, durationMilliseconds));
}

function createSkiaImage(image: FloatRgbImage): SkImage | null {
  return Skia.Image.MakeImage(
    { width: image.size, height: image.size, alphaType: AlphaType.Opaque, colorType: ColorType.RGBA_8888 },
    Skia.Data.fromBytes(floatImageToRgba(image)),
    image.size * 4,
  );
}

/** Recuadro que marca en la vista previa la zona de la foto que se amplía (la vista usa `contain`). */
function CropFrameOverlay({
  previewWidth,
  previewHeight,
  photoSize,
  cropSizePixels,
}: {
  previewWidth: number;
  previewHeight: number;
  photoSize: PixelSize;
  cropSizePixels: number;
}) {
  const cropRect = photoRectToViewRect(centeredSquareCrop(photoSize, cropSizePixels), photoSize, {
    width: previewWidth,
    height: previewHeight,
  });
  return <View pointerEvents="none" style={[styles.cropFrame, cropRect]} />;
}

/** Recuadro del punto de enfoque, situado a partir de su punto de cámara (no se descoloca al cambiar de tamaño). */
function MeteringMarker({
  cameraRef,
  meteringCameraPoints,
  previewWidth,
  previewHeight,
}: {
  cameraRef: RefObject<CameraRef | null>;
  meteringCameraPoints: readonly (PreviewPoint | null)[];
  previewWidth: number;
  previewHeight: number;
}) {
  const [meteringViewPoint] = useCameraPointsInView(cameraRef, meteringCameraPoints, previewWidth, previewHeight);
  if (!meteringViewPoint) return null;
  return (
    <View
      pointerEvents="none"
      style={[
        styles.meteringMarker,
        { left: meteringViewPoint.x - meteringMarkerRadius, top: meteringViewPoint.y - meteringMarkerRadius },
      ]}
    />
  );
}

function StepperRow({
  label,
  decreaseLabel,
  increaseLabel,
  onDecrease,
  onIncrease,
  isDecreaseDisabled,
  isIncreaseDisabled,
}: {
  label: string;
  decreaseLabel: string;
  increaseLabel: string;
  onDecrease(): void;
  onIncrease(): void;
  isDecreaseDisabled: boolean;
  isIncreaseDisabled: boolean;
}) {
  return (
    <View style={styles.stepperRow}>
      <View style={styles.stepperButton}>
        <AppButton label={decreaseLabel} onPress={onDecrease} isDisabled={isDecreaseDisabled} variant="secondary" />
      </View>
      <BodyText style={styles.stepperLabel}>{label}</BodyText>
      <View style={styles.stepperButton}>
        <AppButton label={increaseLabel} onPress={onIncrease} isDisabled={isIncreaseDisabled} variant="secondary" />
      </View>
    </View>
  );
}

function ChoiceChips<TOption extends string | number>({
  options,
  selectedOption,
  labelFor,
  onSelect,
}: {
  options: readonly TOption[];
  selectedOption: TOption;
  labelFor(option: TOption): string;
  onSelect(option: TOption): void;
}) {
  const themePalette = useThemePalette();
  return (
    <View style={styles.chipRow}>
      {options.map((option) => {
        const isSelected = option === selectedOption;
        return (
          <Pressable
            key={String(option)}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected }}
            onPress={() => onSelect(option)}
            style={[styles.chip, { borderColor: isSelected ? themePalette.accent : themePalette.border }]}>
            <BodyText tone={isSelected ? 'accent' : 'secondary'}>{labelFor(option)}</BodyText>
          </Pressable>
        );
      })}
    </View>
  );
}

export function SuperzoomScreen({ saveMeasurement, sensorAvailability }: InstrumentScreenProps<SuperzoomMeasurementValues>) {
  const { t } = useTranslation(superzoomInstrumentId);
  const cameraRef = useRef<CameraRef>(null);
  const cameraDevice = useCameraDevice('back');
  const isCameraAllowed = useIsCameraAllowed();
  const hasGyroscope = sensorAvailability.gyroscope.status === 'available';
  const { isSteadyForDisplay } = useDeviceSteadiness(isCameraAllowed, hasGyroscope);
  const photoBurst = usePhotoBurst();
  const { isCapturing, captureProgress, stopCapture, uprightPhotoSize } = photoBurst;
  const {
    zoomFactor,
    minimumZoom,
    maximumZoom,
    setRequestedZoom,
    exposureBias,
    handleCameraStarted: handleZoomCameraStarted,
  } = useCameraZoomAndExposure(cameraRef, cameraDevice);
  const resultImageViewer = useResultImageViewer();
  const focusTuning = useSuperzoomFocusTuning(cameraRef, cameraDevice, photoBurst.captureBurst);

  function handleCameraStarted() {
    handleZoomCameraStarted();
    photoBurst.handleCameraStarted();
  }

  // Enfoque fijado: se guarda el punto en coordenadas de cámara para dibujarlo bien a cualquier tamaño.
  const [isMeteringLocked, setIsMeteringLocked] = useState(false);
  const [meteringCameraPoints, setMeteringCameraPoints] = useState<(PreviewPoint | null)[]>([null]);
  // Cambia con cada resultado nuevo: en pantalla completa abre el panel para verlo.
  const [resultSequenceNumber, setResultSequenceNumber] = useState(0);
  const [countdownSecondsLeft, setCountdownSecondsLeft] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [superzoomOutcome, setSuperzoomOutcome] = useState<SuperzoomOutcome | null>(null);
  const [displayedVersion, setDisplayedVersion] = useState<DisplayedVersion>('superzoom');
  const [sharpeningLevelIndex, setSharpeningLevelIndex] = useState(defaultSharpeningLevelIndex);
  const [sharpeningMethod, setSharpeningMethod] = useState<SharpeningMethod>('deconvolution');
  const [localAlignmentChoice, setLocalAlignmentChoice] = useState<OnOffChoice>('on');
  const [chromaticCorrectionMode, setChromaticCorrectionMode] = useState<ChromaticCorrectionMode>('auto');
  const [focusTuningChoice, setFocusTuningChoice] = useState<OnOffChoice>('off');
  const [cropSizeOptionIndex, setCropSizeOptionIndex] = useState(defaultCropSizeOptionIndex);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  // La captura espera varias veces (cuenta atrás, ráfaga): si se sale de la pantalla entretanto,
  // no se sigue (ni se ocupa el hilo JS fusionando) en la pantalla siguiente.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Se realza al mostrar (con el mismo método y nivel en las dos versiones, para compararlas con
  // justicia). La deconvolución del superzoom ya viene calculada; la del fotograma suelto, al mirarla.
  const displayedSkiaImage = useMemo(() => {
    if (!superzoomOutcome) return null;
    return createSkiaImage(
      sharpenedImageFor(superzoomOutcome, displayedVersion, sharpeningMethod, sharpeningLevelIndex),
    );
  }, [superzoomOutcome, displayedVersion, sharpeningMethod, sharpeningLevelIndex]);

  const cropSizePixels =
    cropSizeOptions[cropSizeOptionIndex]?.cropSizePixels ?? cropSizeOptions[defaultCropSizeOptionIndex].cropSizePixels;
  const isFrameLargeEnough = Math.min(uprightPhotoSize.width, uprightPhotoSize.height) >= cropSizePixels;
  const canMeter = Boolean(cameraDevice?.supportsExposureMetering || cameraDevice?.supportsFocusMetering);
  const isBusy = isCapturing || isProcessing || focusTuning.isRunning || countdownSecondsLeft !== null;

  async function handlePreviewPress(pressEvent: GestureResponderEvent) {
    // Reenfocar a mitad de ráfaga haría que los fotogramas dejaran de casar.
    if (!canMeter || !cameraDevice || isBusy) return;
    const viewPoint = { x: pressEvent.nativeEvent.locationX, y: pressEvent.nativeEvent.locationY };
    const meteringModes: MeteringMode[] = [];
    if (cameraDevice.supportsExposureMetering) meteringModes.push('AE');
    if (cameraDevice.supportsFocusMetering) meteringModes.push('AF');
    let meteringCameraPoint: PreviewPoint | null = null;
    try {
      meteringCameraPoint = cameraRef.current?.convertViewPointToCameraPoint(viewPoint) ?? null;
    } catch {
      // La vista previa aún no está lista: se enfoca igual, pero sin dibujar el recuadro.
    }
    setIsMeteringLocked(true);
    setMeteringCameraPoints([meteringCameraPoint]);
    try {
      // Enfoque y exposición fijos: si cambian durante la ráfaga, los fotogramas no casan.
      await cameraRef.current?.focusTo(viewPoint, {
        modes: meteringModes,
        responsiveness: 'snappy',
        adaptiveness: 'locked',
        autoResetAfter: null,
      });
      if (exposureBias !== undefined) await cameraRef.current?.controller?.setExposureBias(exposureBias);
    } catch {
      // Cancelado por otro toque o no admitido: la vista previa sigue funcionando.
    }
  }

  async function handleUnlockMetering() {
    setIsMeteringLocked(false);
    setMeteringCameraPoints([null]);
    try {
      await cameraRef.current?.resetFocus();
    } catch {
      // La cámara puede no estar lista; no hay nada que deshacer.
    }
  }

  function handleCameraError(cameraError: Error) {
    if (isExpectedCameraInterruption(cameraError)) return;
    setStatusMessage(t('core:common.error', { message: cameraError.message }));
  }

  async function handleCapture() {
    const captureZoomFactor = zoomFactor;
    const captureCropSizePixels = cropSizePixels;
    const captureUsesLocalAlignment = localAlignmentChoice === 'on';
    const captureChromaticCorrectionMode = chromaticCorrectionMode;
    const shouldTuneFocus = focusTuningChoice === 'on' && focusTuning.isSupported;
    const planCrop = (photoSize: PixelSize) => centeredSquareCrop(photoSize, captureCropSizePixels);
    setSuperzoomOutcome(null);
    setStatusMessage(null);
    for (let secondsLeft = captureCountdownSeconds; secondsLeft > 0; secondsLeft--) {
      setCountdownSecondsLeft(secondsLeft);
      await waitMilliseconds(1000);
      if (!isMountedRef.current) return;
    }
    setCountdownSecondsLeft(null);
    // Con poca luz, la exposición automática alarga el tiempo y cada foto sale movida: se acorta
    // (subiendo el ISO) si el móvil lo permite. El ruido lo quita la fusión; lo movido, no.
    let hasChangedExposure = false;
    try {
      hasChangedExposure =
        (await applyHandheldBurstExposure(
          cameraRef.current?.controller,
          cameraDevice?.supportsExposureLocking ?? false,
        )) !== null;
    } catch {
      // No admitido: se dispara con la exposición automática.
    }
    // Balance de blancos congelado: si cambia entre fotos, al fusionar quedan manchas de color
    // (además, al procesar se igualan las medias de color de todas las fotos).
    let hasLockedWhiteBalance = false;
    if (cameraDevice?.supportsWhiteBalanceLocking) {
      try {
        await cameraRef.current?.controller?.lockCurrentWhiteBalance();
        hasLockedWhiteBalance = true;
      } catch {
        // No admitido en este móvil: el igualado de color al procesar lo compensa.
      }
    }
    let focusTuningOutcome: FocusTuningOutcome | null = null;
    let burstResult;
    try {
      if (shouldTuneFocus) {
        try {
          focusTuningOutcome = await focusTuning.tuneFocus(planCrop);
        } catch {
          // Si el enfoque manual falla, se dispara con el que hubiera.
        }
        if (!isMountedRef.current) return;
      }
      burstResult = await photoBurst.captureBurst({ photoCount: capturedPhotoTarget, planCrop });
    } catch (burstError) {
      setStatusMessage(t('core:common.error', { message: String(burstError) }));
      return;
    } finally {
      // Si el usuario no había fijado el enfoque, se vuelve a la exposición, el enfoque y el
      // balance automáticos.
      const hasChangedCameraSettings = hasChangedExposure || hasLockedWhiteBalance || shouldTuneFocus;
      if (hasChangedCameraSettings && !isMeteringLocked) cameraRef.current?.resetFocus().catch(() => undefined);
    }
    if (!isMountedRef.current) return;
    // Todas las fotos tienen el mismo tamaño, pero por si acaso solo se fusionan las del primero.
    const firstCropWidth = burstResult.crops[0]?.width ?? 0;
    const squareCrops = burstResult.crops.filter(
      (photoCrop) => photoCrop.width === firstCropWidth && photoCrop.height === firstCropWidth,
    );
    if (squareCrops.length === 0) {
      setStatusMessage(
        burstResult.firstErrorMessage
          ? t('burstFailed', { message: burstResult.firstErrorMessage })
          : t('noFramesCaptured'),
      );
      return;
    }
    setIsProcessing(true);
    // Deja que se pinte el indicador antes del cálculo, que ocupa el hilo JS unos segundos.
    await waitMilliseconds(50);
    if (!isMountedRef.current) return;
    try {
      const firstCrop = squareCrops[0]!;
      const processing = processSuperzoomBurst(
        squareCrops.map((photoCrop) => photoCrop.rgbPixels),
        firstCropWidth,
        {
          useLocalAlignment: captureUsesLocalAlignment,
          chromaticCorrectionMode: captureChromaticCorrectionMode,
          zoomFactor: captureZoomFactor,
          photoWidth: firstCrop.uprightPhotoSize.width,
          photoHeight: firstCrop.uprightPhotoSize.height,
          cropLeft: firstCrop.cropRect.left,
          cropTop: firstCrop.cropRect.top,
        },
      );
      setDisplayedVersion('superzoom');
      setSuperzoomOutcome({
        processing,
        capturedFrameCount: squareCrops.length,
        cropSizePixels: firstCropWidth,
        zoomFactor: captureZoomFactor,
        burstTimings: burstResult.timings,
        hasLockedWhiteBalance,
        focusTuning: focusTuningOutcome,
        wasLocalAlignmentRequested: captureUsesLocalAlignment,
      });
      setResultSequenceNumber((previousSequenceNumber) => previousSequenceNumber + 1);
    } catch (processingError) {
      setStatusMessage(t('core:common.error', { message: String(processingError) }));
    } finally {
      setIsProcessing(false);
    }
  }

  function sharpenedVersion(version: DisplayedVersion): FloatRgbImage | null {
    if (!superzoomOutcome) return null;
    return sharpenedImageFor(superzoomOutcome, version, sharpeningMethod, sharpeningLevelIndex);
  }

  /** Abre el visor a pantalla completa con las dos versiones (se pasa de una a otra deslizando). */
  function handleOpenFullSize() {
    const viewerVersions: DisplayedVersion[] =
      displayedVersion === 'superzoom' ? ['superzoom', 'singleFrame'] : ['singleFrame', 'superzoom'];
    const resultImages = viewerVersions.flatMap((version) => {
      const versionImage = sharpenedVersion(version);
      const versionSkiaImage = versionImage ? createSkiaImage(versionImage) : null;
      return versionSkiaImage
        ? [{ skiaImage: versionSkiaImage, caption: t(`versions.${version}`), fileNamePrefix: `superzoom-${version}` }]
        : [];
    });
    if (resultImages.length > 0) resultImageViewer.openViewer(resultImages);
  }

  async function handleSave() {
    if (!superzoomOutcome) return;
    const sharpenedImage = sharpenedVersion('superzoom');
    const savedSkiaImage = sharpenedImage ? createSkiaImage(sharpenedImage) : null;
    if (!savedSkiaImage) return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const pngFile = writeImageToCachePng(savedSkiaImage, 'superzoom');
      const { processing } = superzoomOutcome;
      const sharpeningLevel = sharpeningLevels[sharpeningLevelIndex];
      const appliedSharpeningMethod = sharpeningLevel?.deconvolutionLevel ? sharpeningMethod : 'none';
      await saveMeasurement({
        values: {
          capturedFrameCount: superzoomOutcome.capturedFrameCount,
          mergedFrameCount: processing.merge.usedFrameCount,
          cropSizePixels: superzoomOutcome.cropSizePixels,
          outputSizePixels: processing.superzoomImage.size,
          zoomFactor: Math.round(superzoomOutcome.zoomFactor * 100) / 100,
          meanShiftPixels: Math.round(processing.merge.meanShiftPixels * 10) / 10,
          sharpeningAmount: appliedSharpeningMethod === 'unsharpMask' ? (sharpeningLevel?.unsharpAmount ?? 0) : 0,
          sharpeningMethod: appliedSharpeningMethod,
          sharpeningLevel: sharpeningLevel?.deconvolutionLevel ?? 'none',
          deconvolutionPsfSigmaPixels: Math.round(processing.superzoomDeconvolution.psfSigmaPixels * 100) / 100,
          locallyAlignedFrameCount: processing.merge.locallyAlignedFrameCount,
          redChromaticScale: Math.round(processing.chromatic.scales.redScale * 10000) / 10000,
          blueChromaticScale: Math.round(processing.chromatic.scales.blueScale * 10000) / 10000,
          processingSeconds: Math.round(processing.timings.totalMilliseconds / 100) / 10,
        },
        attachments: [
          {
            kind: 'photo',
            sourceUri: pngFile.uri,
            fileName: 'superzoom.png',
            mimeType: 'image/png',
            metadata: {
              widthPixels: savedSkiaImage.width(),
              heightPixels: savedSkiaImage.height(),
              mergedFrameCount: processing.merge.usedFrameCount,
            },
          },
        ],
      });
      pngFile.delete();
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  function zoomOut() {
    setRequestedZoom(Math.max(minimumZoom, zoomFactor / zoomStepFactor));
  }

  function zoomIn() {
    setRequestedZoom(Math.min(maximumZoom, zoomFactor * zoomStepFactor));
  }

  const isZoomOutDisabled = zoomFactor <= minimumZoom || isBusy;
  const isZoomInDisabled = zoomFactor >= maximumZoom || isBusy;
  const captureLabel = t('capture', { count: capturedPhotoTarget });
  const isCaptureDisabled = !isCameraAllowed || !isFrameLargeEnough;

  // Piezas que se reparten de forma distinta en el modo normal y en pantalla completa.
  const focusLockRow = isMeteringLocked ? (
    <View style={styles.buttonRow}>
      <BodyText style={styles.flexText}>{t('focusLocked')}</BodyText>
      <View style={styles.unlockButton}>
        <AppButton label={t('unlockFocus')} onPress={() => void handleUnlockMetering()} variant="secondary" />
      </View>
    </View>
  ) : null;
  const frameTooSmallText = !isFrameLargeEnough ? <BodyText tone="danger">{t('frameTooSmall')}</BodyText> : null;
  const steadinessText =
    hasGyroscope && !isBusy ? (
      <BodyText tone={isSteadyForDisplay ? 'secondary' : 'danger'}>
        {t(isSteadyForDisplay ? 'deviceSteady' : 'deviceMoving')}
      </BodyText>
    ) : null;
  const cropSizeChooser = !isBusy ? (
    <>
      <BodyText tone="secondary">{t('cropSizeTitle')}</BodyText>
      <ChoiceChips<number>
        options={cropSizeOptions.map((_option, optionIndex) => optionIndex)}
        selectedOption={cropSizeOptionIndex}
        labelFor={(optionIndex) => t(cropSizeOptions[optionIndex]?.labelKey ?? 'cropSizes.medium')}
        onSelect={setCropSizeOptionIndex}
      />
      <BodyText tone="secondary">{t('localAlignmentTitle')}</BodyText>
      <ChoiceChips<OnOffChoice>
        options={onOffChoices}
        selectedOption={localAlignmentChoice}
        labelFor={(choice) => t(`choices.${choice}`)}
        onSelect={setLocalAlignmentChoice}
      />
      <BodyText tone="secondary">{t('chromaticTitle')}</BodyText>
      <ChoiceChips<ChromaticCorrectionMode>
        options={chromaticCorrectionModes}
        selectedOption={chromaticCorrectionMode}
        labelFor={(mode) => t(`chromaticModes.${mode}`)}
        onSelect={setChromaticCorrectionMode}
      />
      <BodyText tone="secondary">{t('focusTuningTitle')}</BodyText>
      {focusTuning.isSupported ? (
        <ChoiceChips<OnOffChoice>
          options={onOffChoices}
          selectedOption={focusTuningChoice}
          labelFor={(choice) => t(`choices.${choice}`)}
          onSelect={setFocusTuningChoice}
        />
      ) : (
        <BodyText tone="secondary">{t('focusTuningUnavailable')}</BodyText>
      )}
    </>
  ) : null;
  const processingIndicator = isProcessing ? <LoadingState label={t('processing')} /> : null;
  const resultSection =
    superzoomOutcome && displayedSkiaImage ? (
      <>
        <SectionTitle>{t('resultTitle')}</SectionTitle>
        <ChoiceChips<DisplayedVersion>
          options={['superzoom', 'singleFrame']}
          selectedOption={displayedVersion}
          labelFor={(version) => t(`versions.${version}`)}
          onSelect={setDisplayedVersion}
        />
        <Pressable accessibilityRole="button" accessibilityLabel={t('openFullSize')} onPress={handleOpenFullSize}>
          <ResultImage label={t(`versions.${displayedVersion}`)} skiaImage={displayedSkiaImage} />
        </Pressable>
        <AppButton label={t('openFullSize')} onPress={handleOpenFullSize} variant="secondary" />
        <BodyText tone="secondary">{t('compareHint')}</BodyText>
        <BodyText tone="secondary">{t('sharpeningTitle')}</BodyText>
        <ChoiceChips<SharpeningMethod>
          options={sharpeningMethods}
          selectedOption={sharpeningMethod}
          labelFor={(method) => t(`sharpeningMethods.${method}`)}
          onSelect={setSharpeningMethod}
        />
        <ChoiceChips<number>
          options={sharpeningLevels.map((_level, levelIndex) => levelIndex)}
          selectedOption={sharpeningLevelIndex}
          labelFor={(levelIndex) => t(sharpeningLevels[levelIndex]?.labelKey ?? 'sharpening.none')}
          onSelect={setSharpeningLevelIndex}
        />
        <BodyText tone="secondary">{t('sharpeningMethodHint')}</BodyText>
        <BodyText tone="secondary">
          {t('mergeExplanation', {
            captured: superzoomOutcome.capturedFrameCount,
            merged: superzoomOutcome.processing.merge.usedFrameCount,
            size: superzoomOutcome.processing.superzoomImage.size,
            seconds: secondsText(superzoomOutcome.processing.timings.totalMilliseconds),
          })}
        </BodyText>
        <BodyText tone="secondary">
          {t('processingTimings', {
            alignSeconds: secondsText(
              superzoomOutcome.processing.timings.selectionMilliseconds + superzoomOutcome.processing.timings.globalAlignmentMilliseconds,
            ),
            localSeconds: secondsText(superzoomOutcome.processing.timings.localAlignmentMilliseconds),
            mergeSeconds: secondsText(superzoomOutcome.processing.timings.mergeMilliseconds),
            chromaticSeconds: secondsText(superzoomOutcome.processing.timings.chromaticMilliseconds),
            sharpeningSeconds: secondsText(superzoomOutcome.processing.timings.deconvolutionMilliseconds),
          })}
        </BodyText>
        <ImprovementsSummary outcome={superzoomOutcome} />
        <BodyText tone="secondary">
          {t('burstTimings', {
            count: superzoomOutcome.burstTimings.capturedPhotoCount,
            captureSeconds: (superzoomOutcome.burstTimings.captureMilliseconds / 1000).toFixed(1),
            decodeSeconds: (superzoomOutcome.burstTimings.decodeMilliseconds / 1000).toFixed(1),
          })}
        </BodyText>
        <BodyText tone="secondary">
          {superzoomOutcome.processing.merge.meanShiftPixels < 0.5
            ? t('tooLittleMovement')
            : t('handMovement', { shift: superzoomOutcome.processing.merge.meanShiftPixels.toFixed(1) })}
        </BodyText>
        <AppButton label={t('core:common.save')} onPress={() => void handleSave()} isBusy={isSaving} />
      </>
    ) : null;
  const statusText = statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null;
  const howItWorksText = (
    <BodyText tone="secondary" style={styles.smallText}>
      {t('howItWorks')}
    </BodyText>
  );

  let progressText = '';
  if (focusTuning.progress) {
    progressText = t('focusTuningProgress', {
      measured: focusTuning.progress.measuredCount + 1,
      planned: focusTuning.progress.plannedCount,
    });
  } else if (captureProgress) {
    progressText = t(captureProgress.phase === 'capturing' ? 'capturingProgress' : 'decodingProgress', {
      captured: captureProgress.completedCount,
      target: captureProgress.totalCount,
    });
  }
  const isShowingProgress = (isCapturing && captureProgress !== null) || focusTuning.isRunning;

  // Lectura flotante en pantalla completa: cuenta atrás, progreso de la ráfaga o zoom y pulso.
  let fullScreenReadout: ReactNode;
  if (countdownSecondsLeft !== null) {
    fullScreenReadout = (
      <>
        <CameraOverlayText>{t('holdStill')}</CameraOverlayText>
        <CameraOverlayText style={styles.readoutCountdown}>{countdownSecondsLeft}</CameraOverlayText>
      </>
    );
  } else if (isShowingProgress) {
    fullScreenReadout = <CameraOverlayText style={styles.readoutValue}>{progressText}</CameraOverlayText>;
  } else if (isProcessing) {
    fullScreenReadout = <CameraOverlayText>{t('processing')}</CameraOverlayText>;
  } else {
    fullScreenReadout = (
      <>
        <CameraOverlayText style={styles.readoutValue}>{t('zoomLabel', { zoom: zoomFactor.toFixed(1) })}</CameraOverlayText>
        {!isFrameLargeEnough ? (
          <CameraOverlayText style={styles.readoutWarning}>{t('frameTooSmall')}</CameraOverlayText>
        ) : hasGyroscope ? (
          <CameraOverlayText style={isSteadyForDisplay ? undefined : styles.readoutWarning}>
            {t(isSteadyForDisplay ? 'deviceSteady' : 'deviceMoving')}
          </CameraOverlayText>
        ) : null}
      </>
    );
  }

  return (
    <CameraScreenLayout
      title={t('name')}
      aboveNormalPreview={<BodyText tone="secondary">{t('intro')}</BodyText>}
      renderPreview={({ previewWidth, previewHeight }) => (
        <>
          <Camera
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            device={cameraDevice ?? 'back'}
            isActive={isCameraAllowed}
            outputs={[photoBurst.photoOutput]}
            // Fotos orientadas como la pantalla (vertical), no según cómo se sujete el móvil.
            orientationSource="interface"
            zoom={zoomFactor}
            exposure={exposureBias}
            onError={handleCameraError}
            onStarted={handleCameraStarted}
            resizeMode="contain"
          />
          {previewWidth > 0 && previewHeight > 0 ? (
            <CropFrameOverlay
              previewWidth={previewWidth}
              previewHeight={previewHeight}
              photoSize={uprightPhotoSize}
              cropSizePixels={cropSizePixels}
            />
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('tapToFocusHint')}
            accessibilityState={{ disabled: isBusy }}
            disabled={isBusy}
            style={StyleSheet.absoluteFill}
            onPress={(pressEvent) => void handlePreviewPress(pressEvent)}>
            <MeteringMarker
              cameraRef={cameraRef}
              meteringCameraPoints={meteringCameraPoints}
              previewWidth={previewWidth}
              previewHeight={previewHeight}
            />
          </Pressable>
          {/* Aquí porque la vista previa está montada en los dos modos (el visor es un Modal). */}
          {resultImageViewer.openedIndex !== null ? (
            <Suspense fallback={null}>
              <ImageViewer
                images={resultImageViewer.viewerImages}
                openedIndex={resultImageViewer.openedIndex}
                onClose={resultImageViewer.closeViewer}
              />
            </Suspense>
          ) : null}
        </>
      )}
      topActions={
        isMeteringLocked ? (
          <CameraOverlayButton
            label={t('unlockFocus')}
            accessibilityLabel={`${t('focusLocked')} ${t('unlockFocus')}`}
            onPress={() => void handleUnlockMetering()}
          />
        ) : null
      }
      readout={fullScreenReadout}
      primaryActions={
        <>
          <View style={styles.primaryActionCell}>
            <AppButton label={t('zoomOut')} onPress={zoomOut} isDisabled={isZoomOutDisabled} variant="secondary" />
          </View>
          <View style={styles.captureActionCell}>
            {isCapturing ? (
              <AppButton label={t('stopCapture')} onPress={stopCapture} variant="danger" />
            ) : (
              <AppButton
                label={captureLabel}
                onPress={() => void handleCapture()}
                isDisabled={isCaptureDisabled}
                isBusy={isBusy}
              />
            )}
          </View>
          <View style={styles.primaryActionCell}>
            <AppButton label={t('zoomIn')} onPress={zoomIn} isDisabled={isZoomInDisabled} variant="secondary" />
          </View>
        </>
      }
      panelContent={
        <>
          <BodyText tone="secondary">{t('tapToFocusHint')}</BodyText>
          {focusLockRow}
          {frameTooSmallText}
          {steadinessText}
          <BodyText tone="secondary">{t('zoomHint')}</BodyText>
          {cropSizeChooser}
          {processingIndicator}
          {resultSection}
          {statusText}
          {howItWorksText}
        </>
      }
      panelOpenRequestKey={resultSequenceNumber > 0 ? resultSequenceNumber : null}>
      <BodyText tone="secondary">{t('tapToFocusHint')}</BodyText>
      {focusLockRow}
      {frameTooSmallText}
      {steadinessText}

      <StepperRow
        label={t('zoomLabel', { zoom: zoomFactor.toFixed(1) })}
        decreaseLabel={t('zoomOut')}
        increaseLabel={t('zoomIn')}
        onDecrease={zoomOut}
        onIncrease={zoomIn}
        isDecreaseDisabled={isZoomOutDisabled}
        isIncreaseDisabled={isZoomInDisabled}
      />
      <BodyText tone="secondary">{t('zoomHint')}</BodyText>

      {cropSizeChooser}

      {countdownSecondsLeft !== null ? (
        <Card style={styles.centeredCard}>
          <BodyText tone="secondary">{t('holdStill')}</BodyText>
          <BodyText style={styles.countdownValue}>{countdownSecondsLeft}</BodyText>
        </Card>
      ) : null}
      {isShowingProgress ? (
        <View style={styles.buttonRow}>
          <BodyText style={styles.flexText}>{progressText}</BodyText>
          <View style={styles.unlockButton}>
            <AppButton label={t('stopCapture')} onPress={stopCapture} variant="secondary" />
          </View>
        </View>
      ) : null}
      {processingIndicator}
      {!isBusy ? <AppButton label={captureLabel} onPress={() => void handleCapture()} isDisabled={isCaptureDisabled} /> : null}

      {resultSection}
      {statusText}
      {howItWorksText}
    </CameraScreenLayout>
  );
}

/** Qué mejoras se han aplicado a esta ráfaga, con sus cifras. */
function ImprovementsSummary({ outcome }: { outcome: SuperzoomOutcome }) {
  const { t } = useTranslation(superzoomInstrumentId);
  const { merge, chromatic, superzoomDeconvolution } = outcome.processing;
  const improvementLines: string[] = [];

  if (merge.locallyAlignedFrameCount > 0) {
    improvementLines.push(
      t('improvements.localAlignment', {
        frames: merge.locallyAlignedFrameCount,
        points: merge.alignmentPointCount,
        rotation: merge.meanRotationDegrees.toFixed(2),
        correction: merge.meanMaximumLocalCorrectionPixels.toFixed(1),
      }),
    );
  } else {
    improvementLines.push(t(outcome.wasLocalAlignmentRequested ? 'improvements.localAlignmentNone' : 'improvements.localAlignmentOff'));
  }
  improvementLines.push(
    t(outcome.hasLockedWhiteBalance ? 'improvements.whiteBalanceLocked' : 'improvements.whiteBalanceNotLocked', {
      percent: (merge.largestColorGainDeviation * 100).toFixed(1),
    }),
  );
  if (outcome.focusTuning) {
    improvementLines.push(
      t('improvements.focusTuned', {
        count: outcome.focusTuning.testPhotoCount,
        position: outcome.focusTuning.bestLensPosition.toFixed(3),
      }),
    );
  }
  const chromaticValues = {
    red: chromatic.scales.redScale.toFixed(4),
    blue: chromatic.scales.blueScale.toFixed(4),
  };
  if (chromatic.mode === 'off') {
    improvementLines.push(t('improvements.chromaticOff'));
  } else if (chromatic.mode === 'profile') {
    improvementLines.push(t('improvements.chromaticProfile', chromaticValues));
  } else if (chromatic.isRedReliable || chromatic.isBlueReliable) {
    improvementLines.push(t('improvements.chromaticMeasured', chromaticValues));
  } else {
    improvementLines.push(t('improvements.chromaticNothingMeasured'));
  }
  improvementLines.push(t('improvements.deconvolution', { sigma: superzoomDeconvolution.psfSigmaPixels.toFixed(2) }));

  return (
    <>
      <BodyText tone="secondary">{t('improvementsTitle')}</BodyText>
      {improvementLines.map((improvementLine) => (
        <BodyText key={improvementLine} tone="secondary" style={styles.smallText}>
          {`• ${improvementLine}`}
        </BodyText>
      ))}
    </>
  );
}

function ResultImage({ label, skiaImage }: { label: string; skiaImage: SkImage }) {
  const [imageSide, setImageSide] = useState(0);
  return (
    <View
      style={styles.resultImageFrame}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      onLayout={(layoutEvent: LayoutChangeEvent) => setImageSide(layoutEvent.nativeEvent.layout.width)}>
      {imageSide > 0 ? (
        <Canvas style={{ width: imageSide, height: imageSide }}>
          <SkiaImageView image={skiaImage} x={0} y={0} width={imageSide} height={imageSide} fit="contain" />
        </Canvas>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  cropFrame: { position: 'absolute', borderWidth: 2, borderColor: '#FACC15', borderRadius: 4 },
  meteringMarker: {
    position: 'absolute',
    width: meteringMarkerRadius * 2,
    height: meteringMarkerRadius * 2,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#4ADE80',
  },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepperButton: { width: 110 },
  stepperLabel: { flex: 1, textAlign: 'center', fontWeight: '600', fontVariant: ['tabular-nums'] },
  buttonRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flexText: { flex: 1 },
  unlockButton: { width: 110 },
  centeredCard: { alignItems: 'center', paddingVertical: 16, gap: 4 },
  countdownValue: { fontSize: 48, lineHeight: 56, fontWeight: '700', fontVariant: ['tabular-nums'] },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
  resultImageFrame: { width: '100%', aspectRatio: 1, backgroundColor: '#000000', borderRadius: 8, overflow: 'hidden' },
  smallText: { fontSize: 13 },
  primaryActionCell: { flex: 1 },
  captureActionCell: { flex: 1.6 },
  readoutCountdown: { fontSize: 40, lineHeight: 46, fontWeight: '700', fontVariant: ['tabular-nums'] },
  readoutValue: { fontSize: 18, lineHeight: 24, fontWeight: '700', fontVariant: ['tabular-nums'] },
  readoutWarning: { color: '#FCA5A5' },
});
