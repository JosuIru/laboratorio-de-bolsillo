import type { MinuteLevelRow, NoiseEpisode, NoiseSessionSummary } from './noiseSession';

/** Traductor mínimo (el `t` de i18next) para que el informe salga en la lengua de la app. */
export type ReportTranslator = (translationKey: string, interpolationValues?: Record<string, unknown>) => string;

function padTwoDigits(numericValue: number): string {
  return String(numericValue).padStart(2, '0');
}

/** «2026-09-26 23:05» en hora local, independiente del idioma (legible y ordenable en una hoja). */
export function formatLocalDateTime(timestamp: number): string {
  const localDate = new Date(timestamp);
  return (
    `${localDate.getFullYear()}-${padTwoDigits(localDate.getMonth() + 1)}-${padTwoDigits(localDate.getDate())} ` +
    `${padTwoDigits(localDate.getHours())}:${padTwoDigits(localDate.getMinutes())}`
  );
}

/** «23:05:12» en hora local. */
export function formatLocalTime(timestamp: number): string {
  const localDate = new Date(timestamp);
  return `${padTwoDigits(localDate.getHours())}:${padTwoDigits(localDate.getMinutes())}:${padTwoDigits(localDate.getSeconds())}`;
}

/** «1 h 05 min», «4 min 20 s» o «35 s». */
export function formatDuration(totalSeconds: number): string {
  const roundedSeconds = Math.round(totalSeconds);
  const hours = Math.floor(roundedSeconds / 3600);
  const minutes = Math.floor((roundedSeconds % 3600) / 60);
  const seconds = roundedSeconds % 60;
  if (hours > 0) return `${hours} h ${padTwoDigits(minutes)} min`;
  if (minutes > 0) return `${minutes} min ${padTwoDigits(seconds)} s`;
  return `${seconds} s`;
}

export function formatLevel(levelDecibels: number): string {
  return levelDecibels.toFixed(1);
}

/**
 * CSV con una fila por minuto de reloj: hora local, Leq y máximo. Se separa con comas y el
 * decimal es punto, como el resto de exportaciones de la app.
 */
export function formatMinuteRowsCsv(minuteRows: readonly MinuteLevelRow[], levelUnit: string): string {
  const unitSuffix = levelUnit.replace(/[^\w()]+/g, '');
  const csvLines = [`local_time,timestamp_iso,leq_${unitSuffix},max_${unitSuffix},short_window_count`];
  for (const minuteRow of minuteRows) {
    csvLines.push(
      [
        formatLocalDateTime(minuteRow.minuteStartTimestamp),
        new Date(minuteRow.minuteStartTimestamp).toISOString(),
        formatLevel(minuteRow.equivalentLevelDecibels),
        formatLevel(minuteRow.maximumLevelDecibels),
        String(minuteRow.shortWindowCount),
      ].join(','),
    );
  }
  return csvLines.join('\r\n') + '\r\n';
}

