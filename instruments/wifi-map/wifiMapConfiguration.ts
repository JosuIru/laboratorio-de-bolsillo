export const wifiMapInstrumentId = 'wifi-map';

/** Cada cuánto se lee la conexión actual. */
export const connectionPollIntervalMilliseconds = 500;
/** Historia de RSSI de la gráfica. */
export const rssiChartDurationSeconds = 60;
export const rssiChartSampleCount = Math.round((rssiChartDurationSeconds * 1000) / connectionPollIntervalMilliseconds);
export const rssiChartRangeDbm = { minimum: -100, maximum: -30 } as const;

/**
 * Tiempo que se promedia en cada punto del mapa. Android refresca el RSSI de la conexión cada
 * pocos segundos, así que con menos de ~5 s solo se promediaría una o dos lecturas reales.
 */
export const pointAveragingDurationMilliseconds = 6000;

/** Rejilla del plano (celdas del editor de habitaciones). */
export const planGridColumnCount = 12;
export const planGridRowCount = 15;
/** Alto / ancho del plano. */
export const planAspectRatio = planGridRowCount / planGridColumnCount;

/** Resolución del mapa de calor (se escala al tamaño de la vista). */
export const heatmapColumnCount = 48;
export const heatmapRowCount = 60;

/** Tras pedir un escaneo, cuánto se espera a que Android tenga resultados. */
export const scanResultsWaitMilliseconds = 4000;
