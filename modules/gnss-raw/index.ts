import { type NativeModule, requireOptionalNativeModule } from 'expo';

/**
 * Módulo nativo local (solo Android) con el estado GNSS en crudo. En iOS y en Expo Go no
 * existe: `gnssRawModule` es `null` y el instrumento lo explica en pantalla.
 */

export interface GnssRawCapabilities {
  androidApiLevel: number;
  hasGnssHardware: boolean;
  isLocationEnabled: boolean;
  hasFineLocationPermission: boolean;
  gnssHardwareModelName: string | null;
  /** 0 si el chip no lo dice. */
  gnssYearOfHardware: number;
  /** `null` antes de Android 12: no se sabe hasta registrarse. */
  hasRawMeasurements: boolean | null;
  /** Android 14+: AGC por banda en cada época de medidas. */
  hasPerBandAutomaticGainControl: boolean;
}

export interface GnssRawSatellite {
  constellationType: number;
  svid: number;
  cn0DbHz: number;
  basebandCn0DbHz: number | null;
  elevationDegrees: number;
  azimuthDegrees: number;
  usedInFix: boolean;
  hasAlmanac: boolean;
  hasEphemeris: boolean;
  carrierFrequencyHz: number | null;
}

export interface GnssSatelliteStatusEvent {
  /** Segundos desde el arranque (monotónico). */
  elapsedRealtimeSeconds: number;
  satellites: GnssRawSatellite[];
}

export interface GnssRawMeasurement {
  constellationType: number;
  svid: number;
  cn0DbHz: number;
  carrierFrequencyHz: number | null;
  state: number;
  receivedSvTimeNanos: number;
  receivedSvTimeUncertaintyNanos: number;
  timeOffsetNanos: number;
  pseudorangeRateMetersPerSecond: number;
  multipathIndicator: number;
  automaticGainControlLevelDb: number | null;
}

export interface GnssRawAutomaticGainControl {
  constellationType: number;
  carrierFrequencyHz: number;
  levelDb: number;
}

export interface GnssRawMeasurementsEvent {
  elapsedRealtimeSeconds: number;
  receiverTimeOfWeekNanos: number | null;
  hardwareClockDiscontinuityCount: number;
  measurements: GnssRawMeasurement[];
  automaticGainControls: GnssRawAutomaticGainControl[];
}

export type GnssRawMeasurementsStatus = 'ready' | 'notSupported' | 'locationDisabled' | 'notAllowed' | 'unknown';

export interface GnssEngineStateEvent {
  state: 'started' | 'stopped' | 'firstFix';
  timeToFirstFixMilliseconds?: number;
}

export interface GnssLocationFixEvent {
  elapsedRealtimeSeconds: number;
  horizontalAccuracyMeters: number | null;
}

type GnssRawEvents = {
  onSatelliteStatus(event: GnssSatelliteStatusEvent): void;
  onRawMeasurements(event: GnssRawMeasurementsEvent): void;
  onRawMeasurementsStatus(event: { status: GnssRawMeasurementsStatus }): void;
  onEngineState(event: GnssEngineStateEvent): void;
  onLocationFix(event: GnssLocationFixEvent): void;
};

declare class GnssRawNativeModule extends NativeModule<GnssRawEvents> {
  getCapabilities(): GnssRawCapabilities;
  /** Lanza `ERR_GNSS_PERMISSION` sin ubicación precisa. */
  start(): void;
  stop(): void;
}

export const gnssRawModule = requireOptionalNativeModule<GnssRawNativeModule>('GnssRaw');
