/**
 * Conversiones de color: sRGB (8 bits) ⇄ RGB lineal ⇄ CIE XYZ (D65) ⇄ CIELAB.
 * Referencias: IEC 61966-2-1 (sRGB) y CIE 15:2004 (CIELAB).
 */

/** Componentes en [0, 255] (pueden ser decimales si vienen de un promedio). */
export interface Rgb8 {
  red: number;
  green: number;
  blue: number;
}

/** Componentes lineales en [0, 1] (proporcionales a la luz). */
export interface LinearRgb {
  red: number;
  green: number;
  blue: number;
}

export interface Xyz {
  x: number;
  y: number;
  z: number;
}

export interface Lab {
  lightness: number;
  greenRed: number;
  blueYellow: number;
}

/** Blanco de referencia D65, Y normalizada a 1. */
export const whitePointD65: Xyz = { x: 0.95047, y: 1, z: 1.08883 };

export function srgbComponentToLinear(encodedComponent: number): number {
  'worklet';
  const normalizedComponent = encodedComponent / 255;
  return normalizedComponent <= 0.04045
    ? normalizedComponent / 12.92
    : ((normalizedComponent + 0.055) / 1.055) ** 2.4;
}

export function linearComponentToSrgb(linearComponent: number): number {
  'worklet';
  const clampedComponent = Math.min(1, Math.max(0, linearComponent));
  const encodedComponent =
    clampedComponent <= 0.0031308 ? 12.92 * clampedComponent : 1.055 * clampedComponent ** (1 / 2.4) - 0.055;
  return encodedComponent * 255;
}

export function srgbToLinear(color: Rgb8): LinearRgb {
  'worklet';
  return {
    red: srgbComponentToLinear(color.red),
    green: srgbComponentToLinear(color.green),
    blue: srgbComponentToLinear(color.blue),
  };
}

export function linearToSrgb(color: LinearRgb): Rgb8 {
  'worklet';
  return {
    red: linearComponentToSrgb(color.red),
    green: linearComponentToSrgb(color.green),
    blue: linearComponentToSrgb(color.blue),
  };
}

export function linearRgbToXyz(color: LinearRgb): Xyz {
  'worklet';
  return {
    x: 0.4124564 * color.red + 0.3575761 * color.green + 0.1804375 * color.blue,
    y: 0.2126729 * color.red + 0.7151522 * color.green + 0.072175 * color.blue,
    z: 0.0193339 * color.red + 0.119192 * color.green + 0.9503041 * color.blue,
  };
}

export function xyzToLinearRgb(color: Xyz): LinearRgb {
  'worklet';
  return {
    red: 3.2404542 * color.x - 1.5371385 * color.y - 0.4985314 * color.z,
    green: -0.969266 * color.x + 1.8760108 * color.y + 0.041556 * color.z,
    blue: 0.0556434 * color.x - 0.2040259 * color.y + 1.0572252 * color.z,
  };
}

const labEpsilon = 216 / 24389;
const labKappa = 24389 / 27;

function labCompand(ratio: number): number {
  'worklet';
  return ratio > labEpsilon ? Math.cbrt(ratio) : (labKappa * ratio + 16) / 116;
}

function labInverseCompand(companded: number): number {
  'worklet';
  const cubed = companded ** 3;
  return cubed > labEpsilon ? cubed : (116 * companded - 16) / labKappa;
}

export function xyzToLab(color: Xyz, whitePoint: Xyz = whitePointD65): Lab {
  'worklet';
  const compandedX = labCompand(color.x / whitePoint.x);
  const compandedY = labCompand(color.y / whitePoint.y);
  const compandedZ = labCompand(color.z / whitePoint.z);
  return {
    lightness: 116 * compandedY - 16,
    greenRed: 500 * (compandedX - compandedY),
    blueYellow: 200 * (compandedY - compandedZ),
  };
}

export function labToXyz(color: Lab, whitePoint: Xyz = whitePointD65): Xyz {
  'worklet';
  const compandedY = (color.lightness + 16) / 116;
  const compandedX = compandedY + color.greenRed / 500;
  const compandedZ = compandedY - color.blueYellow / 200;
  return {
    x: whitePoint.x * labInverseCompand(compandedX),
    y: whitePoint.y * labInverseCompand(compandedY),
    z: whitePoint.z * labInverseCompand(compandedZ),
  };
}

export function srgbToLab(color: Rgb8): Lab {
  'worklet';
  return xyzToLab(linearRgbToXyz(srgbToLinear(color)));
}

export function linearRgbToLab(color: LinearRgb): Lab {
  'worklet';
  return xyzToLab(linearRgbToXyz(color));
}

export function labToSrgb(color: Lab): Rgb8 {
  'worklet';
  return linearToSrgb(xyzToLinearRgb(labToXyz(color)));
}

/** `#RRGGBB` para mostrar un color en pantalla o guardarlo en una medición. */
export function rgb8ToHex(color: Rgb8): string {
  const toHexPair = (component: number) =>
    Math.round(Math.min(255, Math.max(0, component)))
      .toString(16)
      .padStart(2, '0');
  return `#${toHexPair(color.red)}${toHexPair(color.green)}${toHexPair(color.blue)}`.toUpperCase();
}

export function hexToRgb8(hexColor: string): Rgb8 | null {
  const hexMatch = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hexColor.trim());
  if (!hexMatch) return null;
  return { red: parseInt(hexMatch[1]!, 16), green: parseInt(hexMatch[2]!, 16), blue: parseInt(hexMatch[3]!, 16) };
}
