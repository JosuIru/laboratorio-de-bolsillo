import type { SkImage } from '@shopify/react-native-skia';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type GestureResponderEvent, type LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';
import { Camera, type CameraRef, type MeteringMode, useCameraDevice } from 'react-native-vision-camera';

import { formatExposureValue, stepExposure } from '@/core/camera/exposureScale';
import { writeImageToCachePng } from '@/core/camera/imageFiles';
import { type PixelSize, scalePointBetweenImages, squareCropAround } from '@/core/camera/photoCropGeometry';
import { containedFrameRect } from '@/core/camera/previewGeometry';
import { useCameraZoomAndExposure } from '@/core/camera/useCameraZoomAndExposure';
import { useDeviceSteadiness } from '@/core/camera/useDeviceSteadiness';
import { type PhotoBurstCrop, type PhotoBurstRequest, type PhotoBurstTimings, usePhotoBurst } from '@/core/camera/usePhotoBurst';
import { useResultImageViewer } from '@/core/camera/useResultImageViewer';
import type { InstrumentScreenProps } from '@/core/instruments/types';
import type { Measurement } from '@/core/measurements/types';
import { isExpectedCameraInterruption } from '@/core/sensors/cameraErrors';
import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import { julianDayFromDate } from '@/processing/astronomy/moonEphemeris';
import { sharpeningSigmaForScale } from '@/processing/image/burstSuperResolution';
import { DngFormatProblem } from '@/processing/image/dngDecoder';
import type { GrayImage } from '@/processing/image/grayImage';
import { enhanceWithWavelets } from '@/processing/image/luckyImaging';
import { fitLunarDisk } from '@/processing/image/lunarDiskFit';
import { formatExposureDuration, initialLunarExposureSeconds } from '@/processing/image/lunarExposure';
import { locateMoonInRegion, medianValue, moonCropFromRegion, moonSearchRegionSide } from '@/processing/image/lunarPhotoCrops';
import {
  type AlignedCrop,
  chooseCropSize,
  type FloatRgbImage,
  sharpenImage,
  sharpeningSigmaForCropSize,
  stackSharpestCrops,
} from '@/processing/image/lunarStacking';
import { stackMonoFramesOnDisk } from '@/processing/image/rawGreenStack';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { ApparentSizeExperiment, type SizeMeasurementSource } from './experiments/ApparentSizeExperiment';
import { EarthAlbedoExperiment, type EarthshineMeasurementSource } from './experiments/EarthAlbedoExperiment';
import { OccultationExperiment } from './experiments/OccultationExperiment';
import { GlassesTelescopeGuide } from './GlassesTelescopeGuide';
import { moonInstrumentId } from './instrumentId';
import {
  atlasLanguageFor,
  computeAtlasOrientation,
  grayImageFromFloatRgb,
  type ManualImageCorrection,
} from './moonAtlas';
import { AtlasControls, MoonAtlasView } from './MoonAtlasView';
import {
  earthshineRegionSide,
  floatRgbFromGray,
  fullDiskRadiusFromBrightArea,
  planDriftCropSide,
  planEarthshineExposures,
  planLuckyFrameCrop,
  waveletGainsBySharpeningLevel,
} from './moonCapturePlanning';
import { MoonCaptureAssistant } from './MoonCaptureAssistant';
import { MoonInfoCard, useMoonReport, useObserverLocation } from './MoonInfoCard';
import { MoonResultProcessingControls } from './MoonResultProcessingControls';
import {
  ChipSelector,
  PointingOverlay,
  ResultImage,
  StepperRow,
  TelescopeGuideOverlay,
  ToggleChip,
} from './MoonScreenParts';
import { type DriftPhoto, fuseDriftPhotos, fuseEarthshineBursts, stackLuckyRecording } from './moonTechniques';
import { type RawMoonFrame, readRawMoonFrame } from './rawMoonFiles';
import { expectedRawMoonRadius, planRawMoonRegion } from './rawMoonPlanning';
import { srgbImageFromLinearGray } from './resultProcessing';
import type { MoonMeasurementValues } from './schema';
import { createSkiaImage } from './stackedImage';
import { useDaylightWhiteBalance } from './useDaylightWhiteBalance';
import { useDeviceRoll } from './useDeviceRoll';
import { useFocusBracketing } from './useFocusBracketing';
import { type LiveMoonDetection, useMoonFrames } from './useMoonFrames';
import { useLunarManualExposure } from './useLunarManualExposure';
import { useMoonPointingGuide } from './useMoonPointingGuide';
import { useMoonResultProcessing } from './useMoonResultProcessing';

/**
 * El visor se carga al abrirlo: arrastra módulos nativos (galería, compartir) que no hacen falta
 * hasta entonces y que no existen en los tests que importan todos los instrumentos.
 */
const ImageViewer = lazy(() => import('@/ui/ImageViewer').then((viewerModule) => ({ default: viewerModule.ImageViewer })));

const previewHeight = 340;

/**
 * Modos de la pantalla:
 *  - normal: ráfaga de fotos a pulso con el móvil solo.
 *  - tripod: un minuto de fotos con el móvil quieto; la deriva de la Luna da superresolución.
 *  - telescope: el móvil en el ocular de unos prismáticos o un telescopio (ráfaga de fotos o
 *    muchos fotogramas de vídeo para la imagen afortunada).
 *  - earthshine: luz cenicienta, con una ráfaga corta y otra larga fusionadas.
 */
type MoonShootingMode = 'normal' | 'tripod' | 'telescope' | 'earthshine';
const shootingModes: readonly MoonShootingMode[] = ['normal', 'tripod', 'telescope', 'earthshine'];

/**
 * Sin óptica, la cámara del móvil ve la Luna de unas decenas de píxeles: fase y mares. Con el
 * móvil en el ocular de unos prismáticos o un telescopio («digiscoping») la Luna es mucho más
 * grande y se ven cráteres; se apilan más fotos y se realza más.
 */
type MoonOptics = 'nakedEye' | 'telescope';

function opticsForMode(shootingMode: MoonShootingMode): MoonOptics {
  return shootingMode === 'telescope' ? 'telescope' : 'nakedEye';
}

/** En modo telescopio: ráfaga de fotos a resolución completa o fotogramas de vídeo. */
type TelescopeMethod = 'photoBurst' | 'luckyFrames';

/** Técnica con la que se obtuvo un resultado (se guarda con la medida). */
type CaptureTechnique = 'photoBurst' | 'luckyImaging' | 'driftSuperResolution' | 'earthshine';

interface OpticsSettings {
  /** Fotos de cada ráfaga, a resolución completa (unos 3-6 s). */
  photoCount: number;
  /** Lado máximo del recorte que se apila (el cálculo crece con el área). */
  maximumStackCropSize: number;
  defaultSharpeningLevelIndex: number;
  /** Exposición con la que empieza el ajuste automático sobre la Luna. */
  initialExposureSeconds: number;
}

const opticsSettings: Record<MoonOptics, OpticsSettings> = {
  nakedEye: {
    photoCount: 12,
    maximumStackCropSize: 600,
    defaultSharpeningLevelIndex: 2,
    initialExposureSeconds: initialLunarExposureSeconds,
  },
  telescope: {
    photoCount: 20,
    maximumStackCropSize: 1024,
    defaultSharpeningLevelIndex: 3,
    // Resuelta por el ocular, la Luna no se reparte en un borrón: sus píxeles salen más claros.
    initialExposureSeconds: initialLunarExposureSeconds / 2,
  },
};
/** Fracción más nítida que se apila; el resto se descarta por la turbulencia o el temblor. */
const keptFrameFraction = 0.5;
/** Zonas de búsqueda más grandes se reducen (en nativo) a este lado antes de pasarlas a JS. */
const maximumSearchRegionOutputSide = 1024;
/** Detecciones con un radio muy distinto del típico de la ráfaga son reflejos o errores. */
const radiusToleranceFraction = 0.3;
/** Niveles de realce del detalle que se pueden elegir tras apilar. */
const sharpeningLevels = [
  { labelKey: 'sharpening.none', amount: 0 },
  { labelKey: 'sharpening.soft', amount: 0.6 },
  { labelKey: 'sharpening.medium', amount: 1.2 },
  { labelKey: 'sharpening.strong', amount: 2 },
] as const;
/** Cuenta atrás antes de capturar, para que el toque en la pantalla no mueva la imagen. */
const captureCountdownSeconds = 3;
const zoomStepFactor = Math.SQRT2;
/** Por encima de esta fracción de píxeles saturados, los mares y cráteres se pierden. */
const overexposedSaturatedFraction = 0.02;
/** Brillo máximo (R+G+B) por debajo del cual la Luna sale demasiado oscura. */
const underexposedPeakBrightness = 300;
/** En modo telescopio, a partir de esta distancia al centro (fracción del lado corto) se avisa. */
const offCenterFraction = 0.15;

/** Imagen afortunada: fotogramas de vídeo que se graban (unos 5 s a 30 fps). */
const luckyFrameCount = 150;
/** Con menos fotogramas no merece la pena apilar. */
const minimumLuckyFrameCount = 10;
/** Si la Luna se pierde, la grabación termina sola al cabo de este tiempo. */
const luckyRecordingTimeoutMilliseconds = 30_000;

/** Trípode: duración de la captura y fotos por tanda (se decodifica tras cada tanda). */
const driftDurationSeconds = 60;
const driftPhotosPerBatch = 6;
/** Memoria máxima para los recortes del trípode (RGB de 8 bits). */
const driftMemoryBudgetBytes = 60_000_000;
const driftMaximumPhotoCount = 120;
const minimumDriftPhotoCount = 6;

/** Luz cenicienta: fotos de cada exposición y espera para que la cámara aplique la nueva. */
const earthshinePhotosPerExposure = 8;
const exposureSettleMilliseconds = 700;
/** Por encima de esta fracción iluminada la luz cenicienta apenas se ve. */
const earthshineMaximumIlluminatedFraction = 0.4;

/** RAW: fotos como mucho, memoria para los recortes (verde en coma flotante) y lado supuesto del RAW. */
const rawMaximumPhotoCount = 12;
const rawMinimumPhotoCount = 4;
const rawMemoryBudgetBytes = 48_000_000;
const typicalUprightRawSize: PixelSize = { width: 3072, height: 4096 };
/** Con la Luna pequeña en el RAW, el apilado se hace en una rejilla dos veces más fina. */
const rawUpsampleBelowRadiusPixels = 60;

/** Pestañas de la pantalla: para que no crezca sin control. */
type MoonScreenTab = 'photograph' | 'experiments' | 'help';
const screenTabs: readonly MoonScreenTab[] = ['photograph', 'experiments', 'help'];
type MoonExperiment = 'apparentSize' | 'earthAlbedo' | 'occultation';
const moonExperiments: readonly MoonExperiment[] = ['apparentSize', 'earthAlbedo', 'occultation'];

