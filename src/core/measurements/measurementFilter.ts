import type { Measurement } from './types';

/** Intervalos de fechas sencillos de «Mis datos». */
export type DateRangeFilter = 'today' | 'last7Days' | 'last30Days' | 'all';

export const dateRangeFilters: readonly DateRangeFilter[] = ['today', 'last7Days', 'last30Days', 'all'];

export interface MeasurementFilter {
  /** Vacío o ausente: todos los instrumentos. */
  instrumentIds?: readonly string[];
  /** Solo mediciones con `timestamp >= fromTimestamp` (epoch en ms). */
  fromTimestamp?: number;
}

function startOfLocalDay(referenceDate: Date): Date {
  return new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
}

/**
 * Primer instante del intervalo según la hora local: «hoy» empieza a medianoche y «7 días»
 * incluye hoy y los seis días anteriores completos. `undefined` significa sin límite.
 */
export function startTimestampForDateRange(dateRange: DateRangeFilter, now: Date = new Date()): number | undefined {
  const startOfToday = startOfLocalDay(now);
  switch (dateRange) {
    case 'today':
      return startOfToday.getTime();
    case 'last7Days':
      return new Date(startOfToday.getFullYear(), startOfToday.getMonth(), startOfToday.getDate() - 6).getTime();
    case 'last30Days':
      return new Date(startOfToday.getFullYear(), startOfToday.getMonth(), startOfToday.getDate() - 29).getTime();
    case 'all':
      return undefined;
  }
}

export function buildMeasurementFilter(
  selectedInstrumentIds: readonly string[],
  dateRange: DateRangeFilter,
  now: Date = new Date(),
): MeasurementFilter {
  const fromTimestamp = startTimestampForDateRange(dateRange, now);
  return {
    ...(selectedInstrumentIds.length > 0 ? { instrumentIds: [...selectedInstrumentIds] } : {}),
    ...(fromTimestamp !== undefined ? { fromTimestamp } : {}),
  };
}

export function matchesMeasurementFilter(
  measurement: Pick<Measurement, 'instrumentId' | 'timestamp'>,
  filter: MeasurementFilter,
): boolean {
  const matchesInstrument =
    !filter.instrumentIds || filter.instrumentIds.length === 0 || filter.instrumentIds.includes(measurement.instrumentId);
  const matchesDate = filter.fromTimestamp === undefined || measurement.timestamp >= filter.fromTimestamp;
  return matchesInstrument && matchesDate;
}

export interface SqlCondition {
  /** Empieza por `WHERE` o es una cadena vacía. */
  whereClause: string;
  parameters: (string | number)[];
}

/** Traduce el filtro a SQL sobre la tabla de mediciones con el alias dado. */
export function buildMeasurementFilterSql(filter: MeasurementFilter, tableAlias: string): SqlCondition {
  const conditions: string[] = [];
  const parameters: (string | number)[] = [];
  if (filter.instrumentIds && filter.instrumentIds.length > 0) {
    conditions.push(`${tableAlias}.instrument_id IN (${filter.instrumentIds.map(() => '?').join(', ')})`);
    parameters.push(...filter.instrumentIds);
  }
  if (filter.fromTimestamp !== undefined) {
    conditions.push(`${tableAlias}.timestamp >= ?`);
    parameters.push(filter.fromTimestamp);
  }
  return { whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', parameters };
}

/** Añade o quita un id de la selección (los chips de instrumento). */
export function toggleSelection(selectedIds: readonly string[], toggledId: string): string[] {
  return selectedIds.includes(toggledId)
    ? selectedIds.filter((selectedId) => selectedId !== toggledId)
    : [...selectedIds, toggledId];
}

export interface MeasurementDayGroup<TItem> {
  /** `AAAA-MM-DD` en hora local. */
  dayKey: string;
  items: TItem[];
}

export function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const monthText = String(date.getMonth() + 1).padStart(2, '0');
  const dayText = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${monthText}-${dayText}`;
}

/** Agrupa por día local conservando el orden de entrada (ya viene de la más reciente a la más antigua). */
export function groupByLocalDay<TItem extends { timestamp: number }>(items: readonly TItem[]): MeasurementDayGroup<TItem>[] {
  const dayGroups: MeasurementDayGroup<TItem>[] = [];
  for (const item of items) {
    const dayKey = localDayKey(item.timestamp);
    const lastDayGroup = dayGroups[dayGroups.length - 1];
    if (lastDayGroup && lastDayGroup.dayKey === dayKey) lastDayGroup.items.push(item);
    else dayGroups.push({ dayKey, items: [item] });
  }
  return dayGroups;
}

/** Ids de instrumento distintos, en orden de aparición. */
export function distinctInstrumentIds(measurements: readonly Pick<Measurement, 'instrumentId'>[]): string[] {
  return [...new Set(measurements.map((measurement) => measurement.instrumentId))];
}

export type DayListRow<TItem> = { rowKind: 'day'; dayKey: string } | { rowKind: 'item'; item: TItem };

/** Lista plana con una cabecera antes del primer elemento de cada día (para `FlatList`). */
export function buildDayListRows<TItem extends { timestamp: number }>(items: readonly TItem[]): DayListRow<TItem>[] {
  return groupByLocalDay(items).flatMap((dayGroup): DayListRow<TItem>[] => [
    { rowKind: 'day', dayKey: dayGroup.dayKey },
    ...dayGroup.items.map((item): DayListRow<TItem> => ({ rowKind: 'item', item })),
  ]);
}

/** Fecha local a partir de la clave `AAAA-MM-DD` (para mostrar la cabecera del día). */
export function dateFromLocalDayKey(dayKey: string): Date {
  const [yearText, monthText, dayText] = dayKey.split('-');
  return new Date(Number(yearText), Number(monthText) - 1, Number(dayText));
}
