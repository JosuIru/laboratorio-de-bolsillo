/**
 * Atlas superpuesto a la foto de la Luna (lógica pura, sin React ni React Native).
 *
 * 1. El disco (centro y radio) se ajusta en la imagen apilada con `fitLunarDisk`.
 * 2. La orientación se calcula para la hora de la captura: libración y ángulo del eje P; con la
 *    ubicación, también el ángulo paraláctico q (cuánto está girado el cenit respecto al norte
 *    celeste) y el giro del móvil medido con el acelerómetro. Sin ubicación solo se usa P y la
 *    orientación es aproximada (el error es q, que puede llegar a decenas de grados).
 * 3. La corrección manual («la imagen sale girada»: 0/90/180/270° y espejo) cubre la óptica:
 *    un telescopio o una lente sola giran 180°; una diagonal, además, da la vuelta a la imagen.
 * 4. Se proyectan los accidentes del catálogo y se eligen las marcas y los nombres que caben.
 */
import {
  computeLunarNorthAngleInImageDegrees,
  computeLunarOrientation,
  computeParallacticAngleDegrees,
} from '@/processing/astronomy/lunarOrientation';
import {
  type LunarDiskView,
  type LunarFeature,
  type LunarFeatureKind,
  projectLunarFeatures,
} from '@/processing/astronomy/lunarFeatures';
import type { ObserverLocation } from '@/processing/astronomy/moonEphemeris';
import type { GrayImage } from '@/processing/image/grayImage';
import type { Circle } from '@/processing/image/lunarDiskFit';
import type { FloatRgbImage } from '@/processing/image/lunarStacking';

export type OpticsRotationDegrees = 0 | 90 | 180 | 270;
export const opticsRotationOptions: readonly OpticsRotationDegrees[] = [0, 90, 180, 270];

export interface ManualImageCorrection {
  /** Giro que añade la óptica, antihorario en la imagen. */
  opticsRotationDegrees: OpticsRotationDegrees;
  isMirrored: boolean;
}

/** Luminancia de una imagen flotante RGB (0-255), para ajustar el disco. */
export function grayImageFromFloatRgb(image: FloatRgbImage): GrayImage {
  const pixelCount = image.size * image.size;
  const values = new Float32Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const channelOffset = pixelIndex * 3;
    values[pixelIndex] =
      0.299 * image.channels[channelOffset]! +
      0.587 * image.channels[channelOffset + 1]! +
      0.114 * image.channels[channelOffset + 2]!;
  }
  return { width: image.size, height: image.size, values };
}

/** Por debajo de esta fracción de la gravedad en el plano de la pantalla, el giro no se sabe. */
const minimumInPlaneGravityFraction = 0.25;

/**
 * Giro del móvil alrededor del eje de la cámara, desde el vector «hacia arriba» del
 * acelerómetro en ejes del aparato (x a la derecha, y hacia el borde de arriba, z hacia la
 * pantalla). 0 = el borde de arriba apunta hacia el cenit; positivo si se gira en sentido
 * antihorario tal como se mira la pantalla. null si la cámara mira casi al cenit o al suelo.
 */
export function deviceRollFromUpwardAcceleration(upwardAcceleration: { x: number; y: number; z: number }): number | null {
  const inPlaneMagnitude = Math.hypot(upwardAcceleration.x, upwardAcceleration.y);
  const totalMagnitude = Math.hypot(inPlaneMagnitude, upwardAcceleration.z);
  if (totalMagnitude === 0 || inPlaneMagnitude < minimumInPlaneGravityFraction * totalMagnitude) return null;
  return (Math.atan2(upwardAcceleration.x, upwardAcceleration.y) * 180) / Math.PI;
}

export interface AtlasOrientationInputs {
  julianDay: number;
  observerLocation: ObserverLocation | null;
  /** Giro del móvil en la captura; null si no se conoce (se toma 0). */
  deviceRollDegrees: number | null;
  correction: ManualImageCorrection;
  disk: Circle;
}

export interface AtlasOrientation {
  view: LunarDiskView;
  /** Sin ubicación: solo se conoce el eje de la Luna respecto al norte, no respecto al cenit. */
  isApproximate: boolean;
}

