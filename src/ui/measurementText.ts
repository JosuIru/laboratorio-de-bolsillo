import type { TFunction } from 'i18next';

import type { AnyInstrumentDefinition } from '@/core/instruments/types';
import { type Measurement, readMeasurementField } from '@/core/measurements/types';

/** Valor de un campo listo para mostrar: números con el formato del idioma y unidad. */
export function formatMeasurementFieldValue(
  t: TFunction,
  numberFormatter: Intl.NumberFormat,
  fieldValue: unknown,
  unit: string | undefined,
): string {
  if (Array.isArray(fieldValue)) return t('core:history.arrayValues', { count: fieldValue.length });
  const formattedValue = typeof fieldValue === 'number' ? numberFormatter.format(fieldValue) : String(fieldValue ?? '—');
  return unit ? `${formattedValue} ${unit}` : formattedValue;
}

/**
 * Resumen en una línea de los primeros campos escalares de una medición («Frecuencia: 440 Hz ·
 * Nota: La»). Los arrays, colores y campos opcionales vacíos se omiten.
 */
export function summarizeMeasurementValues(
  t: TFunction,
  locale: string,
  measurement: Measurement,
  instrument: AnyInstrumentDefinition,
  maximumFieldCount = 3,
): string {
  const numberFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
  return instrument.dataSchema.fields
    .filter((field) => field.type !== 'numberArray' && field.type !== 'color')
    .map((field) => ({ field, fieldValue: readMeasurementField(measurement.values, field.key) }))
    .filter(({ fieldValue }) => fieldValue !== undefined && fieldValue !== null && fieldValue !== '')
    .slice(0, maximumFieldCount)
    .map(
      ({ field, fieldValue }) =>
        `${t(field.labelKey, { ns: instrument.id })}: ${formatMeasurementFieldValue(t, numberFormatter, fieldValue, field.unit)}`,
    )
    .join(' · ');
}

export function instrumentDisplayName(t: TFunction, instrument: AnyInstrumentDefinition | undefined, instrumentId: string): string {
  return instrument ? t(instrument.nameKey, { ns: instrument.id }) : instrumentId;
}
