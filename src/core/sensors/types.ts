export type SensorKind =
  | 'camera'
  | 'microphone'
  | 'accelerometer'
  | 'gyroscope'
  | 'magnetometer'
  | 'barometer'
  | 'light'
  | 'location'
  // radios que leen módulos nativos propios (solo Android)
  | 'bluetooth'
  | 'wifi'
  | 'gnss'
  // actuadores, pensando en la hoja de ruta (sonar, comunicación LED, pesaje por vibración)
  | 'speaker'
  | 'vibrator'
  | 'torch';

export const allSensorKinds: readonly SensorKind[] = [
  'camera',
  'microphone',
  'accelerometer',
  'gyroscope',
  'magnetometer',
  'barometer',
  'light',
  'location',
  'bluetooth',
  'wifi',
  'gnss',
  'speaker',
  'vibrator',
  'torch',
];

export type SensorAvailabilityStatus =
  | 'available'
  | 'unavailable'
  | 'permission-denied'
  | 'permission-undetermined';

export interface SensorAvailability {
  sensorKind: SensorKind;
  status: SensorAvailabilityStatus;
  /** Clave i18n (espacio de nombres del núcleo) con la explicación para el usuario. */
  reasonKey?: string;
  /** El sistema ya no volverá a mostrar el diálogo de permiso: hay que ir a los ajustes. */
  canAskAgain?: boolean;
}

export type SensorAvailabilityMap = Record<SensorKind, SensorAvailability>;

/**
 * Muestra con marca de tiempo monotónica (segundos desde el arranque del dispositivo),
 * común a todos los sensores para poder sincronizarlos entre sí.
 */
export interface TimedSample<TValue> {
  timestampSeconds: number;
  value: TValue;
}

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface SubscribeOptions {
  /** Frecuencia deseada; el sistema puede entregar otra. */
  targetRateHz?: number;
}

/** Fuente de datos que emite muestras al hilo JS (sensores de baja frecuencia). */
export interface SensorSource<TValue> {
  readonly sensorKind: SensorKind;
  /** Unidad de `value` en SI, para mostrar y exportar. */
  readonly unit: string;
  checkAvailability(): Promise<SensorAvailability>;
  requestPermission(): Promise<SensorAvailability>;
  /** Devuelve la función que cancela la suscripción. */
  subscribe(onSample: (sample: TimedSample<TValue>) => void, options?: SubscribeOptions): () => void;
}

/**
 * Sensores que no emiten muestras al hilo JS (cámara, micrófono, actuadores): el núcleo
 * solo gestiona disponibilidad y permisos; el instrumento accede al hardware directamente
 * desde worklets o módulos nativos.
 */
export interface SensorAccessController {
  readonly sensorKind: SensorKind;
  checkAvailability(): Promise<SensorAvailability>;
  requestPermission(): Promise<SensorAvailability>;
}