/** Vista del disco para proyectar el atlas sobre la imagen apilada. */
export function computeAtlasOrientation({
  julianDay,
  observerLocation,
  deviceRollDegrees,
  correction,
  disk,
}: AtlasOrientationInputs): AtlasOrientation {
  const lunarOrientation = computeLunarOrientation(julianDay);
  const parallacticAngleDegrees = observerLocation
    ? computeParallacticAngleDegrees(lunarOrientation.moonEquatorialPosition, observerLocation, julianDay)
    : 0;
  const northAngleDegrees = computeLunarNorthAngleInImageDegrees({
    axisPositionAngleDegrees: lunarOrientation.axisPositionAngleDegrees,
    parallacticAngleDegrees,
    // Sin ubicación, el «arriba» de la foto no se relaciona con el cielo: el giro no aporta.
    deviceRollDegrees: observerLocation ? (deviceRollDegrees ?? 0) : 0,
    opticsRotationDegrees: correction.opticsRotationDegrees,
  });
  return {
    view: {
      centerX: disk.centerX,
      centerY: disk.centerY,
      radiusPixels: disk.radius,
      librationLongitudeDegrees: lunarOrientation.librationLongitudeDegrees,
      librationLatitudeDegrees: lunarOrientation.librationLatitudeDegrees,
      northAngleDegrees,
      subsolarPoint: lunarOrientation.subsolarPoint,
      isMirroredHorizontally: correction.isMirrored,
    },
    isApproximate: observerLocation === null,
  };
}

export type AtlasLanguage = 'es' | 'eu';

export interface AtlasMark {
  featureId: string;
  kind: LunarFeatureKind;
  /** Posición en píxeles de la imagen mostrada. */
  displayX: number;
  displayY: number;
  /** Radio del círculo de la marca en la imagen mostrada (0 = solo un punto). */
  markRadius: number;
  /** null: solo la marca, el nombre no cabe. */
  label: string | null;
  isIlluminated: boolean;
}

/** Radios del disco mostrado (px) a partir de los que se ponen marcas y nombres de cada tipo. */
export const atlasDisplayThresholds = {
  /** Por debajo, el disco es demasiado pequeño para cualquier marca. */
  minimumDiskRadius: 50,
  mareLabels: 50,
  craterMarks: 80,
  craterLabels: 120,
  landingSiteLabels: 120,
} as const;

/** El nombre de un accidente en el idioma de la app (castellano si no es euskera). */
export function atlasLanguageFor(appLanguage: string | undefined): AtlasLanguage {
  return appLanguage?.toLowerCase().startsWith('eu') ? 'eu' : 'es';
}

/**
 * Marcas del atlas en la imagen mostrada: solo los accidentes de la cara visible, con nombre
 * según el tamaño del disco en pantalla (en un disco pequeño no caben los de los cráteres).
 * `displayScale` pasa de píxeles de la imagen a píxeles de pantalla.
 */
export function chooseAtlasMarks(
  view: LunarDiskView,
  displayScale: number,
  language: AtlasLanguage,
  features?: readonly LunarFeature[],
): AtlasMark[] {
  const displayedDiskRadius = view.radiusPixels * displayScale;
  if (displayedDiskRadius < atlasDisplayThresholds.minimumDiskRadius) return [];
  const atlasMarks: AtlasMark[] = [];
  for (const projectedFeature of projectLunarFeatures(view, features)) {
    if (!projectedFeature.isOnVisibleSide) continue;
    const { kind } = projectedFeature.feature;
    if (kind === 'crater' && displayedDiskRadius < atlasDisplayThresholds.craterMarks) continue;
    const showsLabel =
      kind === 'mare'
        ? displayedDiskRadius >= atlasDisplayThresholds.mareLabels
        : kind === 'crater'
          ? displayedDiskRadius >= atlasDisplayThresholds.craterLabels
          : displayedDiskRadius >= atlasDisplayThresholds.landingSiteLabels;
    atlasMarks.push({
      featureId: projectedFeature.feature.id,
      kind,
      displayX: projectedFeature.imageX * displayScale,
      displayY: projectedFeature.imageY * displayScale,
      // Los mares son grandes y difusos: solo un punto; los cráteres, un círculo de su tamaño.
      markRadius: kind === 'crater' ? Math.max(3, projectedFeature.apparentRadiusPixels * displayScale) : 0,
      label: showsLabel ? projectedFeature.feature.names[language] : null,
      isIlluminated: projectedFeature.isIlluminated,
    });
  }
  return atlasMarks;
}
