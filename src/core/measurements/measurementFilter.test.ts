import {
  buildDayListRows,
  buildMeasurementFilter,
  buildMeasurementFilterSql,
  dateFromLocalDayKey,
  distinctInstrumentIds,
  groupByLocalDay,
  localDayKey,
  matchesMeasurementFilter,
  startTimestampForDateRange,
  toggleSelection,
} from './measurementFilter';

// 26 de septiembre de 2026, 15:30 en hora local.
const referenceNow = new Date(2026, 8, 26, 15, 30, 0);

describe('intervalos de fechas', () => {
  it('«hoy» empieza a medianoche local', () => {
    expect(startTimestampForDateRange('today', referenceNow)).toBe(new Date(2026, 8, 26).getTime());
  });

  it('«7 días» incluye hoy y los seis días anteriores', () => {
    expect(startTimestampForDateRange('last7Days', referenceNow)).toBe(new Date(2026, 8, 20).getTime());
  });

  it('«30 días» cruza el cambio de mes', () => {
    expect(startTimestampForDateRange('last30Days', referenceNow)).toBe(new Date(2026, 7, 28).getTime());
  });

  it('«todo» no tiene límite', () => {
    expect(startTimestampForDateRange('all', referenceNow)).toBeUndefined();
  });
});

describe('filtro de mediciones', () => {
  it('sin instrumentos ni fechas no filtra nada', () => {
    expect(buildMeasurementFilter([], 'all', referenceNow)).toEqual({});
  });

  it('combina instrumentos y fecha', () => {
    const filter = buildMeasurementFilter(['moon', 'seismograph'], 'today', referenceNow);
    expect(filter).toEqual({ instrumentIds: ['moon', 'seismograph'], fromTimestamp: new Date(2026, 8, 26).getTime() });
    expect(matchesMeasurementFilter({ instrumentId: 'moon', timestamp: referenceNow.getTime() }, filter)).toBe(true);
    expect(matchesMeasurementFilter({ instrumentId: 'tuner', timestamp: referenceNow.getTime() }, filter)).toBe(false);
    expect(matchesMeasurementFilter({ instrumentId: 'moon', timestamp: new Date(2026, 8, 25, 23).getTime() }, filter)).toBe(
      false,
    );
  });

  it('genera SQL con parámetros en el mismo orden que los marcadores', () => {
    expect(buildMeasurementFilterSql({}, 'm')).toEqual({ whereClause: '', parameters: [] });
    expect(buildMeasurementFilterSql({ instrumentIds: ['moon', 'sonar'], fromTimestamp: 1000 }, 'm')).toEqual({
      whereClause: 'WHERE m.instrument_id IN (?, ?) AND m.timestamp >= ?',
      parameters: ['moon', 'sonar', 1000],
    });
    expect(buildMeasurementFilterSql({ instrumentIds: [] }, 'm').whereClause).toBe('');
  });

  it('los chips añaden o quitan instrumentos', () => {
    expect(toggleSelection([], 'moon')).toEqual(['moon']);
    expect(toggleSelection(['moon', 'sonar'], 'moon')).toEqual(['sonar']);
  });

  it('lista los instrumentos distintos en orden de aparición', () => {
    expect(
      distinctInstrumentIds([{ instrumentId: 'b' }, { instrumentId: 'a' }, { instrumentId: 'b' }]),
    ).toEqual(['b', 'a']);
  });
});

describe('agrupación por días', () => {
  const items = [
    { id: 'm1', timestamp: new Date(2026, 8, 26, 10).getTime() },
    { id: 'm2', timestamp: new Date(2026, 8, 26, 0, 5).getTime() },
    { id: 'm3', timestamp: new Date(2026, 8, 25, 23, 59).getTime() },
    { id: 'm4', timestamp: new Date(2026, 7, 1, 12).getTime() },
  ];

  it('la clave del día usa la fecha local con ceros', () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05');
    expect(dateFromLocalDayKey('2026-01-05').getTime()).toBe(new Date(2026, 0, 5).getTime());
  });

  it('agrupa mediciones consecutivas del mismo día', () => {
    expect(groupByLocalDay(items).map((dayGroup) => [dayGroup.dayKey, dayGroup.items.map((item) => item.id)])).toEqual([
      ['2026-09-26', ['m1', 'm2']],
      ['2026-09-25', ['m3']],
      ['2026-08-01', ['m4']],
    ]);
  });

  it('intercala una cabecera antes de cada día', () => {
    const rowSummaries = buildDayListRows(items).map((listRow) =>
      listRow.rowKind === 'day' ? `día ${listRow.dayKey}` : listRow.item.id,
    );
    expect(rowSummaries).toEqual(['día 2026-09-26', 'm1', 'm2', 'día 2026-09-25', 'm3', 'día 2026-08-01', 'm4']);
  });

  it('una lista vacía no tiene filas', () => {
    expect(buildDayListRows([])).toEqual([]);
  });
});
