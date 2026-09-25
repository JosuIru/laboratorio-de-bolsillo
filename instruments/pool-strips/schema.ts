import { defineMeasurementSchema } from '@/core/measurements/schema';

import type { StripQuantity } from './stripPresets';

/**
 * Una medición guarda el valor de cada parámetro en su propia columna (vacía si la tira no lo
 * lleva) y, en listas con el orden de `padOrder`, el color y la diferencia con la escala de cada
 * almohadilla leída.
 */
export type PoolStripsMeasurementValues = Partial<Record<StripQuantity, number>> & {
  stripType: string;
  /** Parámetros de las almohadillas leídas, separados por comas, desde el asa. */
  padOrder: string;
  /** Color corregido de cada almohadilla (#RRGGBB separados por comas). */
  padColors: string;
  /** ΔE00 entre cada almohadilla y el punto interpolado de su escala. */
  padDeltaE: number[];
  maximumDeltaE: number;
  /** `default` (escala orientativa) o `calibrated` (fotografiada de la carta) por almohadilla. */
  padScaleSources: string;
  /** Parámetros fuera del rango recomendado, p. ej. `ph:high,nitrite:high`. */
  outOfRangeParameters: string;
  correctionModel: string;
  referencePatchCount: number;
  correctionMeanResidualDeltaE?: number;
  secondsAfterDip?: number;
};

export const poolStripsSchema = defineMeasurementSchema<PoolStripsMeasurementValues>(1, [
  { key: 'stripType', labelKey: 'fields.stripType', type: 'string' },
  { key: 'ph', labelKey: 'fields.ph', type: 'number', optional: true },
  { key: 'freeChlorine', labelKey: 'fields.freeChlorine', type: 'number', unit: 'mg/L', optional: true },
  { key: 'totalChlorine', labelKey: 'fields.totalChlorine', type: 'number', unit: 'mg/L', optional: true },
  { key: 'totalAlkalinity', labelKey: 'fields.totalAlkalinity', type: 'number', unit: 'mg/L', optional: true },
  { key: 'totalHardness', labelKey: 'fields.totalHardness', type: 'number', unit: 'mg/L', optional: true },
  { key: 'cyanuricAcid', labelKey: 'fields.cyanuricAcid', type: 'number', unit: 'mg/L', optional: true },
  { key: 'carbonateHardness', labelKey: 'fields.carbonateHardness', type: 'number', unit: '°dH', optional: true },
  { key: 'generalHardness', labelKey: 'fields.generalHardness', type: 'number', unit: '°dH', optional: true },
  { key: 'nitrite', labelKey: 'fields.nitrite', type: 'number', unit: 'mg/L', optional: true },
  { key: 'nitrate', labelKey: 'fields.nitrate', type: 'number', unit: 'mg/L', optional: true },
  { key: 'chlorine', labelKey: 'fields.chlorine', type: 'number', unit: 'mg/L', optional: true },
  { key: 'outOfRangeParameters', labelKey: 'fields.outOfRangeParameters', type: 'string' },
  { key: 'maximumDeltaE', labelKey: 'fields.maximumDeltaE', type: 'number', unit: 'ΔE00' },
  { key: 'padOrder', labelKey: 'fields.padOrder', type: 'string' },
  { key: 'padColors', labelKey: 'fields.padColors', type: 'string' },
  { key: 'padDeltaE', labelKey: 'fields.padDeltaE', type: 'numberArray', unit: 'ΔE00' },
  { key: 'padScaleSources', labelKey: 'fields.padScaleSources', type: 'string' },
  { key: 'secondsAfterDip', labelKey: 'fields.secondsAfterDip', type: 'number', unit: 's', optional: true },
  { key: 'correctionModel', labelKey: 'fields.correctionModel', type: 'string' },
  { key: 'referencePatchCount', labelKey: 'fields.referencePatchCount', type: 'number' },
  {
    key: 'correctionMeanResidualDeltaE',
    labelKey: 'fields.correctionResidual',
    type: 'number',
    unit: 'ΔE00',
    optional: true,
  },
]);
