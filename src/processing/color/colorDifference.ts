import type { Lab } from './colorSpaces';

/** ΔE*ab (CIE76): distancia euclídea en CIELAB. Simple pero poco uniforme en los saturados. */
export function deltaE76(firstColor: Lab, secondColor: Lab): number {
  'worklet';
  return Math.hypot(
    firstColor.lightness - secondColor.lightness,
    firstColor.greenRed - secondColor.greenRed,
    firstColor.blueYellow - secondColor.blueYellow,
  );
}

const degreesPerRadian = 180 / Math.PI;
const radiansPerDegree = Math.PI / 180;
const twentyFiveToTheSeventh = 25 ** 7;

function hueAngleDegrees(blueYellow: number, greenRed: number): number {
  'worklet';
  if (blueYellow === 0 && greenRed === 0) return 0;
  const angleDegrees = Math.atan2(blueYellow, greenRed) * degreesPerRadian;
  return angleDegrees >= 0 ? angleDegrees : angleDegrees + 360;
}

/**
 * ΔE00 (CIEDE2000), la diferencia de color más fiel a la percepción. Implementación según
 * Sharma, Wu y Dalal (2005), con factores paramétricos kL = kC = kH = 1.
 * Orientativo: ΔE00 < 1 imperceptible, 1-2 apenas perceptible, > 5 claramente distinto.
 */
export function deltaE2000(firstColor: Lab, secondColor: Lab): number {
  'worklet';
  const { lightness: lightness1, greenRed: greenRed1, blueYellow: blueYellow1 } = firstColor;
  const { lightness: lightness2, greenRed: greenRed2, blueYellow: blueYellow2 } = secondColor;

  const chroma1 = Math.hypot(greenRed1, blueYellow1);
  const chroma2 = Math.hypot(greenRed2, blueYellow2);
  const meanChromaToSeventh = ((chroma1 + chroma2) / 2) ** 7;
  const chromaCompensation = 0.5 * (1 - Math.sqrt(meanChromaToSeventh / (meanChromaToSeventh + twentyFiveToTheSeventh)));

  const adjustedGreenRed1 = (1 + chromaCompensation) * greenRed1;
  const adjustedGreenRed2 = (1 + chromaCompensation) * greenRed2;
  const adjustedChroma1 = Math.hypot(adjustedGreenRed1, blueYellow1);
  const adjustedChroma2 = Math.hypot(adjustedGreenRed2, blueYellow2);
  const hue1 = hueAngleDegrees(blueYellow1, adjustedGreenRed1);
  const hue2 = hueAngleDegrees(blueYellow2, adjustedGreenRed2);

  const lightnessDifference = lightness2 - lightness1;
  const chromaDifference = adjustedChroma2 - adjustedChroma1;
  const chromaProduct = adjustedChroma1 * adjustedChroma2;

  let hueDifference = 0;
  if (chromaProduct !== 0) {
    hueDifference = hue2 - hue1;
    if (hueDifference > 180) hueDifference -= 360;
    else if (hueDifference < -180) hueDifference += 360;
  }
  const hueDistance = 2 * Math.sqrt(chromaProduct) * Math.sin((hueDifference / 2) * radiansPerDegree);

  const meanLightness = (lightness1 + lightness2) / 2;
  const meanChroma = (adjustedChroma1 + adjustedChroma2) / 2;
  let meanHue = hue1 + hue2;
  if (chromaProduct !== 0) {
    if (Math.abs(hue1 - hue2) <= 180) meanHue /= 2;
    else meanHue = hue1 + hue2 < 360 ? (meanHue + 360) / 2 : (meanHue - 360) / 2;
  }

  const hueWeighting =
    1 -
    0.17 * Math.cos((meanHue - 30) * radiansPerDegree) +
    0.24 * Math.cos(2 * meanHue * radiansPerDegree) +
    0.32 * Math.cos((3 * meanHue + 6) * radiansPerDegree) -
    0.2 * Math.cos((4 * meanHue - 63) * radiansPerDegree);
  const rotationAngleDegrees = 30 * Math.exp(-(((meanHue - 275) / 25) ** 2));
  const meanChromaToSeventhAdjusted = meanChroma ** 7;
  const rotationChromaFactor =
    2 * Math.sqrt(meanChromaToSeventhAdjusted / (meanChromaToSeventhAdjusted + twentyFiveToTheSeventh));
  const lightnessOffsetSquared = (meanLightness - 50) ** 2;

  const lightnessScale = 1 + (0.015 * lightnessOffsetSquared) / Math.sqrt(20 + lightnessOffsetSquared);
  const chromaScale = 1 + 0.045 * meanChroma;
  const hueScale = 1 + 0.015 * meanChroma * hueWeighting;
  const rotationTerm = -Math.sin(2 * rotationAngleDegrees * radiansPerDegree) * rotationChromaFactor;

  const scaledLightness = lightnessDifference / lightnessScale;
  const scaledChroma = chromaDifference / chromaScale;
  const scaledHue = hueDistance / hueScale;
  return Math.sqrt(
    scaledLightness ** 2 + scaledChroma ** 2 + scaledHue ** 2 + rotationTerm * scaledChroma * scaledHue,
  );
}