/** Captura pedida: el modo de la pantalla o el que necesita un experimento. */
interface CaptureRequest {
  shootingMode: MoonShootingMode;
  telescopeMethod: TelescopeMethod;
}

type ResultEnhancement = 'unsharpMask' | 'wavelets' | 'none';

interface StackingOutcome {
  technique: CaptureTechnique;
  /** Resultado sin realzar: el realce se aplica después, según el nivel elegido. */
  baseImage: FloatRgbImage;
  /** Para el realce por ondículas (imagen afortunada): la misma imagen en un canal. */
  baseGrayImage?: GrayImage;
  enhancement: ResultEnhancement;
  sharpeningSigma: number;
  defaultSharpeningLevelIndex: number;
  /** Imagen para comparar (una sola foto o fotograma, o la exposición corta). */
  comparisonSkiaImage: SkImage;
  comparisonLabel: string;
  resultLabel: string;
  /** Explicación y tiempos, ya traducidos. */
  detailLines: string[];
  capturedFrameCount: number;
  stackedFrameCount: number;
  /** Diámetro de la Luna en píxeles de la imagen de partida (foto o fotograma). */
  moonDiameterPixels: number;
  zoomFactor: number;
  optics: MoonOptics;
  captureDate: Date;
  /** Giro del móvil al capturar (para el atlas); null si no se conoce. */
  deviceRollDegrees: number | null;
  exposureBias?: number;
  /** Con exposición manual: tiempo de exposición en segundos e ISO. */
  exposureSeconds?: number;
  iso?: number;
  exposureRatio?: number;
  /** Resultado en color (ráfaga JPEG, trípode): admite corregir el color y la Luna mineral. */
  isColorImage: boolean;
  /** Para el experimento del tamaño: escala del resultado respecto a la común (null si no vale). */
  sizeScale: { resultPixelsPerCommonPixel: number; source: 'jpeg' | 'raw'; linearGrayImage?: GrayImage } | null;
  /** Para el experimento del albedo (solo luz cenicienta). */
  earthshineSource?: EarthshineMeasurementSource;
  /** Ráfaga RAW (canal verde). */
  isRawCapture?: boolean;
}

/** Datos comunes de todo resultado, tomados al empezar la captura (tras la cuenta atrás). */
interface CaptureContext {
  detection: LiveMoonDetection;
  captureDate: Date;
  deviceRollDegrees: number | null;
  zoomFactor: number;
  optics: MoonOptics;
  exposureFields: Pick<StackingOutcome, 'exposureBias' | 'exposureSeconds' | 'iso'>;
}

/** Problema previsto durante la captura: se muestra el texto de la clave indicada. */
class MoonCaptureProblem extends Error {
  constructor(
    readonly messageKey: string,
    readonly messageValues: Record<string, string | number> = {},
  ) {
    super(messageKey);
  }
}

function waitMilliseconds(durationMilliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, durationMilliseconds));
}

function formatSeconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(1);
}

/** Diámetro de la Luna detectada en la vista previa, llevado a píxeles de la foto. */
function moonDiameterInPhotoPixels(detection: LiveMoonDetection, photoSize: PixelSize): number {
  return Math.round(detection.radiusPixels * 2 * (photoSize.width / detection.frameWidth));
}

/** Centro de la Luna de la vista previa llevado a la foto derecha. */
function expectedPhotoCenter(detection: LiveMoonDetection, uprightPhotoSize: PixelSize) {
  return scalePointBetweenImages(
    { x: detection.centerX, y: detection.centerY },
    { width: detection.frameWidth, height: detection.frameHeight },
    uprightPhotoSize,
  );
}