export function escapeHtml(userText: string): string {
  return userText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface NoiseReportData {
  sessionStartTimestamp: number;
  sessionEndTimestamp: number;
  placeDescription: string;
  summary: NoiseSessionSummary;
  minuteRows: readonly MinuteLevelRow[];
  episodes: readonly NoiseEpisode[];
  thresholdDecibels: number;
  minimumEpisodeDurationSeconds: number;
  /** 'dB(A)' si hay calibración; si no, 'dBFS(A)'. */
  levelUnit: string;
  isCalibrated: boolean;
}

/** Gráfica SVG sencilla del Leq por minuto, con la línea del umbral. */
export function buildMinuteChartSvg(
  minuteRows: readonly MinuteLevelRow[],
  thresholdDecibels: number,
  chartWidth = 640,
  chartHeight = 200,
): string {
  if (minuteRows.length === 0) return '';
  const plottedLevels = minuteRows.map((minuteRow) => minuteRow.equivalentLevelDecibels);
  const lowestLevel = Math.floor(Math.min(...plottedLevels, thresholdDecibels) / 10) * 10 - 5;
  const highestLevel = Math.ceil(Math.max(...plottedLevels, thresholdDecibels) / 10) * 10 + 5;
  const horizontalStep = minuteRows.length > 1 ? chartWidth / (minuteRows.length - 1) : 0;
  const toVertical = (levelDecibels: number) =>
    (chartHeight * (highestLevel - levelDecibels)) / (highestLevel - lowestLevel);
  const linePoints = plottedLevels
    .map((levelDecibels, minuteIndex) => `${(minuteIndex * horizontalStep).toFixed(1)},${toVertical(levelDecibels).toFixed(1)}`)
    .join(' ');
  const thresholdVertical = toVertical(thresholdDecibels).toFixed(1);
  return (
    `<svg viewBox="-40 -10 ${chartWidth + 50} ${chartHeight + 20}" width="100%" role="img">` +
    `<line x1="0" y1="${thresholdVertical}" x2="${chartWidth}" y2="${thresholdVertical}" stroke="#B3261E" stroke-dasharray="6 4"/>` +
    `<polyline points="${linePoints}" fill="none" stroke="#0B6E99" stroke-width="2"/>` +
    `<text x="-6" y="8" text-anchor="end" font-size="12">${highestLevel}</text>` +
    `<text x="-6" y="${chartHeight}" text-anchor="end" font-size="12">${lowestLevel}</text>` +
    `</svg>`
  );
}

/** Informe HTML autocontenido (se abre en cualquier navegador y se puede imprimir a PDF). */
export function buildNoiseReportHtml(reportData: NoiseReportData, translate: ReportTranslator): string {
  const { summary, levelUnit } = reportData;
  const levelCell = (levelDecibels: number) => `${formatLevel(levelDecibels)} ${escapeHtml(levelUnit)}`;
  const summaryRows: [string, string][] = [
    [translate('report.start'), formatLocalDateTime(reportData.sessionStartTimestamp)],
    [translate('report.end'), formatLocalDateTime(reportData.sessionEndTimestamp)],
    [translate('report.duration'), formatDuration(summary.measuredSeconds)],
    [translate('summary.leq'), levelCell(summary.equivalentLevelDecibels)],
    [translate('summary.maximum'), levelCell(summary.maximumLevelDecibels)],
    [translate('summary.level10'), levelCell(summary.level10Decibels)],
    [translate('summary.level90'), levelCell(summary.level90Decibels)],
    [
      translate('report.episodeCriterion'),
      translate('report.episodeCriterionValue', {
        threshold: levelCell(reportData.thresholdDecibels),
        duration: formatDuration(reportData.minimumEpisodeDurationSeconds),
      }),
    ],
  ];
  const episodeRows = reportData.episodes
    .map(
      (episode) =>
        `<tr><td>${formatLocalDateTime(episode.startTimestamp)}:${padTwoDigits(new Date(episode.startTimestamp).getSeconds())}</td>` +
        `<td>${formatDuration(episode.durationSeconds)}</td><td>${levelCell(episode.equivalentLevelDecibels)}</td>` +
        `<td>${levelCell(episode.maximumLevelDecibels)}</td></tr>`,
    )
    .join('');
  const minuteRowsHtml = reportData.minuteRows
    .map(
      (minuteRow) =>
        `<tr><td>${formatLocalDateTime(minuteRow.minuteStartTimestamp)}</td><td>${levelCell(minuteRow.equivalentLevelDecibels)}</td>` +
        `<td>${levelCell(minuteRow.maximumLevelDecibels)}</td></tr>`,
    )
    .join('');
  const placeText = reportData.placeDescription.trim() || translate('report.placeUnknown');

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(translate('report.title'))}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#14171C;line-height:1.45}
h1{font-size:1.5em}h2{font-size:1.15em;margin-top:1.6em}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #DDE1E6;padding:4px 8px;text-align:left}
th{background:#F7F8FA}.warning{border-left:4px solid #B3261E;padding:8px 12px;background:#FDF3F2}
.note{color:#5B6470;font-size:.9em}
</style></head><body>
<h1>${escapeHtml(translate('report.title'))}</h1>
<p><strong>${escapeHtml(translate('report.place'))}:</strong> ${escapeHtml(placeText)}</p>
<p class="warning">${escapeHtml(translate('report.disclaimer'))}</p>
<p class="note">${escapeHtml(translate(reportData.isCalibrated ? 'report.calibrated' : 'report.uncalibrated'))}</p>
<p class="note">${escapeHtml(translate('report.method'))}</p>
<h2>${escapeHtml(translate('report.summary'))}</h2>
<table>${summaryRows.map(([rowLabel, rowValue]) => `<tr><th>${escapeHtml(rowLabel)}</th><td>${rowValue}</td></tr>`).join('')}</table>
<h2>${escapeHtml(translate('report.chart'))}</h2>
${buildMinuteChartSvg(reportData.minuteRows, reportData.thresholdDecibels)}
<h2>${escapeHtml(translate('report.episodes'))}</h2>
${
  reportData.episodes.length > 0
    ? `<table><tr><th>${escapeHtml(translate('episodes.start'))}</th><th>${escapeHtml(translate('episodes.duration'))}</th><th>Leq</th><th>${escapeHtml(translate('episodes.maximum'))}</th></tr>${episodeRows}</table>`
    : `<p>${escapeHtml(translate('episodes.none'))}</p>`
}
<h2>${escapeHtml(translate('report.minutes'))}</h2>
<table><tr><th>${escapeHtml(translate('report.minute'))}</th><th>Leq</th><th>${escapeHtml(translate('episodes.maximum'))}</th></tr>${minuteRowsHtml}</table>
<p class="note">${escapeHtml(translate('privacy'))}</p>
</body></html>
`;
}
