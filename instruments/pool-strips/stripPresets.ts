/**
 * Tipos de tira y parámetros. Las escalas por defecto son **orientativas**: colores aproximados
 * a los de las tiras genéricas del mercado, no copiados de la carta de ningún fabricante (cada
 * marca usa sus propios colores y niveles). Para medir de verdad hay que calibrar la escala
 * fotografiando la carta del bote.
 */

export const poolStripsInstrumentId = 'pool-strips';

export type StripPresetId = 'pool' | 'aquarium';

/** Magnitud medida: da nombre al parámetro y a su columna en el historial y el CSV. */
export type StripQuantity =
  | 'ph'
  | 'freeChlorine'
  | 'totalChlorine'
  | 'totalAlkalinity'
  | 'totalHardness'
  | 'cyanuricAcid'
  | 'carbonateHardness'
  | 'generalHardness'
  | 'nitrite'
  | 'nitrate'
  | 'chlorine';

export type StripParameterId =
  | 'pool-ph'
  | 'pool-free-chlorine'
  | 'pool-total-chlorine'
  | 'pool-total-alkalinity'
  | 'pool-total-hardness'
  | 'pool-cyanuric-acid'
  | 'aquarium-ph'
  | 'aquarium-carbonate-hardness'
  | 'aquarium-general-hardness'
  | 'aquarium-nitrite'
  | 'aquarium-nitrate'
  | 'aquarium-chlorine';

/** Un nivel de la escala de colores: valor y color (sRGB, como en la carta impresa). */
export interface StripScaleLevel {
  value: number;
  hexColor: string;
}

/** Límites del rango recomendado; `null` = sin límite por ese lado (p. ej. nitritos: cuanto menos, mejor). */
export interface IdealRange {
  minimum: number | null;
  maximum: number | null;
}

export interface StripParameter {
  id: StripParameterId;
  quantity: StripQuantity;
  /** Unidad para mostrar ('' en el pH). */
  unit: string;
  /** Decimales con los que tiene sentido mostrar el valor (la resolución de una tira es baja). */
  displayFractionDigits: number;
  idealRange: IdealRange;
  defaultScale: readonly StripScaleLevel[];
}

export interface StripPreset {
  id: StripPresetId;
  /** Parámetros en el orden habitual de las tiras «6 en 1» (desde el asa). */
  parameterIds: readonly StripParameterId[];
}

