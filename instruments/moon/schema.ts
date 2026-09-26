import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface MoonMeasurementValues {
  phaseName: string;
  illuminatedPercent: number;
  ageDays: number;
  distanceKilometers: number;
  apparentDiameterArcminutes: number;
  moonAltitudeDegrees?: number;
  moonAzimuthDegrees?: number;
  capturedFrameCount: number;
  stackedFrameCount: number;
  moonDiameterPixels: number;
  zoomFactor: number;
  exposureBias?: number;
  /** Android: compensación en pasos del móvil (su tamaño en EV depende del modelo). */
  exposureCompensationSteps?: number;
  /** Con exposición manual: tiempo de exposición e ISO fijos. */
  exposureMilliseconds?: number;
  iso?: number;
  sharpeningAmount?: number;
  /** Foto tomada a través del ocular de unos prismáticos o un telescopio. */
  throughOptics?: boolean;
  /** Técnica: 'photoBurst', 'luckyImaging', 'driftSuperResolution' o 'earthshine'. */
  captureTechnique?: string;
  /** Luz cenicienta: relación entre la exposición larga y la corta. */
  exposureRatio?: number;
  /** Procesado aplicado al resultado guardado. */
  colorCorrected?: boolean;
  deconvolutionIterations?: number;
  mineralSaturationGain?: number;
  /** Ráfaga RAW (DNG), apilado monocromo del canal verde. */
  rawCapture?: boolean;
  /** Posición del objetivo elegida con «Afinar el enfoque» (0 = cerca, 1 = lejos). */
  focusLensPosition?: number;
  /** 'lockedDaylight' si se fijó el balance a luz de día; si no, 'automatic'. */
  whiteBalanceMode?: string;
  /** Experimento: 'apparentSize', 'earthAlbedo' u 'occultation'. */
  experiment?: string;
  /** Tamaño: diámetro medido en la escala común (px a zoom ×1 en JPEG, px del sensor en RAW). */
  measuredDiameterPixels?: number;
  diameterUncertaintyPixels?: number;
  /** 'jpeg' o 'raw'. */
  sizeScaleSource?: string;
  predictedDiameterArcminutes?: number;
  /** Albedo: razón de brillos luz cenicienta / Sol por unidad de exposición y su error relativo. */
  earthshineRatio?: number;
  earthshineRatioRelativeUncertainty?: number;
  lunarPhaseAngleDegrees?: number;
  earthAlbedo?: number;
  earthAlbedoLower?: number;
  earthAlbedoUpper?: number;
  /** Ocultación: instante (UTC según el reloj del móvil) y su incertidumbre estadística. */
  occultationEventUtc?: string;
  occultationUncertaintyMilliseconds?: number;
  /** 'disappearance' o 'reappearance'. */
  occultationEventType?: string;
  occultationSignificance?: number;
  /** Desfase del reloj del móvil (servidor − móvil), si se midió. */
  clockOffsetMilliseconds?: number;
}

