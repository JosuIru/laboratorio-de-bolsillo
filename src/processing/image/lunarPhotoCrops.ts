/**
 * Recortes de la Luna a partir de fotos a resolución completa (lógica pura).
 *
 * De cada foto se decodifica solo una zona de búsqueda alrededor de donde estaba la Luna en la
 * vista previa (con margen para lo que se mueva durante la ráfaga). Dentro de esa zona se vuelve a
 * localizar la Luna y se recorta un cuadrado centrado en ella, listo para `stackSharpestCrops`.
 */
import { type AlignedCrop, type BrightObjectDetection, copyCenteredCrop, locateBrightObject, planCenteredCrop } from './lunarStacking';

/** Margen para la deriva durante la ráfaga, como fracción del lado corto de la foto. */
const driftMarginFraction = 0.08;
/** La zona de búsqueda abarca al menos este lado (o la foto entera si es menor). */
const minimumSearchRegionSide = 256;
/** Por debajo de este lado se busca píxel a píxel; por encima, uno de cada dos (sobra precisión). */
const fullResolutionSearchSide = 512;

/**
 * Lado de la zona de búsqueda en píxeles de la foto: la Luna con margen (1,5 radios a cada lado)
 * más la deriva posible, acotado a la foto.
 */
export function moonSearchRegionSide(expectedRadiusPixels: number, photoShortSidePixels: number): number {
  const desiredSide = expectedRadiusPixels * 3 + photoShortSidePixels * driftMarginFraction * 2;
  return Math.round(Math.min(photoShortSidePixels, Math.max(Math.min(minimumSearchRegionSide, photoShortSidePixels), desiredSide)));
}

export interface MoonCropFromRegion {
  alignedCrop: AlignedCrop;
  /** Detección dentro de la zona (coordenadas y radio en píxeles de la zona). */
  detection: BrightObjectDetection;
}

/** Localiza la Luna en una zona RGB compacta; null si no está. */
export function locateMoonInRegion(regionRgb: Uint8Array, regionWidth: number, regionHeight: number): BrightObjectDetection | null {
  const sampleStride = Math.max(regionWidth, regionHeight) > fullResolutionSearchSide ? 2 : 1;
  return locateBrightObject(regionRgb, regionWidth, regionHeight, regionWidth * 3, 3, sampleStride);
}

/**
 * Recorte de lado `cropSize` centrado en la Luna de la zona (fuera de la zona, negro), con el
 * resto subpíxel del centro para alinearlo al apilar. null si la Luna no está en la zona.
 */
export function moonCropFromRegion(
  regionRgb: Uint8Array,
  regionWidth: number,
  regionHeight: number,
  cropSize: number,
  detection: BrightObjectDetection | null = locateMoonInRegion(regionRgb, regionWidth, regionHeight),
): MoonCropFromRegion | null {
  if (!detection) return null;
  const cropPlan = planCenteredCrop(detection.centerX, detection.centerY, cropSize);
  const rgbPixels = new Uint8Array(cropSize * cropSize * 3);
  copyCenteredCrop(regionRgb, regionWidth, regionHeight, regionWidth * 3, 3, false, cropPlan.cropLeft, cropPlan.cropTop, cropSize, rgbPixels);
  return {
    alignedCrop: {
      rgbPixels,
      fractionalOffsetX: cropPlan.fractionalOffsetX,
      fractionalOffsetY: cropPlan.fractionalOffsetY,
    },
    detection,
  };
}

/** Mediana (0 si no hay valores): el radio típico de la Luna en la ráfaga, sin que un fallo lo mueva. */
export function medianValue(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sortedValues = [...values].sort((firstValue, secondValue) => firstValue - secondValue);
  const middleIndex = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 1
    ? sortedValues[middleIndex]!
    : (sortedValues[middleIndex - 1]! + sortedValues[middleIndex]!) / 2;
}