export function MoonScreen({ saveMeasurement, sensorAvailability }: InstrumentScreenProps<MoonMeasurementValues>) {
  const { t, i18n } = useTranslation(moonInstrumentId);
  const themePalette = useThemePalette();
  const cameraRef = useRef<CameraRef>(null);
  const cameraDevice = useCameraDevice('back');
  const isCameraAllowed = useIsCameraAllowed();
  const { observerLocation, isLocating, requestLocation, canAskForLocation } = useObserverLocation(
    sensorAvailability.location,
  );
  const moonReport = useMoonReport(observerLocation);
  const hasGyroscope = sensorAvailability.gyroscope.status === 'available';
  const hasAccelerometer = sensorAvailability.accelerometer.status === 'available';
  const { isDeviceSteady, isSteadyForDisplay } = useDeviceSteadiness(isCameraAllowed, hasGyroscope);
  const readDeviceRollDegrees = useDeviceRoll(isCameraAllowed && hasAccelerometer);
  const [shootingMode, setShootingMode] = useState<MoonShootingMode>('normal');
  const [telescopeMethod, setTelescopeMethod] = useState<TelescopeMethod>('photoBurst');
  const [activeTab, setActiveTab] = useState<MoonScreenTab>('photograph');
  const [selectedExperiment, setSelectedExperiment] = useState<MoonExperiment>('apparentSize');
  // RAW (experimental): solo para las ráfagas de fotos (modo normal o telescopio con fotos).
  const [isRawEnabled, setIsRawEnabled] = useState(false);
  const isRawCompatibleMode = shootingMode === 'normal' || (shootingMode === 'telescope' && telescopeMethod === 'photoBurst');
  const isRawActive = isRawEnabled && isRawCompatibleMode;
  /** Ocultación: dónde está la estrella respecto al centro de la Luna (px del fotograma). */
  const [starOffsetFromMoon, setStarOffsetFromMoon] = useState<{ x: number; y: number } | null>(null);
  const optics = opticsForMode(shootingMode);
  const modeSettings = opticsSettings[optics];
  // Desde la cuenta atrás hasta el final de la captura, la exposición no cambia.
  const [isCaptureInProgress, setIsCaptureInProgress] = useState(false);
  // La captura espera varias veces (cuenta atrás, ráfaga): si se sale de la pantalla entretanto,
  // no se sigue (ni se ocupa el hilo JS apilando) en la pantalla siguiente.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  // La exposición automática mide sobre todo el cielo negro y quema la Luna, incluso con la
  // compensación al mínimo. Si el móvil lo admite, se fija el tiempo de exposición midiendo solo la Luna.
  const lunarManualExposure = useLunarManualExposure(cameraRef, cameraDevice, isCaptureInProgress);
  const moonFrames = useMoonFrames(lunarManualExposure.handleBrightnessReading);
  const { frameOutput, liveDetection } = moonFrames;
  // La captura lee la última detección al empezar (tras la cuenta atrás), no la del toque.
  const latestDetectionRef = useRef<LiveMoonDetection | null>(null);
  useEffect(() => {
    latestDetectionRef.current = liveDetection;
  }, [liveDetection]);
  const photoBurst = usePhotoBurst({ containerFormat: isRawActive ? 'dng' : 'jpeg' });
  const focusBracketing = useFocusBracketing({ cameraRef, cameraDevice, captureBurst: photoBurst.captureBurst });
  const daylightWhiteBalance = useDaylightWhiteBalance(cameraRef, cameraDevice);
  const resultImageViewer = useResultImageViewer();
  const hasOrientationSensors =
    hasAccelerometer && sensorAvailability.magnetometer.status === 'available';
  const pointingGuidance = useMoonPointingGuide(
    moonReport.horizontalPosition,
    isCameraAllowed && hasOrientationSensors && optics === 'nakedEye',
  );

  // La Luna es muy brillante sobre fondo negro: con la exposición automática sale quemada.
  const {
    zoomFactor,
    minimumZoom,
    maximumZoom,
    setRequestedZoom,
    exposureScale,
    exposureBias,
    minimumExposureBias,
    maximumExposureBias,
    setRequestedExposureBias,
    handleCameraStarted: handleZoomAndExposureCameraStarted,
  } = useCameraZoomAndExposure(cameraRef, cameraDevice, true);

  function handleCameraStarted() {
    handleZoomAndExposureCameraStarted();
    lunarManualExposure.handleCameraStarted();
    photoBurst.handleCameraStarted();
    void daylightWhiteBalance.applyDaylightWhiteBalance();
    void focusBracketing.reapplyBestFocus();
  }

  const [meteringViewPoint, setMeteringViewPoint] = useState<{ x: number; y: number } | null>(null);
  const [stackingOutcome, setStackingOutcome] = useState<StackingOutcome | null>(null);
  const [sharpeningLevelIndex, setSharpeningLevelIndex] = useState(opticsSettings.nakedEye.defaultSharpeningLevelIndex);
  const [countdownSecondsLeft, setCountdownSecondsLeft] = useState<number | null>(null);
  /** Texto de la fase de una captura larga (trípode, luz cenicienta). */
  const [captureStageMessage, setCaptureStageMessage] = useState<string | null>(null);
  const isStopRequestedRef = useRef(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [previewSize, setPreviewSize] = useState<PixelSize>({ width: 0, height: 0 });
  const [isAtlasVisible, setIsAtlasVisible] = useState(false);
  const [imageCorrection, setImageCorrection] = useState<ManualImageCorrection>({
    opticsRotationDegrees: 0,
    isMirrored: false,
  });
  const [isGlassesGuideVisible, setIsGlassesGuideVisible] = useState(false);

  // Procesado del resultado (color, deconvolución, Luna mineral). La luz cenicienta ya viene con
  // su curva de tono: no se procesa.
  const resultProcessingInput = useMemo(
    () =>
      stackingOutcome && stackingOutcome.technique !== 'earthshine'
        ? { baseImage: stackingOutcome.baseImage, isColorImage: stackingOutcome.isColorImage }
        : null,
    [stackingOutcome],
  );
  const resultProcessing = useMoonResultProcessing(resultProcessingInput);
  const processedBaseImage = resultProcessing.displayedBaseImage ?? stackingOutcome?.baseImage ?? null;

  const stackedSkiaImage = useMemo(() => {
    if (!stackingOutcome || !processedBaseImage) return null;
    const levelIndex = Math.min(sharpeningLevelIndex, sharpeningLevels.length - 1);
    if (stackingOutcome.enhancement === 'wavelets' && stackingOutcome.baseGrayImage && levelIndex > 0) {
      const levelGains = waveletGainsBySharpeningLevel[levelIndex] ?? [1];
      const grayForWavelets =
        processedBaseImage === stackingOutcome.baseImage ? stackingOutcome.baseGrayImage : grayImageFromFloatRgb(processedBaseImage);
      const enhancedImage = enhanceWithWavelets(grayForWavelets, { levelGains, noiseThresholdSigmas: 1 });
      return createSkiaImage(floatRgbFromGray(enhancedImage));
    }
    const sharpeningAmount = sharpeningLevels[levelIndex]?.amount ?? 0;
    const displayedImage =
      stackingOutcome.enhancement === 'unsharpMask' && sharpeningAmount > 0
        ? sharpenImage(processedBaseImage, stackingOutcome.sharpeningSigma, sharpeningAmount)
        : processedBaseImage;
    return createSkiaImage(displayedImage);
  }, [stackingOutcome, processedBaseImage, sharpeningLevelIndex]);
  const mineralSkiaImage = useMemo(
    () => (resultProcessing.mineralViewImage ? createSkiaImage(resultProcessing.mineralViewImage) : null),
    [resultProcessing.mineralViewImage],
  );

  // Atlas: el disco se ajusta una vez por resultado, y solo si se piden los nombres.
  const atlasDiskFit = useMemo(
    () => (isAtlasVisible && stackingOutcome ? fitLunarDisk(grayImageFromFloatRgb(stackingOutcome.baseImage)) : null),
    [isAtlasVisible, stackingOutcome],
  );
  const atlasOrientation = useMemo(
    () =>
      stackingOutcome && atlasDiskFit
        ? computeAtlasOrientation({
            julianDay: julianDayFromDate(stackingOutcome.captureDate),
            observerLocation,
            deviceRollDegrees: stackingOutcome.deviceRollDegrees,
            correction: imageCorrection,
            disk: atlasDiskFit,
          })
        : null,
    [stackingOutcome, atlasDiskFit, observerLocation, imageCorrection],
  );

  const canMeter = Boolean(cameraDevice?.supportsExposureMetering || cameraDevice?.supportsFocusMetering);
  const isBusy = isCaptureInProgress || isProcessing || focusBracketing.isRunning || moonFrames.isRecording;

  function handleSelectShootingMode(nextShootingMode: MoonShootingMode) {
    if (nextShootingMode === shootingMode || isBusy) return;
    const nextOptics = opticsForMode(nextShootingMode);
    setShootingMode(nextShootingMode);
    if (nextOptics !== optics) {
      setSharpeningLevelIndex(opticsSettings[nextOptics].defaultSharpeningLevelIndex);
      // Por el ocular la Luna es otra: se vuelve a ajustar la luz desde una exposición corta.
      lunarManualExposure.restartAutomatic(opticsSettings[nextOptics].initialExposureSeconds);
    }
  }

  const isMarkingStar = activeTab === 'experiments' && selectedExperiment === 'occultation';

  /** Ocultación: el toque marca la estrella (se guarda respecto al centro de la Luna). */
  function markStarAtViewPoint(viewPoint: { x: number; y: number }) {
    if (!liveDetection || previewSize.width <= 0) return;
    const displayedFrame = containedFrameRect({
      viewWidth: previewSize.width,
      viewHeight: previewSize.height,
      frameWidth: liveDetection.frameWidth,
      frameHeight: liveDetection.frameHeight,
    });
    const frameX = (viewPoint.x - displayedFrame.left) / displayedFrame.displayScale;
    const frameY = (viewPoint.y - displayedFrame.top) / displayedFrame.displayScale;
    setStarOffsetFromMoon({ x: frameX - liveDetection.centerX, y: frameY - liveDetection.centerY });
  }

  async function handlePreviewPress(pressEvent: GestureResponderEvent) {
    const viewPoint = { x: pressEvent.nativeEvent.locationX, y: pressEvent.nativeEvent.locationY };
    if (isMarkingStar) {
      if (!moonFrames.isRecording) markStarAtViewPoint(viewPoint);
      return;
    }
    if (!canMeter || !cameraDevice || isBusy) return;
    const meteringModes: MeteringMode[] = [];
    // Con la exposición manual, tocar solo enfoca: la luz ya se mide sobre la Luna.
    if (cameraDevice.supportsExposureMetering && !lunarManualExposure.isManualExposureActive) meteringModes.push('AE');
    if (cameraDevice.supportsFocusMetering) meteringModes.push('AF');
    setMeteringViewPoint(viewPoint);
    try {
      // Mide y enfoca en la Luna y lo deja fijo: el cielo negro ya no engaña a la exposición automática.
      await cameraRef.current?.focusTo(viewPoint, {
        modes: meteringModes,
        responsiveness: 'snappy',
        adaptiveness: 'locked',
        autoResetAfter: null,
      });
      // Tras medir sobre la Luna, se vuelve a aplicar la compensación sobre esa medida.
      if (!lunarManualExposure.isManualExposureActive && exposureBias !== undefined) {
        await cameraRef.current?.controller?.setExposureBias(exposureBias);
      }
    } catch {
      // Cancelado por otro toque o no admitido: la vista previa sigue funcionando.
    }
  }

  function handleCameraError(cameraError: Error) {
    if (isExpectedCameraInterruption(cameraError)) return;
    if (isRawActive) {
      // No hay forma de saber de antemano si la cámara admite fotos RAW: si falla, se vuelve a JPEG.
      setIsRawEnabled(false);
      setStatusMessage(`${t('rawUnsupportedByCamera')} (${cameraError.message})`);
      return;
    }
    setStatusMessage(t('core:common.error', { message: cameraError.message }));
  }

  async function handleUnlockMetering() {
    setMeteringViewPoint(null);
    try {
      await cameraRef.current?.resetFocus();
    } catch {
      // La cámara puede no estar lista; no hay nada que deshacer.
    } finally {
      // `resetFocus` también quita la exposición manual (aunque falle después de quitarla), el
      // balance de blancos fijo y el enfoque afinado.
      lunarManualExposure.reapplyExposure();
      void daylightWhiteBalance.applyDaylightWhiteBalance();
      void focusBracketing.reapplyBestFocus();
    }
  }

  /** Deja de capturar y pasa a calcular (deja que se pinte el indicador antes). */
  async function enterProcessingPhase() {
    setCaptureStageMessage(null);
    setIsCaptureInProgress(false);
    setIsProcessing(true);
    await waitMilliseconds(50);
    if (!isMountedRef.current) throw new MoonCaptureProblem('moonLostDuringCapture');
  }

  // ------------------------------------------------------------------------------------------
  // Ráfaga de fotos (modo normal y telescopio)
  // ------------------------------------------------------------------------------------------

  async function capturePhotoBurstStack(captureContext: CaptureContext): Promise<StackingOutcome> {
    if (photoBurst.containerFormat === 'dng') return captureRawGreenStack(captureContext);
    const { detection } = captureContext;
    const captureSettings = opticsSettings[captureContext.optics];
    const detectionFrameSize = { width: detection.frameWidth, height: detection.frameHeight };
    const burstResult = await photoBurst.captureBurst({
      photoCount: captureSettings.photoCount,
      // Una foto tomada mientras el móvil se mueve sale corrida: no aporta, emborrona.
      isPhotoUsable: isDeviceSteady,
      maximumOutputSide: maximumSearchRegionOutputSide,
      // Solo se decodifica la zona donde estaba la Luna en la vista previa, con margen.
      planCrop: (uprightPhotoSize) => {
        const photoPixelsPerFramePixel = uprightPhotoSize.width / detectionFrameSize.width;
        const searchRegionSide = moonSearchRegionSide(
          detection.radiusPixels * photoPixelsPerFramePixel,
          Math.min(uprightPhotoSize.width, uprightPhotoSize.height),
        );
        return squareCropAround(expectedPhotoCenter(detection, uprightPhotoSize), searchRegionSide, uprightPhotoSize);
      },
    });
    const steadyCrops = requireSteadyCrops(burstResult.crops, burstResult.firstErrorMessage);
    const rejectedFrameCount = burstResult.crops.length - steadyCrops.length;
    await enterProcessingPhase();
    const processingStartTime = Date.now();
    const moonDetections = steadyCrops.map((photoCrop) =>
      locateMoonInRegion(photoCrop.rgbPixels, photoCrop.width, photoCrop.height),
    );
    const typicalRadius = medianValue(
      moonDetections.flatMap((moonDetection) => (moonDetection ? [moonDetection.radiusPixels] : [])),
    );
    if (typicalRadius <= 0) throw new MoonCaptureProblem('moonLostDuringCapture');
    const cropSize = chooseCropSize(typicalRadius, 96, captureSettings.maximumStackCropSize);
    const alignedCrops: AlignedCrop[] = [];
    steadyCrops.forEach((photoCrop, cropIndex) => {
      const moonDetection = moonDetections[cropIndex];
      // Un radio muy distinto del típico es un reflejo, una nube o la Luna cortada por el borde.
      if (!moonDetection || Math.abs(moonDetection.radiusPixels - typicalRadius) > typicalRadius * radiusToleranceFraction) {
        return;
      }
      const moonCrop = moonCropFromRegion(photoCrop.rgbPixels, photoCrop.width, photoCrop.height, cropSize, moonDetection);
      if (moonCrop) alignedCrops.push(moonCrop.alignedCrop);
    });
    if (alignedCrops.length === 0) throw new MoonCaptureProblem('moonLostDuringCapture');
    const stackingResult = stackSharpestCrops(alignedCrops, cropSize, keptFrameFraction, 0);
    const outputScale = steadyCrops[0]?.outputScale ?? 1;
    const moonDiameterPixels = Math.round((typicalRadius * 2) / outputScale);
    const burstTimings: PhotoBurstTimings = burstResult.timings;
    const detailLines = [
      t('stackingExplanation', {
        captured: burstTimings.capturedPhotoCount,
        stacked: stackingResult.usedCropCount,
        diameter: moonDiameterPixels,
      }),
    ];
    if (rejectedFrameCount > 0) detailLines.push(t('rejectedFramesExplanation', { count: rejectedFrameCount }));
    detailLines.push(
      t('burstTimings', {
        count: burstTimings.capturedPhotoCount,
        captureSeconds: formatSeconds(burstTimings.captureMilliseconds),
        decodeSeconds: formatSeconds(burstTimings.decodeMilliseconds),
      }),
      t('processingTime', { seconds: formatSeconds(Date.now() - processingStartTime) }),
    );
    return {
      ...commonOutcomeFields(captureContext),
      technique: 'photoBurst',
      baseImage: stackingResult.stackedImage,
      enhancement: 'unsharpMask',
      sharpeningSigma: sharpeningSigmaForCropSize(cropSize),
      defaultSharpeningLevelIndex: captureSettings.defaultSharpeningLevelIndex,
      comparisonSkiaImage: requireSkiaImage(createSkiaImage(stackingResult.bestSingleImage)),
      comparisonLabel: t('bestSingleFrame'),
      resultLabel: t('stackedFrames', { count: stackingResult.usedCropCount }),
      detailLines,
      capturedFrameCount: burstTimings.capturedPhotoCount,
      stackedFrameCount: stackingResult.usedCropCount,
      moonDiameterPixels,
      isColorImage: true,
      // Píxeles del resultado por píxel de la foto a zoom ×1: el recorte se redujo `outputScale`.
      sizeScale:
        captureContext.optics === 'nakedEye' ? { resultPixelsPerCommonPixel: outputScale * captureContext.zoomFactor, source: 'jpeg' } : null,
    };
  }

  // ------------------------------------------------------------------------------------------
  // Ráfaga RAW (experimental): canal verde del DNG, apilado monocromo
  // ------------------------------------------------------------------------------------------

  async function captureRawGreenStack(captureContext: CaptureContext): Promise<StackingOutcome> {
    const { detection, zoomFactor: captureZoom } = captureContext;
    const captureSettings = opticsSettings[captureContext.optics];
    // Memoria: cada recorte es verde en coma flotante (4 bytes por píxel).
    const expectedRegion = planRawMoonRegion(detection, captureZoom, typicalUprightRawSize);
    const photoCount = Math.max(
      rawMinimumPhotoCount,
      Math.min(rawMaximumPhotoCount, captureSettings.photoCount, Math.floor(rawMemoryBudgetBytes / (expectedRegion.width * expectedRegion.height * 4))),
    );
    let dngProblem: DngFormatProblem | null = null;
    let readMilliseconds = 0;
    let bytesReadPerPhoto = 0;
    const burstResult = await photoBurst.captureBurstFiles<RawMoonFrame>({
      photoCount,
      isPhotoUsable: isDeviceSteady,
      processFile: async (fileUri, _photoIndex, wasMarkedUsable) => {
        // Deja respirar al hilo JS entre fichero y fichero (la lectura es síncrona).
        await waitMilliseconds(0);
        const readStartTime = Date.now();
        try {
          const rawFrame = readRawMoonFrame(fileUri, (uprightRawSize) => planRawMoonRegion(detection, captureZoom, uprightRawSize), wasMarkedUsable);
          bytesReadPerPhoto = rawFrame.uprightRegion.width * rawFrame.uprightRegion.height * (rawFrame.layout.bitsPerSample / 8);
          return rawFrame;
        } catch (readError) {
          if (readError instanceof DngFormatProblem) dngProblem ??= readError;
          throw readError;
        } finally {
          readMilliseconds += Date.now() - readStartTime;
        }
      },
    });
    const rawFrames = burstResult.results;
    const steadyFrames = rawFrames.filter((rawFrame) => rawFrame.wasMarkedUsable);
    if (steadyFrames.length === 0) {
      if (dngProblem) {
        // No se entiende este DNG: se vuelve a JPEG para la próxima captura.
        setIsRawEnabled(false);
        throw new MoonCaptureProblem('rawNotUnderstood', { reason: (dngProblem as DngFormatProblem).problemCode });
      }
      if (rawFrames.length > 0) throw new MoonCaptureProblem('tooMuchMovement');
      if (burstResult.firstErrorMessage) throw new MoonCaptureProblem('burstFailed', { message: burstResult.firstErrorMessage });
      throw new MoonCaptureProblem('moonLostDuringCapture');
    }
    await enterProcessingPhase();
    const processingStartTime = Date.now();
    const expectedRadius = expectedRawMoonRadius(detection, captureZoom, steadyFrames[0]!.uprightRawSize);
    const upsampleFactor = expectedRadius < rawUpsampleBelowRadiusPixels ? 2 : 1;
    const monoStack = stackMonoFramesOnDisk(
      steadyFrames.map((rawFrame) => rawFrame.greenImage),
      { keptFraction: keptFrameFraction, upsampleFactor, maximumOutputSide: captureSettings.maximumStackCropSize },
    );
    if (!monoStack) throw new MoonCaptureProblem('moonLostDuringCapture');
    const firstLayout = steadyFrames[0]!.layout;
    const rejectedFrameCount = rawFrames.length - steadyFrames.length;
    const detailLines = [
      t('rawExplanation', {
        captured: burstResult.timings.capturedPhotoCount,
        stacked: monoStack.usedFrameCount,
        diameter: (2 * monoStack.diskRadiusPixels).toFixed(1),
        factor: upsampleFactor,
        pattern: firstLayout.bayerPattern,
        black: Math.round(firstLayout.blackLevel),
        white: Math.round(firstLayout.whiteLevel),
      }),
    ];
    if (rejectedFrameCount > 0) detailLines.push(t('rejectedFramesExplanation', { count: rejectedFrameCount }));
    detailLines.push(
      t('rawTimings', {
        count: burstResult.timings.capturedPhotoCount,
        captureSeconds: formatSeconds(burstResult.timings.captureMilliseconds),
        readMilliseconds: Math.round(readMilliseconds / Math.max(1, rawFrames.length)),
        kilobytes: Math.round(bytesReadPerPhoto / 1024),
        processSeconds: formatSeconds(Date.now() - processingStartTime),
      }),
    );
    const outputSide = monoStack.stackedImage.width;
    return {
      ...commonOutcomeFields(captureContext),
      technique: 'photoBurst',
      baseImage: srgbImageFromLinearGray(monoStack.stackedImage),
      enhancement: 'unsharpMask',
      sharpeningSigma: sharpeningSigmaForCropSize(outputSide),
      defaultSharpeningLevelIndex: captureSettings.defaultSharpeningLevelIndex,
      comparisonSkiaImage: requireSkiaImage(createSkiaImage(srgbImageFromLinearGray(monoStack.bestSingleImage))),
      comparisonLabel: t('bestSingleFrame'),
      resultLabel: t('rawResultLabel', { count: monoStack.usedFrameCount }),
      detailLines,
      capturedFrameCount: burstResult.timings.capturedPhotoCount,
      stackedFrameCount: monoStack.usedFrameCount,
      moonDiameterPixels: Math.round(2 * monoStack.diskRadiusPixels),
      isColorImage: false,
      isRawCapture: true,
      // El RAW es siempre el sensor entero: su escala no depende del zoom.
      sizeScale:
        captureContext.optics === 'nakedEye'
          ? { resultPixelsPerCommonPixel: upsampleFactor, source: 'raw', linearGrayImage: monoStack.stackedImage }
          : null,
    };
  }

  function requireSteadyCrops(crops: readonly PhotoBurstCrop[], firstErrorMessage: string | null): PhotoBurstCrop[] {
    const steadyCrops = crops.filter((photoCrop) => photoCrop.wasMarkedUsable);
    if (steadyCrops.length > 0) return steadyCrops;
    if (crops.length > 0) throw new MoonCaptureProblem('tooMuchMovement');
    if (firstErrorMessage) throw new MoonCaptureProblem('burstFailed', { message: firstErrorMessage });
    throw new MoonCaptureProblem('moonLostDuringCapture');
  }

  function requireSkiaImage(skiaImage: SkImage | null): SkImage {
    if (!skiaImage) throw new Error('Skia no pudo crear la imagen');
    return skiaImage;
  }

  function commonOutcomeFields(captureContext: CaptureContext) {
    return {
      zoomFactor: captureContext.zoomFactor,
      optics: captureContext.optics,
      captureDate: captureContext.captureDate,
      deviceRollDegrees: captureContext.deviceRollDegrees,
      ...captureContext.exposureFields,
    };
  }

  // ------------------------------------------------------------------------------------------
  // Imagen afortunada (telescopio, fotogramas de vídeo)
  // ------------------------------------------------------------------------------------------

  async function captureLuckyStack(captureContext: CaptureContext): Promise<StackingOutcome> {
    const { detection } = captureContext;
    const fullDiskRadius = fullDiskRadiusFromBrightArea(detection.radiusPixels, moonReport.illuminatedFraction);
    const cropPlan = planLuckyFrameCrop(fullDiskRadius, Math.min(detection.frameWidth, detection.frameHeight));
    const recordingTimeout = setTimeout(moonFrames.stopRecording, luckyRecordingTimeoutMilliseconds);
    let frameRecording;
    try {
      frameRecording = await moonFrames.recordFrames(cropPlan, luckyFrameCount);
    } finally {
      clearTimeout(recordingTimeout);
    }
    if (frameRecording.grayFrames.length < minimumLuckyFrameCount) throw new MoonCaptureProblem('moonLostDuringCapture');
    await enterProcessingPhase();
    const processingStartTime = Date.now();
    const outputDiskRadius = fullDiskRadius / cropPlan.downsampleFactor;
    const luckyOutcome = stackLuckyRecording(frameRecording.grayFrames, frameRecording.outputSide, outputDiskRadius);
    const recordedCount = frameRecording.grayFrames.length;
    const framesPerSecond = frameRecording.durationMilliseconds > 0 ? (recordedCount * 1000) / frameRecording.durationMilliseconds : 0;
    return {
      ...commonOutcomeFields(captureContext),
      technique: 'luckyImaging',
      baseImage: floatRgbFromGray(luckyOutcome.stackedImage),
      baseGrayImage: luckyOutcome.stackedImage,
      enhancement: 'wavelets',
      sharpeningSigma: 1,
      defaultSharpeningLevelIndex: opticsSettings.telescope.defaultSharpeningLevelIndex,
      comparisonSkiaImage: requireSkiaImage(createSkiaImage(floatRgbFromGray(luckyOutcome.bestSingleImage))),
      comparisonLabel: t('bestSingleFrame'),
      resultLabel: t('stackedFrames', { count: luckyOutcome.usedFrameCount }),
      detailLines: [
        t('luckyExplanation', {
          recorded: recordedCount,
          stacked: luckyOutcome.usedFrameCount,
          points: luckyOutcome.alignmentPointCount,
          side: frameRecording.outputSide,
        }),
        ...(cropPlan.downsampleFactor > 1 ? [t('luckyDownsampled', { factor: cropPlan.downsampleFactor })] : []),
        t('luckyTimings', {
          count: recordedCount,
          captureSeconds: formatSeconds(frameRecording.durationMilliseconds),
          framesPerSecond: framesPerSecond.toFixed(0),
          processSeconds: formatSeconds(Date.now() - processingStartTime),
        }),
      ],
      capturedFrameCount: recordedCount,
      stackedFrameCount: luckyOutcome.usedFrameCount,
      moonDiameterPixels: Math.round(fullDiskRadius * 2),
      isColorImage: false,
      sizeScale: null,
    };
  }

  // ------------------------------------------------------------------------------------------
  // Trípode: superresolución por deriva
  // ------------------------------------------------------------------------------------------

  async function captureDriftSuperResolution(captureContext: CaptureContext): Promise<StackingOutcome> {
    const { detection } = captureContext;
    const typicalPhotoSize = photoBurst.uprightPhotoSize;
    const photoPixelsPerFramePixel = typicalPhotoSize.width / detection.frameWidth;
    const fullDiskDiameterPhoto =
      2 * fullDiskRadiusFromBrightArea(detection.radiusPixels, moonReport.illuminatedFraction) * photoPixelsPerFramePixel;
    const cropSide = planDriftCropSide(
      fullDiskDiameterPhoto,
      moonReport.apparentDiameterArcminutes,
      driftDurationSeconds,
      Math.min(typicalPhotoSize.width, typicalPhotoSize.height),
    );
    const maximumPhotoCount = Math.max(
      minimumDriftPhotoCount,
      Math.min(driftMaximumPhotoCount, Math.floor(driftMemoryBudgetBytes / (cropSide * cropSide * 3))),
    );
    // Recorte FIJO: el mismo rectángulo en todas las fotos, centrado donde estaba la Luna al empezar.
    const planFixedCrop: PhotoBurstRequest['planCrop'] = (uprightPhotoSize) =>
      squareCropAround(expectedPhotoCenter(detection, uprightPhotoSize), cropSide, uprightPhotoSize);
    const driftPhotos: DriftPhoto[] = [];
    let capturedPhotoCount = 0;
    let rejectedPhotoCount = 0;
    let firstErrorMessage: string | null = null;
    const captureStartTime = Date.now();
    while (
      Date.now() - captureStartTime < driftDurationSeconds * 1000 &&
      driftPhotos.length < maximumPhotoCount &&
      !isStopRequestedRef.current &&
      isMountedRef.current
    ) {
      const batchCaptureTimes: number[] = [];
      const burstResult = await photoBurst.captureBurst({
        photoCount: Math.min(driftPhotosPerBatch, maximumPhotoCount - driftPhotos.length),
        isPhotoUsable: () => {
          batchCaptureTimes.push(Date.now());
          return isDeviceSteady();
        },
        planCrop: planFixedCrop,
      });
      capturedPhotoCount += burstResult.timings.capturedPhotoCount;
      firstErrorMessage ??= burstResult.firstErrorMessage;
      // Sin fallos de decodificación, cada recorte es la foto del mismo orden: su hora es la del disparo.
      const hasMatchingTimes = burstResult.crops.length === batchCaptureTimes.length;
      burstResult.crops.forEach((photoCrop, cropIndex) => {
        if (!photoCrop.wasMarkedUsable) {
          rejectedPhotoCount++;
          return;
        }
        if (photoCrop.width !== cropSide || photoCrop.height !== cropSide || !hasMatchingTimes) return;
        driftPhotos.push({
          rgbPixels: photoCrop.rgbPixels,
          side: cropSide,
          timestampSeconds: (batchCaptureTimes[cropIndex]! - captureStartTime) / 1000,
        });
      });
      if (burstResult.timings.capturedPhotoCount === 0) break;
      if (isMountedRef.current) {
        setCaptureStageMessage(
          t('driftProgress', {
            elapsed: Math.min(driftDurationSeconds, Math.round((Date.now() - captureStartTime) / 1000)),
            total: driftDurationSeconds,
            photos: driftPhotos.length,
          }),
        );
      }
    }
    const captureMilliseconds = Date.now() - captureStartTime;
    if (driftPhotos.length < minimumDriftPhotoCount) {
      if (rejectedPhotoCount > 0) throw new MoonCaptureProblem('tooMuchMovement');
      if (firstErrorMessage) throw new MoonCaptureProblem('burstFailed', { message: firstErrorMessage });
      throw new MoonCaptureProblem('tooFewDriftPhotos', { count: driftPhotos.length });
    }
    await enterProcessingPhase();
    const processingStartTime = Date.now();
    const driftOutcome = fuseDriftPhotos(driftPhotos);
    const detailLines = [
      t('driftExplanation', {
        photos: driftPhotos.length,
        used: driftOutcome.usedFrameCount,
        span: driftOutcome.driftSpanPixels.toFixed(1),
      }),
    ];
    if (driftOutcome.driftPixelsPerSecond !== null) {
      detailLines.push(t('driftSpeed', { speed: driftOutcome.driftPixelsPerSecond.toFixed(2) }));
    }
    if (driftOutcome.driftSpanPixels < 2) detailLines.push(t('driftTooSmall'));
    if (rejectedPhotoCount > 0) detailLines.push(t('rejectedFramesExplanation', { count: rejectedPhotoCount }));
    detailLines.push(
      t('driftTimings', {
        count: capturedPhotoCount,
        captureSeconds: formatSeconds(captureMilliseconds),
        processSeconds: formatSeconds(Date.now() - processingStartTime),
      }),
    );
    return {
      ...commonOutcomeFields(captureContext),
      technique: 'driftSuperResolution',
      baseImage: driftOutcome.superResolvedImage,
      enhancement: 'unsharpMask',
      sharpeningSigma: sharpeningSigmaForScale(2),
      defaultSharpeningLevelIndex: opticsSettings.nakedEye.defaultSharpeningLevelIndex,
      comparisonSkiaImage: requireSkiaImage(createSkiaImage(driftOutcome.singleFrameImage)),
      comparisonLabel: t('singlePhotoEnlarged'),
      resultLabel: t('driftResultLabel', { count: driftOutcome.usedFrameCount }),
      detailLines,
      capturedFrameCount: capturedPhotoCount,
      stackedFrameCount: driftOutcome.usedFrameCount,
      moonDiameterPixels: Math.round(fullDiskDiameterPhoto),
      isColorImage: true,
      // Rejilla dos veces más fina que la foto.
      sizeScale: { resultPixelsPerCommonPixel: 2 * captureContext.zoomFactor, source: 'jpeg' },
    };
  }

  // ------------------------------------------------------------------------------------------
  // Luz cenicienta: ráfaga corta y ráfaga larga
  // ------------------------------------------------------------------------------------------

  async function captureEarthshine(captureContext: CaptureContext): Promise<StackingOutcome> {
    const { detection } = captureContext;
    const cameraController = cameraRef.current?.controller;
    if (!lunarManualExposure.isManualExposureActive || !cameraController || cameraController.maxExposureDuration <= 0) {
      throw new MoonCaptureProblem('earthshineNeedsManualExposure');
    }
    const exposurePlan = planEarthshineExposures(lunarManualExposure.exposureSeconds, {
      minimumSeconds: cameraController.minExposureDuration,
      maximumSeconds: cameraController.maxExposureDuration,
    });
    const iso = lunarManualExposure.iso;
    const typicalPhotoSize = photoBurst.uprightPhotoSize;
    const photoPixelsPerFramePixel = typicalPhotoSize.width / detection.frameWidth;
    const fullDiskRadiusPhoto =
      fullDiskRadiusFromBrightArea(detection.radiusPixels, moonReport.illuminatedFraction) * photoPixelsPerFramePixel;
    // La misma zona fija en las dos ráfagas: se alinean después por el centro del disco.
    const planRegion: PhotoBurstRequest['planCrop'] = (uprightPhotoSize) =>
      squareCropAround(
        expectedPhotoCenter(detection, uprightPhotoSize),
        earthshineRegionSide(fullDiskRadiusPhoto, Math.min(uprightPhotoSize.width, uprightPhotoSize.height)),
        uprightPhotoSize,
      );
    const captureStartTime = Date.now();
    const burstAtExposure = async (exposureSeconds: number, stageKey: string) => {
      setCaptureStageMessage(t(stageKey, { duration: formatExposureDuration(exposureSeconds) }));
      await cameraController.setExposureLocked(exposureSeconds, iso);
      await waitMilliseconds(exposureSettleMilliseconds);
      if (!isMountedRef.current || isStopRequestedRef.current) throw new MoonCaptureProblem('captureStopped');
      const burstResult = await photoBurst.captureBurst({
        photoCount: earthshinePhotosPerExposure,
        isPhotoUsable: isDeviceSteady,
        maximumOutputSide: maximumSearchRegionOutputSide,
        planCrop: planRegion,
      });
      return requireSteadyCrops(burstResult.crops, burstResult.firstErrorMessage);
    };
    let shortCrops: PhotoBurstCrop[];
    let longCrops: PhotoBurstCrop[];
    try {
      shortCrops = await burstAtExposure(exposurePlan.shortExposureSeconds, 'earthshineShortStage');
      longCrops = await burstAtExposure(exposurePlan.longExposureSeconds, 'earthshineLongStage');
    } finally {
      // Vuelve a la exposición de la vista previa.
      lunarManualExposure.reapplyExposure();
    }
    const captureMilliseconds = Date.now() - captureStartTime;
    await enterProcessingPhase();
    const processingStartTime = Date.now();
    const toRegion = (photoCrop: PhotoBurstCrop) => ({
      rgbPixels: photoCrop.rgbPixels,
      width: photoCrop.width,
      height: photoCrop.height,
    });
    const earthshineOutcome = fuseEarthshineBursts(
      shortCrops.map(toRegion),
      longCrops.map(toRegion),
      exposurePlan.exposureRatio,
    );
    const outputScale = shortCrops[0]?.outputScale ?? 1;
    const detailLines = [
      t('earthshineExplanation', {
        shortCount: earthshineOutcome.usedShortCount,
        longCount: earthshineOutcome.usedLongCount,
        shortDuration: formatExposureDuration(exposurePlan.shortExposureSeconds),
        longDuration: formatExposureDuration(exposurePlan.longExposureSeconds),
        ratio: Math.round(earthshineOutcome.exposureRatio),
      }),
      t(earthshineOutcome.isRatioMeasured ? 'earthshineRatioMeasured' : 'earthshineRatioNominal'),
    ];
    if (exposurePlan.isRatioLimited) detailLines.push(t('earthshineRatioLimited'));
    detailLines.push(
      t('driftTimings', {
        count: shortCrops.length + longCrops.length,
        captureSeconds: formatSeconds(captureMilliseconds),
        processSeconds: formatSeconds(Date.now() - processingStartTime),
      }),
    );
    return {
      ...commonOutcomeFields(captureContext),
      technique: 'earthshine',
      baseImage: floatRgbFromGray(earthshineOutcome.displayImage, 255),
      enhancement: 'none',
      sharpeningSigma: 1,
      defaultSharpeningLevelIndex: 0,
      comparisonSkiaImage: requireSkiaImage(createSkiaImage(floatRgbFromGray(earthshineOutcome.shortExposureImage))),
      comparisonLabel: t('earthshineShortLabel'),
      resultLabel: t('earthshineResultLabel'),
      detailLines,
      capturedFrameCount: shortCrops.length + longCrops.length,
      stackedFrameCount: shortCrops.length + longCrops.length,
      moonDiameterPixels: Math.round((earthshineOutcome.diskRadiusPixels * 2) / outputScale),
      exposureSeconds: exposurePlan.shortExposureSeconds,
      iso,
      exposureRatio: earthshineOutcome.exposureRatio,
      isColorImage: false,
      sizeScale: null,
      earthshineSource: {
        shortExposureImage: earthshineOutcome.shortExposureImage,
        longExposureImage: earthshineOutcome.longExposureImage,
        diskRadiusPixels: earthshineOutcome.diskRadiusPixels,
        nominalExposureRatio: exposurePlan.exposureRatio,
        captureDate: captureContext.captureDate,
      },
    };
  }

  // ------------------------------------------------------------------------------------------

  /**
   * Captura con el modo de la pantalla o con el que pide un experimento. Devuelve el resultado
   * (también queda en pantalla) o null si no se pudo.
   */
  async function handleCapture(captureRequest?: CaptureRequest): Promise<StackingOutcome | null> {
    if (!liveDetection) return null;
    const shootingModeAtStart = captureRequest?.shootingMode ?? shootingMode;
    const telescopeMethodAtStart = captureRequest?.telescopeMethod ?? telescopeMethod;
    const opticsAtStart = opticsForMode(shootingModeAtStart);
    const zoomFactorAtStart = zoomFactor;
    const isPhotoBurstRequest =
      shootingModeAtStart === 'normal' || (shootingModeAtStart === 'telescope' && telescopeMethodAtStart === 'photoBurst');
    if (photoBurst.containerFormat === 'dng' && !isPhotoBurstRequest) {
      setStatusMessage(t('rawNeedsPhotoBurst'));
      return null;
    }
    const exposureFields: CaptureContext['exposureFields'] = lunarManualExposure.isManualExposureActive
      ? { exposureSeconds: lunarManualExposure.exposureSeconds, iso: lunarManualExposure.iso }
      : exposureBias !== undefined
        ? { exposureBias }
        : {};
    setStackingOutcome(null);
    setStatusMessage(null);
    setIsAtlasVisible(false);
    isStopRequestedRef.current = false;
    setIsCaptureInProgress(true);
    try {
      // El toque en la pantalla o `resetFocus` pueden haber quitado el enfoque afinado y el balance fijo.
      await focusBracketing.reapplyBestFocus();
      await daylightWhiteBalance.applyDaylightWhiteBalance();
      for (let secondsLeft = captureCountdownSeconds; secondsLeft > 0; secondsLeft--) {
        setCountdownSecondsLeft(secondsLeft);
        await waitMilliseconds(1000);
        if (!isMountedRef.current) return null;
      }
      setCountdownSecondsLeft(null);
      const detectionAtStart = latestDetectionRef.current;
      if (!detectionAtStart) throw new MoonCaptureProblem('moonLostDuringCapture');
      const captureContext: CaptureContext = {
        detection: detectionAtStart,
        captureDate: new Date(),
        deviceRollDegrees: readDeviceRollDegrees(),
        zoomFactor: zoomFactorAtStart,
        optics: opticsAtStart,
        exposureFields,
      };
      const outcome =
        shootingModeAtStart === 'tripod'
          ? await captureDriftSuperResolution(captureContext)
          : shootingModeAtStart === 'earthshine'
            ? await captureEarthshine(captureContext)
            : shootingModeAtStart === 'telescope' && telescopeMethodAtStart === 'luckyFrames'
              ? await captureLuckyStack(captureContext)
              : await capturePhotoBurstStack(captureContext);
      if (!isMountedRef.current) return null;
      setSharpeningLevelIndex(outcome.defaultSharpeningLevelIndex);
      // Un telescopio o una lente sola giran la imagen 180°; los prismáticos, no.
      setImageCorrection({ opticsRotationDegrees: outcome.optics === 'telescope' ? 180 : 0, isMirrored: false });
      setStackingOutcome(outcome);
      return outcome;
    } catch (captureError) {
      if (!isMountedRef.current) return null;
      setStatusMessage(
        captureError instanceof MoonCaptureProblem
          ? t(captureError.messageKey, captureError.messageValues)
          : t('core:common.error', { message: String(captureError) }),
      );
      return null;
    } finally {
      if (isMountedRef.current) {
        setCountdownSecondsLeft(null);
        setCaptureStageMessage(null);
        setIsCaptureInProgress(false);
        setIsProcessing(false);
      }
    }
  }

  function handleStopCapture() {
    isStopRequestedRef.current = true;
    photoBurst.stopCapture();
    moonFrames.stopRecording();
  }

  function handleOpenFullSize() {
    if (!stackingOutcome || !stackedSkiaImage) return;
    resultImageViewer.openViewer([
      { skiaImage: stackedSkiaImage, caption: stackingOutcome.resultLabel, fileNamePrefix: 'luna-resultado' },
      {
        skiaImage: stackingOutcome.comparisonSkiaImage,
        caption: stackingOutcome.comparisonLabel,
        fileNamePrefix: 'luna-comparacion',
      },
      ...(mineralSkiaImage
        ? [
            {
              skiaImage: mineralSkiaImage,
              caption: t('processing.mineralLabel', { gain: resultProcessing.mineralSaturationGain }),
              fileNamePrefix: 'luna-mineral',
            },
          ]
        : []),
    ]);
  }

  const roundTo = (numericValue: number, fractionDigits: number) => Math.round(numericValue * 10 ** fractionDigits) / 10 ** fractionDigits;

  /** Campos comunes de toda medida: la Luna de ahora y, si lo hay, el resultado de la captura. */
  function buildMeasurementValues(outcome: StackingOutcome | null): MoonMeasurementValues {
    const horizontalPosition = moonReport.horizontalPosition;
    return {
      phaseName: moonReport.phaseName,
      illuminatedPercent: roundTo(moonReport.illuminatedFraction * 100, 1),
      ageDays: roundTo(moonReport.ageDays, 2),
      distanceKilometers: Math.round(moonReport.distanceKilometers),
      apparentDiameterArcminutes: roundTo(moonReport.apparentDiameterArcminutes, 2),
      ...(horizontalPosition
        ? {
            moonAltitudeDegrees: roundTo(horizontalPosition.altitudeDegrees, 1),
            moonAzimuthDegrees: roundTo(horizontalPosition.azimuthDegrees, 1),
          }
        : {}),
      capturedFrameCount: outcome?.capturedFrameCount ?? 0,
      stackedFrameCount: outcome?.stackedFrameCount ?? 0,
      moonDiameterPixels: outcome?.moonDiameterPixels ?? moonDiameterPixels,
      zoomFactor: roundTo(outcome?.zoomFactor ?? zoomFactor, 2),
      ...(outcome?.exposureSeconds !== undefined && outcome.iso !== undefined
        ? { exposureMilliseconds: roundTo(outcome.exposureSeconds * 1000, 3), iso: outcome.iso }
        : {}),
      ...(outcome?.exposureBias === undefined
        ? {}
        : exposureScale.isStepIndex
          ? { exposureCompensationSteps: outcome.exposureBias }
          : { exposureBias: outcome.exposureBias }),
      ...(outcome ? { throughOptics: outcome.optics === 'telescope', captureTechnique: outcome.technique } : {}),
      ...(outcome?.exposureRatio !== undefined ? { exposureRatio: roundTo(outcome.exposureRatio, 1) } : {}),
      ...(outcome?.isRawCapture ? { rawCapture: true } : {}),
      ...(focusBracketing.bestLensPosition !== null ? { focusLensPosition: roundTo(focusBracketing.bestLensPosition, 4) } : {}),
      whiteBalanceMode: daylightWhiteBalance.whiteBalanceStatus === 'lockedDaylight' ? 'lockedDaylight' : 'automatic',
    };
  }

  /** Guarda la medida de un experimento (sin imagen). null si no se pudo. */
  async function saveExperimentMeasurement(
    extraValues: Partial<MoonMeasurementValues>,
  ): Promise<Measurement<MoonMeasurementValues> | null> {
    try {
      const savedMeasurement = await saveMeasurement({ values: { ...buildMeasurementValues(stackingOutcome), ...extraValues } });
      setStatusMessage(t('core:instrument.savedMeasurement'));
      return savedMeasurement;
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
      return null;
    }
  }

  async function handleSave() {
    if (!stackingOutcome || !stackedSkiaImage) return;
    setIsSaving(true);
    setStatusMessage(null);
    const temporaryFiles: { uri: string; delete(): void }[] = [];
    try {
      const pngFile = writeImageToCachePng(stackedSkiaImage, 'luna');
      temporaryFiles.push(pngFile);
      const mineralPngFile = mineralSkiaImage ? writeImageToCachePng(mineralSkiaImage, 'luna-mineral') : null;
      if (mineralPngFile) temporaryFiles.push(mineralPngFile);
      const processingSettings = resultProcessing.settingsForSaving;
      await saveMeasurement({
        values: {
          ...buildMeasurementValues(stackingOutcome),
          ...(stackingOutcome.enhancement === 'unsharpMask'
            ? { sharpeningAmount: sharpeningLevels[sharpeningLevelIndex]?.amount ?? 0 }
            : {}),
          ...(processingSettings.colorCorrected ? { colorCorrected: true } : {}),
          ...(processingSettings.deconvolutionIterations !== undefined
            ? { deconvolutionIterations: processingSettings.deconvolutionIterations }
            : {}),
          ...(processingSettings.mineralSaturationGain !== undefined && mineralPngFile
            ? { mineralSaturationGain: processingSettings.mineralSaturationGain }
            : {}),
        },
        attachments: [
          {
            kind: 'photo',
            sourceUri: pngFile.uri,
            fileName: 'luna.png',
            mimeType: 'image/png',
            metadata: {
              widthPixels: stackedSkiaImage.width(),
              heightPixels: stackedSkiaImage.height(),
              stackedFrameCount: stackingOutcome.stackedFrameCount,
            },
          },
          ...(mineralPngFile && mineralSkiaImage
            ? [
                {
                  kind: 'photo' as const,
                  sourceUri: mineralPngFile.uri,
                  fileName: 'luna-mineral.png',
                  mimeType: 'image/png',
                  metadata: { widthPixels: mineralSkiaImage.width(), heightPixels: mineralSkiaImage.height() },
                },
              ]
            : []),
        ],
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      for (const temporaryFile of temporaryFiles) temporaryFile.delete();
      setIsSaving(false);
    }
  }

  const moonDiameterPixels = liveDetection ? moonDiameterInPhotoPixels(liveDetection, photoBurst.uprightPhotoSize) : 0;
  const isExposureAtMinimum = exposureBias === undefined || exposureBias <= minimumExposureBias;
  // En la luz cenicienta la parte iluminada se mide igual: la ráfaga corta debe quedar sin quemar.
  const exposureHint = !liveDetection
    ? null
    : lunarManualExposure.isManualExposureActive
      ? liveDetection.saturatedFraction > overexposedSaturatedFraction && !lunarManualExposure.isAutomatic
        ? t('overexposedHint')
        : null
      : liveDetection.saturatedFraction > overexposedSaturatedFraction
        ? t(isExposureAtMinimum ? 'overexposedAtMinimumHint' : 'overexposedHint')
        : liveDetection.peakBrightness < underexposedPeakBrightness
          ? t('underexposedHint')
          : null;
  const isMoonOffCenter =
    liveDetection !== null &&
    Math.hypot(
      liveDetection.centerX - liveDetection.frameWidth / 2,
      liveDetection.centerY - liveDetection.frameHeight / 2,
    ) >
      offCenterFraction * Math.min(liveDetection.frameWidth, liveDetection.frameHeight);
  const captureProgress = photoBurst.captureProgress;
  const isLuckyMode = shootingMode === 'telescope' && telescopeMethod === 'luckyFrames';
  const isEarthshineUnsupported = shootingMode === 'earthshine' && !lunarManualExposure.isManualExposureActive;
  const captureButtonLabel =
    countdownSecondsLeft !== null
      ? t('captureCountdown', { seconds: countdownSecondsLeft })
      : shootingMode === 'tripod'
        ? t('captureDrift', { seconds: driftDurationSeconds })
        : shootingMode === 'earthshine'
          ? t('captureEarthshine')
          : isLuckyMode
            ? t('captureLuckyFrames', { count: luckyFrameCount })
            : t(isRawActive ? 'captureRawAndStack' : 'captureAndStack', { count: modeSettings.photoCount });
  const introKey: Record<MoonShootingMode, string> = {
    normal: 'nakedEyeLimitation',
    tripod: 'tripodIntro',
    telescope: 'telescopeIntro',
    earthshine: 'earthshineIntro',
  };
  const tipsKey: Record<MoonShootingMode, string> = {
    normal: 'tips',
    tripod: 'tripodTips',
    telescope: 'telescopeTips',
    earthshine: 'earthshineTips',
  };
  const isLongCaptureRunning = isCaptureInProgress && countdownSecondsLeft === null;
  const atlasLanguage = atlasLanguageFor(i18n.language);

  // Experimentos: lo que necesitan de la última captura.
  const latestSizeSource = useMemo(() => sizeSourceFromOutcome(stackingOutcome), [stackingOutcome]);
  const latestEarthshine = stackingOutcome?.earthshineSource ?? null;
  const starMarkerViewPoint = (() => {
    if (!isMarkingStar || !starOffsetFromMoon || !liveDetection || previewSize.width <= 0) return null;
    const displayedFrame = containedFrameRect({
      viewWidth: previewSize.width,
      viewHeight: previewSize.height,
      frameWidth: liveDetection.frameWidth,
      frameHeight: liveDetection.frameHeight,
    });
    return {
      x: displayedFrame.left + (liveDetection.centerX + starOffsetFromMoon.x) * displayedFrame.displayScale,
      y: displayedFrame.top + (liveDetection.centerY + starOffsetFromMoon.y) * displayedFrame.displayScale,
    };
  })();

  async function handleRunFocusBracketing() {
    const detection = latestDetectionRef.current;
    if (!detection) return;
    setStatusMessage(null);
    try {
      const focusOutcome = await focusBracketing.runFocusBracketing((uprightPhotoSize) => {
        const photoPixelsPerFramePixel = uprightPhotoSize.width / detection.frameWidth;
        const searchRegionSide = moonSearchRegionSide(
          detection.radiusPixels * photoPixelsPerFramePixel,
          Math.min(uprightPhotoSize.width, uprightPhotoSize.height),
        );
        return squareCropAround(expectedPhotoCenter(detection, uprightPhotoSize), searchRegionSide, uprightPhotoSize);
      });
      if (!focusOutcome) setStatusMessage(t('assistant.focusFailed'));
    } catch (focusError) {
      setStatusMessage(t('core:common.error', { message: String(focusError) }));
    }
  }

  function handleToggleRaw() {
    setIsRawEnabled(!isRawEnabled);
  }

  async function handleCaptureForSize(): Promise<SizeMeasurementSource | null> {
    const outcome = await handleCapture({ shootingMode: 'normal', telescopeMethod: 'photoBurst' });
    return sizeSourceFromOutcome(outcome);
  }

  function handleSelectTab(nextTab: MoonScreenTab) {
    if (isBusy) return;
    setActiveTab(nextTab);
  }

  const cameraBlock = (
    <>
      <View
        style={[styles.previewContainer, { borderColor: themePalette.border }]}
        onLayout={(layoutEvent: LayoutChangeEvent) => {
          const { width, height } = layoutEvent.nativeEvent.layout;
          setPreviewSize((previousSize) =>
            previousSize.width === width && previousSize.height === height ? previousSize : { width, height },
          );
        }}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={cameraDevice ?? 'back'}
          isActive={isCameraAllowed}
          outputs={[frameOutput, photoBurst.photoOutput]}
          // Fotos orientadas como la pantalla (vertical) aunque se apunte al cielo o se gire el móvil.
          orientationSource="interface"
          zoom={zoomFactor}
          exposure={exposureBias}
          onError={handleCameraError}
          onStarted={handleCameraStarted}
          resizeMode="contain"
        />
        {optics === 'telescope' && previewSize.width > 0 ? (
          <TelescopeGuideOverlay previewSize={previewSize} liveDetection={liveDetection} isMoonOffCenter={isMoonOffCenter} />
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(isMarkingStar ? 'experiments.occultation.tapStar' : 'tapToMeterHint')}
          style={StyleSheet.absoluteFill}
          onPress={(pressEvent) => void handlePreviewPress(pressEvent)}>
          {meteringViewPoint && !isMarkingStar ? (
            <View
              pointerEvents="none"
              style={[
                styles.meteringMarker,
                { left: meteringViewPoint.x - meteringMarkerRadius, top: meteringViewPoint.y - meteringMarkerRadius },
              ]}
            />
          ) : null}
          {starMarkerViewPoint ? (
            <View
              pointerEvents="none"
              style={[styles.starMarker, { left: starMarkerViewPoint.x - starMarkerRadius, top: starMarkerViewPoint.y - starMarkerRadius }]}
            />
          ) : null}
        </Pressable>
        {pointingGuidance && !liveDetection ? (
          <PointingOverlay
            pointingGuidance={pointingGuidance}
            isBelowHorizon={(moonReport.horizontalPosition?.altitudeDegrees ?? 0) < 0}
          />
        ) : null}
        {resultImageViewer.openedIndex !== null ? (
          <Suspense fallback={null}>
            <ImageViewer
              images={resultImageViewer.viewerImages}
              openedIndex={resultImageViewer.openedIndex}
              onClose={resultImageViewer.closeViewer}
            />
          </Suspense>
        ) : null}
      </View>
      {pointingGuidance ? <BodyText tone="secondary">{t('compassCalibrationHint')}</BodyText> : null}
      {!moonReport.horizontalPosition && hasOrientationSensors && optics === 'nakedEye' ? (
        <BodyText tone="secondary">{t('guideNeedsLocation')}</BodyText>
      ) : null}

      <BodyText tone={liveDetection ? 'primary' : 'secondary'}>
        {liveDetection
          ? t('moonDetected', { diameter: moonDiameterPixels })
          : t(optics === 'nakedEye' ? 'moonNotDetected' : 'telescopeMoonNotDetected')}
      </BodyText>
      {optics === 'telescope' && isMoonOffCenter ? <BodyText tone="danger">{t('telescopeOffCenter')}</BodyText> : null}
      {exposureHint ? <BodyText tone="danger">{exposureHint}</BodyText> : null}
      {liveDetection && hasGyroscope && !isCaptureInProgress ? (
        <BodyText tone={isSteadyForDisplay ? 'secondary' : 'danger'}>
          {t(isSteadyForDisplay ? 'deviceSteady' : 'deviceMoving')}
        </BodyText>
      ) : null}

      <StepperRow
        label={t('zoomLabel', { zoom: zoomFactor.toFixed(1) })}
        onDecrease={() => setRequestedZoom(Math.max(minimumZoom, zoomFactor / zoomStepFactor))}
        onIncrease={() => setRequestedZoom(Math.min(maximumZoom, zoomFactor * zoomStepFactor))}
        isDecreaseDisabled={isBusy || zoomFactor <= minimumZoom}
        isIncreaseDisabled={isBusy || zoomFactor >= maximumZoom}
        decreaseLabel={t('zoomOut')}
        increaseLabel={t('zoomIn')}
      />
      {lunarManualExposure.isManualExposureActive ? (
        <>
          <StepperRow
            label={t('exposureTimeLabel', {
              duration: formatExposureDuration(lunarManualExposure.exposureSeconds),
              iso: Math.round(lunarManualExposure.iso),
            })}
            onDecrease={lunarManualExposure.darken}
            onIncrease={lunarManualExposure.brighten}
            isDecreaseDisabled={isBusy || lunarManualExposure.isAtShortestExposure}
            isIncreaseDisabled={isBusy || lunarManualExposure.isAtLongestExposure}
            decreaseLabel={t('exposureDown')}
            increaseLabel={t('exposureUp')}
          />
          {lunarManualExposure.isAutomatic ? (
            <BodyText tone="secondary">{t('automaticLunarExposure')}</BodyText>
          ) : (
            <View style={styles.buttonRow}>
              <View style={styles.buttonCell}>
                <BodyText tone="secondary">{t('manualLunarExposure')}</BodyText>
              </View>
              <View style={styles.buttonCell}>
                <AppButton
                  label={t('useAutomaticLunarExposure')}
                  onPress={lunarManualExposure.enableAutomatic}
                  isDisabled={isBusy}
                  variant="secondary"
                />
              </View>
            </View>
          )}
        </>
      ) : exposureBias !== undefined ? (
        <StepperRow
          label={
            exposureScale.isStepIndex
              ? t('exposureStepsLabel', {
                  exposure: formatExposureValue(exposureScale, exposureBias),
                  minimum: formatExposureValue(exposureScale, minimumExposureBias),
                })
              : t('exposureLabel', { exposure: formatExposureValue(exposureScale, exposureBias) })
          }
          onDecrease={() => setRequestedExposureBias(stepExposure(exposureScale, exposureBias, -1))}
          onIncrease={() => setRequestedExposureBias(stepExposure(exposureScale, exposureBias, 1))}
          isDecreaseDisabled={isBusy || exposureBias <= minimumExposureBias}
          isIncreaseDisabled={isBusy || exposureBias >= maximumExposureBias}
          decreaseLabel={t('exposureDown')}
          increaseLabel={t('exposureUp')}
        />
      ) : (
        <BodyText tone="secondary">{t('exposureUnsupported')}</BodyText>
      )}
      {canMeter && !isMarkingStar ? (
        <View style={styles.buttonRow}>
          <View style={styles.buttonCell}>
            <BodyText tone="secondary">{meteringViewPoint ? t('meteringLocked') : t('tapToMeterHint')}</BodyText>
          </View>
          {meteringViewPoint ? (
            <View style={styles.buttonCell}>
              <AppButton label={t('unlockMetering')} onPress={() => void handleUnlockMetering()} variant="secondary" />
            </View>
          ) : null}
        </View>
      ) : null}
      {isLongCaptureRunning ? (
        <View style={styles.buttonRow}>
          <View style={styles.buttonCell}>
            {captureStageMessage ? <BodyText>{captureStageMessage}</BodyText> : null}
            {moonFrames.isRecording ? (
              <BodyText>{t('recordingProgress', { recorded: moonFrames.recordedFrameCount, target: luckyFrameCount })}</BodyText>
            ) : null}
            {captureProgress ? (
              <BodyText tone={captureStageMessage ? 'secondary' : 'primary'}>
                {t(captureProgress.phase === 'capturing' ? 'capturingProgress' : 'decodingProgress', {
                  captured: captureProgress.completedCount,
                  target: captureProgress.totalCount,
                })}
              </BodyText>
            ) : null}
          </View>
          <View style={styles.buttonCell}>
            <AppButton label={t('stopCapture')} onPress={handleStopCapture} variant="secondary" />
          </View>
        </View>
      ) : null}
      {countdownSecondsLeft !== null && activeTab !== 'photograph' ? (
        <BodyText>{t('captureCountdown', { seconds: countdownSecondsLeft })}</BodyText>
      ) : null}
      {isProcessing ? <BodyText tone="secondary">{t('processingProgress')}</BodyText> : null}
    </>
  );

  return (
    <ScreenContainer>
      <MoonInfoCard
        moonReport={moonReport}
        hasObserverLocation={observerLocation !== null}
        isLocating={isLocating}
        canAskForLocation={canAskForLocation}
        onRequestLocation={() => void requestLocation()}
      />

      <ChipSelector<MoonScreenTab>
        options={screenTabs.map((tab) => ({ value: tab, label: t(`tabs.${tab}`) }))}
        selectedValue={activeTab}
        onSelect={handleSelectTab}
        isDisabled={isBusy}
      />

      {activeTab === 'photograph' ? (
        <>
          <SectionTitle>{t('captureModeTitle')}</SectionTitle>
          <ChipSelector
            options={shootingModes.map((modeOption) => ({ value: modeOption, label: t(`captureModes.${modeOption}`) }))}
            selectedValue={shootingMode}
            onSelect={handleSelectShootingMode}
            isDisabled={isBusy}
          />
          <BodyText tone="secondary">{t(introKey[shootingMode])}</BodyText>
          {shootingMode === 'telescope' ? (
            <>
              <BodyText tone="secondary">{t('telescopeMethodTitle')}</BodyText>
              <ChipSelector<TelescopeMethod>
                options={[
                  { value: 'photoBurst', label: t('telescopeMethods.photoBurst') },
                  { value: 'luckyFrames', label: t('telescopeMethods.luckyFrames') },
                ]}
                selectedValue={telescopeMethod}
                onSelect={setTelescopeMethod}
                isDisabled={isBusy}
              />
              {isLuckyMode ? <BodyText tone="secondary">{t('luckyIntro')}</BodyText> : null}
            </>
          ) : null}
          {shootingMode === 'earthshine' && moonReport.illuminatedFraction > earthshineMaximumIlluminatedFraction ? (
            <BodyText tone="danger">
              {t('earthshineWrongPhase', { percent: Math.round(moonReport.illuminatedFraction * 100) })}
            </BodyText>
          ) : null}
          {isEarthshineUnsupported ? <BodyText tone="danger">{t('earthshineNeedsManualExposure')}</BodyText> : null}
          <MoonCaptureAssistant
            moonReport={moonReport}
            observerLocation={observerLocation}
            focusBracketing={focusBracketing}
            whiteBalanceStatus={daylightWhiteBalance.whiteBalanceStatus}
            isRawAvailable={isRawCompatibleMode}
            isRawEnabled={isRawEnabled}
            onToggleRaw={handleToggleRaw}
            canRunFocusBracketing={liveDetection !== null && !isBusy && !isRawActive}
            onRunFocusBracketing={() => void handleRunFocusBracketing()}
          />
        </>
      ) : null}

      {activeTab === 'experiments' ? (
        <>
          <SectionTitle>{t('experiments.title')}</SectionTitle>
          <ChipSelector<MoonExperiment>
            options={moonExperiments.map((experiment) => ({ value: experiment, label: t(`experiments.names.${experiment}`) }))}
            selectedValue={selectedExperiment}
            onSelect={setSelectedExperiment}
            isDisabled={isBusy}
          />
        </>
      ) : null}

      {activeTab !== 'help' ? cameraBlock : null}

      {activeTab === 'photograph' ? (
        <>
          {!isLongCaptureRunning ? (
            <AppButton
              label={captureButtonLabel}
              onPress={() => void handleCapture()}
              isBusy={isProcessing}
              isDisabled={!liveDetection || isBusy || isEarthshineUnsupported}
            />
          ) : null}

          {stackingOutcome && stackedSkiaImage ? (
            <Card>
              <SectionTitle>{t('resultTitle')}</SectionTitle>
              {isAtlasVisible ? (
                <MoonAtlasView
                  skiaImage={stackedSkiaImage}
                  imageSide={stackingOutcome.baseImage.size}
                  atlasView={atlasOrientation?.view ?? null}
                  language={atlasLanguage}
                />
              ) : (
                <Pressable accessibilityRole="button" accessibilityLabel={t('openFullSize')} onPress={handleOpenFullSize}>
                  <View style={styles.resultRow}>
                    <ResultImage label={stackingOutcome.comparisonLabel} skiaImage={stackingOutcome.comparisonSkiaImage} />
                    <ResultImage label={stackingOutcome.resultLabel} skiaImage={stackedSkiaImage} />
                  </View>
                  {mineralSkiaImage ? (
                    <View style={styles.resultRow}>
                      <ResultImage
                        label={t('processing.mineralLabel', { gain: resultProcessing.mineralSaturationGain })}
                        skiaImage={mineralSkiaImage}
                      />
                    </View>
                  ) : null}
                </Pressable>
              )}
              <ToggleChip label={t('atlas.showNames')} isOn={isAtlasVisible} onToggle={() => setIsAtlasVisible(!isAtlasVisible)} />
              {isAtlasVisible ? (
                <AtlasControls
                  correction={imageCorrection}
                  onChangeCorrection={setImageCorrection}
                  isApproximate={atlasOrientation?.isApproximate ?? observerLocation === null}
                  hasDisk={atlasDiskFit !== null}
                />
              ) : null}
              <AppButton label={t('openFullSize')} onPress={handleOpenFullSize} variant="secondary" />
              {resultProcessingInput ? <MoonResultProcessingControls resultProcessing={resultProcessing} /> : null}
              {stackingOutcome.enhancement !== 'none' ? (
                <>
                  <BodyText tone="secondary">
                    {t(stackingOutcome.enhancement === 'wavelets' ? 'waveletSharpeningTitle' : 'sharpeningTitle')}
                  </BodyText>
                  <ChipSelector
                    options={sharpeningLevels.map((sharpeningLevel, levelIndex) => ({
                      value: String(levelIndex),
                      label: t(sharpeningLevel.labelKey),
                    }))}
                    selectedValue={String(sharpeningLevelIndex)}
                    onSelect={(levelValue) => setSharpeningLevelIndex(Number(levelValue))}
                  />
                </>
              ) : null}
              {stackingOutcome.detailLines.map((detailLine) => (
                <BodyText key={detailLine} tone="secondary">
                  {detailLine}
                </BodyText>
              ))}
              <AppButton
                label={t('core:common.save')}
                onPress={() => void handleSave()}
                isBusy={isSaving}
                isDisabled={resultProcessing.isCalculating}
              />
            </Card>
          ) : null}
        </>
      ) : null}

      {activeTab === 'experiments' && selectedExperiment === 'apparentSize' ? (
        <ApparentSizeExperiment
          observerLocation={observerLocation}
          latestSizeSource={latestSizeSource}
          isBusy={isBusy || !liveDetection}
          onCaptureForSize={handleCaptureForSize}
          saveExperimentMeasurement={saveExperimentMeasurement}
        />
      ) : null}
      {activeTab === 'experiments' && selectedExperiment === 'earthAlbedo' ? (
        <EarthAlbedoExperiment
          latestEarthshine={latestEarthshine}
          isBusy={isBusy}
          canCaptureEarthshine={liveDetection !== null && lunarManualExposure.isManualExposureActive}
          onCaptureEarthshine={() => void handleCapture({ shootingMode: 'earthshine', telescopeMethod: 'photoBurst' })}
          saveExperimentMeasurement={saveExperimentMeasurement}
        />
      ) : null}
      {activeTab === 'experiments' && selectedExperiment === 'occultation' ? (
        <OccultationExperiment
          starOffsetFromMoon={starOffsetFromMoon}
          hasMoonDetection={liveDetection !== null}
          isRecording={moonFrames.isRecording}
          recordedFrameCount={moonFrames.recordedFrameCount}
          isBusy={isCaptureInProgress || isProcessing || focusBracketing.isRunning}
          exposureSeconds={lunarManualExposure.isManualExposureActive ? lunarManualExposure.exposureSeconds : null}
          recordStarFrames={moonFrames.recordStarFrames}
          stopRecording={moonFrames.stopRecording}
          saveExperimentMeasurement={saveExperimentMeasurement}
        />
      ) : null}

      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}

      {activeTab === 'help' ? (
        <>
          <Card>
            <SectionTitle>{t('tipsTitle')}</SectionTitle>
            <BodyText tone="secondary">{t(tipsKey[shootingMode])}</BodyText>
          </Card>
          <Card>
            <SectionTitle>{t('help.captureTitle')}</SectionTitle>
            <BodyText tone="secondary">{t('help.capture')}</BodyText>
          </Card>
          <Card>
            <SectionTitle>{t('help.processingTitle')}</SectionTitle>
            <BodyText tone="secondary">{t('help.processing')}</BodyText>
          </Card>
          <Card>
            <SectionTitle>{t('help.experimentsTitle')}</SectionTitle>
            <BodyText tone="secondary">{t('help.experiments')}</BodyText>
          </Card>
          <AppButton
            label={t(isGlassesGuideVisible ? 'glassesGuide.hide' : 'glassesGuide.show')}
            onPress={() => setIsGlassesGuideVisible(!isGlassesGuideVisible)}
            variant="secondary"
          />
          {isGlassesGuideVisible ? <GlassesTelescopeGuide /> : null}
        </>
      ) : null}
    </ScreenContainer>
  );
}

/** Lo que el experimento del tamaño necesita de un resultado (null si no sirve para medirlo). */
function sizeSourceFromOutcome(outcome: StackingOutcome | null): SizeMeasurementSource | null {
  if (!outcome?.sizeScale) return null;
  return {
    grayImage: outcome.sizeScale.linearGrayImage ?? grayImageFromFloatRgb(outcome.baseImage),
    resultPixelsPerCommonPixel: outcome.sizeScale.resultPixelsPerCommonPixel,
    source: outcome.sizeScale.source,
    captureDate: outcome.captureDate,
  };
}

const meteringMarkerRadius = 28;
const starMarkerRadius = 10;

const styles = StyleSheet.create({
  previewContainer: {
    height: previewHeight,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: '#000000',
  },
  meteringMarker: {
    position: 'absolute',
    width: meteringMarkerRadius * 2,
    height: meteringMarkerRadius * 2,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#FACC15',
  },
  starMarker: {
    position: 'absolute',
    width: starMarkerRadius * 2,
    height: starMarkerRadius * 2,
    borderRadius: starMarkerRadius,
    borderWidth: 2,
    borderColor: '#38BDF8',
  },
  buttonRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  buttonCell: { flex: 1 },
  resultRow: { flexDirection: 'row', gap: 8 },
});