export const stripParameters: Record<StripParameterId, StripParameter> = {
  // Piscina: rangos habituales de mantenimiento de agua de piscina.
  'pool-ph': {
    id: 'pool-ph',
    quantity: 'ph',
    unit: '',
    displayFractionDigits: 1,
    idealRange: { minimum: 7.2, maximum: 7.6 },
    defaultScale: [
      { value: 6.2, hexColor: '#F2B233' },
      { value: 6.8, hexColor: '#F09A3A' },
      { value: 7.2, hexColor: '#EC7F3F' },
      { value: 7.8, hexColor: '#E4604A' },
      { value: 8.4, hexColor: '#D2405A' },
    ],
  },
  'pool-free-chlorine': {
    id: 'pool-free-chlorine',
    quantity: 'freeChlorine',
    unit: 'mg/L',
    displayFractionDigits: 1,
    idealRange: { minimum: 1, maximum: 3 },
    defaultScale: [
      { value: 0, hexColor: '#F6F2DC' },
      { value: 0.5, hexColor: '#E6DDE8' },
      { value: 1, hexColor: '#D3C3E0' },
      { value: 3, hexColor: '#B08FCB' },
      { value: 5, hexColor: '#8D66B5' },
      { value: 10, hexColor: '#6A3F98' },
    ],
  },
  'pool-total-chlorine': {
    id: 'pool-total-chlorine',
    quantity: 'totalChlorine',
    unit: 'mg/L',
    displayFractionDigits: 1,
    idealRange: { minimum: 1, maximum: 3 },
    defaultScale: [
      { value: 0, hexColor: '#F4F0E0' },
      { value: 0.5, hexColor: '#E2E0EA' },
      { value: 1, hexColor: '#C9C8E0' },
      { value: 3, hexColor: '#9E9CCB' },
      { value: 5, hexColor: '#7B76B5' },
      { value: 10, hexColor: '#57509A' },
    ],
  },
  'pool-total-alkalinity': {
    id: 'pool-total-alkalinity',
    quantity: 'totalAlkalinity',
    unit: 'mg/L',
    displayFractionDigits: 0,
    idealRange: { minimum: 80, maximum: 120 },
    defaultScale: [
      { value: 0, hexColor: '#E8D35A' },
      { value: 40, hexColor: '#C5C85A' },
      { value: 80, hexColor: '#93B25E' },
      { value: 120, hexColor: '#6A9E6C' },
      { value: 180, hexColor: '#4A8C7C' },
      { value: 240, hexColor: '#357A84' },
    ],
  },
  'pool-total-hardness': {
    id: 'pool-total-hardness',
    quantity: 'totalHardness',
    unit: 'mg/L',
    displayFractionDigits: 0,
    idealRange: { minimum: 150, maximum: 400 },
    defaultScale: [
      { value: 0, hexColor: '#3A6FB0' },
      { value: 100, hexColor: '#5B64A8' },
      { value: 250, hexColor: '#7D5A9E' },
      { value: 500, hexColor: '#9C4A8C' },
      { value: 1000, hexColor: '#B0406F' },
    ],
  },
  'pool-cyanuric-acid': {
    id: 'pool-cyanuric-acid',
    quantity: 'cyanuricAcid',
    unit: 'mg/L',
    displayFractionDigits: 0,
    idealRange: { minimum: 30, maximum: 50 },
    defaultScale: [
      { value: 0, hexColor: '#E9B96A' },
      { value: 30, hexColor: '#D99A6E' },
      { value: 50, hexColor: '#C77C74' },
      { value: 100, hexColor: '#B0607C' },
      { value: 150, hexColor: '#9A4C84' },
      { value: 300, hexColor: '#7E3A88' },
    ],
  },
  // Acuario de agua dulce comunitario (peces tropicales): rangos generales, cada especie tiene los suyos.
  'aquarium-ph': {
    id: 'aquarium-ph',
    quantity: 'ph',
    unit: '',
    displayFractionDigits: 1,
    idealRange: { minimum: 6.5, maximum: 7.5 },
    defaultScale: [
      { value: 6.4, hexColor: '#E7B447' },
      { value: 6.8, hexColor: '#E08A45' },
      { value: 7.2, hexColor: '#D9713F' },
      { value: 7.6, hexColor: '#CF5A3E' },
      { value: 8.0, hexColor: '#C4433F' },
      { value: 8.4, hexColor: '#B23447' },
    ],
  },
  'aquarium-carbonate-hardness': {
    id: 'aquarium-carbonate-hardness',
    quantity: 'carbonateHardness',
    unit: '°dH',
    displayFractionDigits: 0,
    idealRange: { minimum: 3, maximum: 8 },
    defaultScale: [
      { value: 0, hexColor: '#E9CC5C' },
      { value: 3, hexColor: '#C9C160' },
      { value: 6, hexColor: '#9DB06C' },
      { value: 10, hexColor: '#6E9A78' },
      { value: 15, hexColor: '#4D8280' },
      { value: 20, hexColor: '#3A6E80' },
    ],
  },
  'aquarium-general-hardness': {
    id: 'aquarium-general-hardness',
    quantity: 'generalHardness',
    unit: '°dH',
    displayFractionDigits: 0,
    idealRange: { minimum: 4, maximum: 12 },
    defaultScale: [
      { value: 0, hexColor: '#3E7BB8' },
      { value: 4, hexColor: '#5E6CAD' },
      { value: 7, hexColor: '#7E5FA3' },
      { value: 14, hexColor: '#9C5294' },
      { value: 21, hexColor: '#B04A84' },
    ],
  },
  'aquarium-nitrite': {
    id: 'aquarium-nitrite',
    quantity: 'nitrite',
    unit: 'mg/L',
    displayFractionDigits: 1,
    idealRange: { minimum: null, maximum: 0.1 },
    defaultScale: [
      { value: 0, hexColor: '#F7F2E8' },
      { value: 0.5, hexColor: '#F4DCE0' },
      { value: 1, hexColor: '#EEC3D2' },
      { value: 3, hexColor: '#E09FBF' },
      { value: 5, hexColor: '#D17BAE' },
      { value: 10, hexColor: '#C05A9C' },
    ],
  },
  'aquarium-nitrate': {
    id: 'aquarium-nitrate',
    quantity: 'nitrate',
    unit: 'mg/L',
    displayFractionDigits: 0,
    idealRange: { minimum: null, maximum: 25 },
    defaultScale: [
      { value: 0, hexColor: '#F8F3E9' },
      { value: 10, hexColor: '#F5DDE2' },
      { value: 25, hexColor: '#EFC2D4' },
      { value: 50, hexColor: '#E3A0C2' },
      { value: 100, hexColor: '#D47DAF' },
      { value: 250, hexColor: '#C45B9D' },
    ],
  },
  'aquarium-chlorine': {
    id: 'aquarium-chlorine',
    quantity: 'chlorine',
    unit: 'mg/L',
    displayFractionDigits: 1,
    idealRange: { minimum: null, maximum: 0.1 },
    defaultScale: [
      { value: 0, hexColor: '#F6F3E4' },
      { value: 0.8, hexColor: '#EBE3EE' },
      { value: 1.5, hexColor: '#D9CBE4' },
      { value: 3, hexColor: '#BFA6D4' },
    ],
  },
};

export const stripPresets: Record<StripPresetId, StripPreset> = {
  pool: {
    id: 'pool',
    parameterIds: [
      'pool-total-hardness',
      'pool-total-chlorine',
      'pool-free-chlorine',
      'pool-ph',
      'pool-total-alkalinity',
      'pool-cyanuric-acid',
    ],
  },
  aquarium: {
    id: 'aquarium',
    parameterIds: [
      'aquarium-nitrate',
      'aquarium-nitrite',
      'aquarium-general-hardness',
      'aquarium-chlorine',
      'aquarium-carbonate-hardness',
      'aquarium-ph',
    ],
  },
};

export const stripPresetIds: readonly StripPresetId[] = ['pool', 'aquarium'];

export function isStripPresetId(candidateId: unknown): candidateId is StripPresetId {
  return candidateId === 'pool' || candidateId === 'aquarium';
}

export function isStripParameterId(candidateId: unknown): candidateId is StripParameterId {
  return typeof candidateId === 'string' && Object.prototype.hasOwnProperty.call(stripParameters, candidateId);
}

/** Tiempos de lectura habituales (segundos tras mojar la tira); el bote indica el suyo. */
export const readingDelayOptionsSeconds: readonly number[] = [15, 30, 60];
export const defaultReadingDelaySeconds = 30;

/**
 * Hueco de la tira que no se lee (una almohadilla de un parámetro que no conocemos): ocupa su
 * sitio en la guía para que las demás caigan donde deben.
 */
export const ignoredPadSlot = 'ignored';
export type StripPadSlot = StripParameterId | typeof ignoredPadSlot;

export const maximumPadCount = 8;