export const moonSchema = defineMeasurementSchema<MoonMeasurementValues>(1, [
  { key: 'phaseName', labelKey: 'fields.phaseName', type: 'string' },
  { key: 'illuminatedPercent', labelKey: 'fields.illuminatedPercent', type: 'number', unit: '%' },
  { key: 'ageDays', labelKey: 'fields.ageDays', type: 'number', unit: 'd' },
  { key: 'distanceKilometers', labelKey: 'fields.distance', type: 'number', unit: 'km' },
  { key: 'apparentDiameterArcminutes', labelKey: 'fields.apparentDiameter', type: 'number', unit: '′' },
  { key: 'moonAltitudeDegrees', labelKey: 'fields.altitude', type: 'number', unit: '°', optional: true },
  { key: 'moonAzimuthDegrees', labelKey: 'fields.azimuth', type: 'number', unit: '°', optional: true },
  { key: 'capturedFrameCount', labelKey: 'fields.capturedFrameCount', type: 'number' },
  { key: 'stackedFrameCount', labelKey: 'fields.stackedFrameCount', type: 'number' },
  { key: 'moonDiameterPixels', labelKey: 'fields.moonDiameterPixels', type: 'number', unit: 'px' },
  { key: 'zoomFactor', labelKey: 'fields.zoomFactor', type: 'number', unit: '×' },
  { key: 'exposureBias', labelKey: 'fields.exposureBias', type: 'number', unit: 'EV', optional: true },
  {
    key: 'exposureCompensationSteps',
    labelKey: 'fields.exposureCompensationSteps',
    type: 'number',
    optional: true,
  },
  { key: 'exposureMilliseconds', labelKey: 'fields.exposureMilliseconds', type: 'number', unit: 'ms', optional: true },
  { key: 'iso', labelKey: 'fields.iso', type: 'number', optional: true },
  { key: 'sharpeningAmount', labelKey: 'fields.sharpeningAmount', type: 'number', optional: true },
  { key: 'throughOptics', labelKey: 'fields.throughOptics', type: 'boolean', optional: true },
  { key: 'captureTechnique', labelKey: 'fields.captureTechnique', type: 'string', optional: true },
  { key: 'exposureRatio', labelKey: 'fields.exposureRatio', type: 'number', unit: '×', optional: true },
  { key: 'colorCorrected', labelKey: 'fields.colorCorrected', type: 'boolean', optional: true },
  { key: 'deconvolutionIterations', labelKey: 'fields.deconvolutionIterations', type: 'number', optional: true },
  { key: 'mineralSaturationGain', labelKey: 'fields.mineralSaturationGain', type: 'number', unit: '×', optional: true },
  { key: 'rawCapture', labelKey: 'fields.rawCapture', type: 'boolean', optional: true },
  { key: 'focusLensPosition', labelKey: 'fields.focusLensPosition', type: 'number', optional: true },
  { key: 'whiteBalanceMode', labelKey: 'fields.whiteBalanceMode', type: 'string', optional: true },
  { key: 'experiment', labelKey: 'fields.experiment', type: 'string', optional: true },
  { key: 'measuredDiameterPixels', labelKey: 'fields.measuredDiameterPixels', type: 'number', unit: 'px', optional: true },
  { key: 'diameterUncertaintyPixels', labelKey: 'fields.diameterUncertaintyPixels', type: 'number', unit: 'px', optional: true },
  { key: 'sizeScaleSource', labelKey: 'fields.sizeScaleSource', type: 'string', optional: true },
  { key: 'predictedDiameterArcminutes', labelKey: 'fields.predictedDiameterArcminutes', type: 'number', unit: '′', optional: true },
  { key: 'earthshineRatio', labelKey: 'fields.earthshineRatio', type: 'number', optional: true },
  { key: 'earthshineRatioRelativeUncertainty', labelKey: 'fields.earthshineRatioRelativeUncertainty', type: 'number', optional: true },
  { key: 'lunarPhaseAngleDegrees', labelKey: 'fields.lunarPhaseAngleDegrees', type: 'number', unit: '°', optional: true },
  { key: 'earthAlbedo', labelKey: 'fields.earthAlbedo', type: 'number', optional: true },
  { key: 'earthAlbedoLower', labelKey: 'fields.earthAlbedoLower', type: 'number', optional: true },
  { key: 'earthAlbedoUpper', labelKey: 'fields.earthAlbedoUpper', type: 'number', optional: true },
  { key: 'occultationEventUtc', labelKey: 'fields.occultationEventUtc', type: 'string', optional: true },
  { key: 'occultationUncertaintyMilliseconds', labelKey: 'fields.occultationUncertaintyMilliseconds', type: 'number', unit: 'ms', optional: true },
  { key: 'occultationEventType', labelKey: 'fields.occultationEventType', type: 'string', optional: true },
  { key: 'occultationSignificance', labelKey: 'fields.occultationSignificance', type: 'number', optional: true },
  { key: 'clockOffsetMilliseconds', labelKey: 'fields.clockOffsetMilliseconds', type: 'number', unit: 'ms', optional: true },
]);
