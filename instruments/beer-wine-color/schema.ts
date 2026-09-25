import { defineMeasurementSchema } from '@/core/measurements/schema';

/**
 * Una medición guarda la transmitancia de cada canal (lo que de verdad se mide) y lo que se
 * deduce de ella: SRM y EBC en cerveza; intensidad y tonalidad aproximadas en vino.
 */
export interface BeerWineColorMeasurementValues {
  /** `beer`, `white`, `rose` o `red`. */
  liquidType: string;
  pathLengthMm: number;
  descriptor: string;
  srm?: number;
  ebc?: number;
  fitResidual?: number;
  colorIntensity?: number;
  hue?: number;
  transmittanceRed: number;
  transmittanceGreen: number;
  transmittanceBlue: number;
  sampleColor: string;
  paperColor: string;
  /** Avisos de exposición separados por comas (vacío si no hubo). */
  exposureProblems: string;
}

export const beerWineColorSchema = defineMeasurementSchema<BeerWineColorMeasurementValues>(1, [
  { key: 'liquidType', labelKey: 'fields.liquidType', type: 'string' },
  { key: 'srm', labelKey: 'fields.srm', type: 'number', unit: 'SRM', optional: true },
  { key: 'ebc', labelKey: 'fields.ebc', type: 'number', unit: 'EBC', optional: true },
  { key: 'colorIntensity', labelKey: 'fields.colorIntensity', type: 'number', optional: true },
  { key: 'hue', labelKey: 'fields.hue', type: 'number', optional: true },
  { key: 'descriptor', labelKey: 'fields.descriptor', type: 'string' },
  { key: 'pathLengthMm', labelKey: 'fields.pathLengthMm', type: 'number', unit: 'mm' },
  { key: 'sampleColor', labelKey: 'fields.sampleColor', type: 'color' },
  { key: 'paperColor', labelKey: 'fields.paperColor', type: 'color' },
  { key: 'transmittanceRed', labelKey: 'fields.transmittanceRed', type: 'number' },
  { key: 'transmittanceGreen', labelKey: 'fields.transmittanceGreen', type: 'number' },
  { key: 'transmittanceBlue', labelKey: 'fields.transmittanceBlue', type: 'number' },
  { key: 'fitResidual', labelKey: 'fields.fitResidual', type: 'number', optional: true },
  { key: 'exposureProblems', labelKey: 'fields.exposureProblems', type: 'string' },
]);
