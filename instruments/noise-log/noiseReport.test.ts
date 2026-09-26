import {
  buildMinuteChartSvg,
  buildNoiseReportHtml,
  escapeHtml,
  formatDuration,
  formatLocalDateTime,
  formatMinuteRowsCsv,
  type NoiseReportData,
} from './noiseReport';

const minuteStartTimestamp = new Date(2026, 8, 26, 23, 5).getTime();

const minuteRows = [
  { minuteStartTimestamp, equivalentLevelDecibels: 42.345, maximumLevelDecibels: 58.21, shortWindowCount: 480 },
  { minuteStartTimestamp: minuteStartTimestamp + 60_000, equivalentLevelDecibels: 47, maximumLevelDecibels: 66, shortWindowCount: 480 },
];

describe('formato de fechas y duraciones', () => {
  it('usa la hora local, sin depender del idioma', () => {
    expect(formatLocalDateTime(minuteStartTimestamp)).toBe('2026-09-26 23:05');
  });

  it('escribe duraciones legibles', () => {
    expect(formatDuration(35)).toBe('35 s');
    expect(formatDuration(260)).toBe('4 min 20 s');
    expect(formatDuration(3900)).toBe('1 h 05 min');
  });
});

describe('formatMinuteRowsCsv', () => {
  it('una fila por minuto con hora, Leq y máximo', () => {
    const csvLines = formatMinuteRowsCsv(minuteRows, 'dB(A)').trimEnd().split('\r\n');
    expect(csvLines[0]).toBe('local_time,timestamp_iso,leq_dB(A),max_dB(A),short_window_count');
    expect(csvLines[1]).toBe(`2026-09-26 23:05,${new Date(minuteStartTimestamp).toISOString()},42.3,58.2,480`);
    expect(csvLines).toHaveLength(3);
  });
});

describe('informe HTML', () => {
  const reportData: NoiseReportData = {
    sessionStartTimestamp: minuteStartTimestamp,
    sessionEndTimestamp: minuteStartTimestamp + 120_000,
    placeDescription: '<script>alert(1)</script> Dormitorio',
    summary: {
      equivalentLevelDecibels: 45,
      maximumLevelDecibels: 66,
      level10Decibels: 48,
      level90Decibels: 38,
      measuredSeconds: 120,
    },
    minuteRows,
    episodes: [
      { startTimestamp: minuteStartTimestamp + 65_000, durationSeconds: 12, maximumLevelDecibels: 66, equivalentLevelDecibels: 55 },
    ],
    thresholdDecibels: 45,
    minimumEpisodeDurationSeconds: 10,
    levelUnit: 'dB(A)',
    isCalibrated: true,
  };
  const echoTranslator = (translationKey: string) => `[${translationKey}]`;

  it('escapa el texto del usuario', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    const reportHtml = buildNoiseReportHtml(reportData, echoTranslator);
    expect(reportHtml).not.toContain('<script>');
    expect(reportHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Dormitorio');
  });

  it('incluye la advertencia, el resumen, los episodios y el detalle por minuto', () => {
    const reportHtml = buildNoiseReportHtml(reportData, echoTranslator);
    expect(reportHtml).toContain('[report.disclaimer]');
    expect(reportHtml).toContain('[report.calibrated]');
    expect(reportHtml).toContain('45.0 dB(A)');
    expect(reportHtml).toContain('2026-09-26 23:06:05');
    expect(reportHtml).toContain('12 s');
    expect(reportHtml).toContain('<svg');
    expect(reportHtml.match(/<tr>/g)?.length).toBeGreaterThanOrEqual(8 + 2 + 3);
  });

  it('sin episodios lo dice', () => {
    const reportHtml = buildNoiseReportHtml({ ...reportData, episodes: [], isCalibrated: false }, echoTranslator);
    expect(reportHtml).toContain('[episodes.none]');
    expect(reportHtml).toContain('[report.uncalibrated]');
  });

  it('la gráfica no se dibuja sin datos', () => {
    expect(buildMinuteChartSvg([], 45)).toBe('');
  });
});
