/**
 * Registro de detecciones para estudios: formato de cada fila, embedding compacto (float16) y
 * exportación a JSONL (con embeddings) y CSV (sin ellos). Sin React ni base de datos.
 */

/** Decimales de las coordenadas: 0,01° ≈ 1 km. Suficiente para estudios y no delata una casa. */
const coordinateDecimals = 2;
const scoreDecimals = 2;

export interface LoggedClassScore {
  label: string;
  score: number;
}

export interface DetectionRecord {
  id: number;
  /** Hora del final de la ventana, ISO 8601 con zona UTC. */
  detectedAtIso: string;
  durationSeconds: number;
  latitude: number | null;
  longitude: number | null;
  /** Especie que hizo que se apuntara la detección. */
  speciesLabel: string;
  speciesScore: number;
  topClasses: LoggedClassScore[];
  modelVersion: string;
  /** Embedding de 1536 valores en float16 little-endian. */
  embeddingFloat16Bytes: Uint8Array;
}

export type NewDetectionRecord = Omit<DetectionRecord, 'id'>;

export function roundCoordinate(coordinateDegrees: number): number {
  const factor = 10 ** coordinateDecimals;
  return Math.round(coordinateDegrees * factor) / factor;
}

export function roundScore(score: number): number {
  const factor = 10 ** scoreDecimals;
  return Math.round(score * factor) / factor;
}

// --- float16 (IEEE 754 binary16) ---

const float32View = new Float32Array(1);
const uint32View = new Uint32Array(float32View.buffer);

/** Convierte un float32 a los 16 bits de un float16, redondeando al par más cercano. */
export function float32ToFloat16Bits(value: number): number {
  float32View[0] = value;
  const bits = uint32View[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0); // infinito o NaN
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) return sign | 0x7c00; // desborda: infinito
  if (halfExponent <= 0) {
    // Subnormal en float16 (o cero).
    if (halfExponent < -10) return sign;
    mantissa |= 0x800000;
    const shift = 14 - halfExponent;
    let halfMantissa = mantissa >>> shift;
    const remainder = mantissa & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (remainder > halfway || (remainder === halfway && (halfMantissa & 1))) halfMantissa++;
    return sign | halfMantissa;
  }
  let halfBits = sign | (halfExponent << 10) | (mantissa >>> 13);
  const remainder = mantissa & 0x1fff;
  // Redondeo al par; el acarreo puede subir el exponente, y está bien.
  if (remainder > 0x1000 || (remainder === 0x1000 && (halfBits & 1))) halfBits++;
  return halfBits;
}

export function float16BitsToFloat32(halfBits: number): number {
  const sign = halfBits & 0x8000 ? -1 : 1;
  const exponent = (halfBits >>> 10) & 0x1f;
  const mantissa = halfBits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/** Embedding a bytes float16 little-endian (2 bytes por valor). */
export function encodeFloat16LittleEndian(values: ArrayLike<number>): Uint8Array {
  const encodedBytes = new Uint8Array(values.length * 2);
  for (let valueIndex = 0; valueIndex < values.length; valueIndex++) {
    const halfBits = float32ToFloat16Bits(values[valueIndex]!);
    encodedBytes[valueIndex * 2] = halfBits & 0xff;
    encodedBytes[valueIndex * 2 + 1] = halfBits >>> 8;
  }
  return encodedBytes;
}

export function decodeFloat16LittleEndian(encodedBytes: Uint8Array): Float32Array {
  const values = new Float32Array(encodedBytes.length >> 1);
  for (let valueIndex = 0; valueIndex < values.length; valueIndex++) {
    values[valueIndex] = float16BitsToFloat32(encodedBytes[valueIndex * 2]! | (encodedBytes[valueIndex * 2 + 1]! << 8));
  }
  return values;
}

// --- base64 (sin depender de btoa, que no está en todos los motores) ---

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  const outputParts: string[] = [];
  for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 3) {
    const firstByte = bytes[byteIndex]!;
    const secondByte = bytes[byteIndex + 1];
    const thirdByte = bytes[byteIndex + 2];
    const combinedBits = (firstByte << 16) | ((secondByte ?? 0) << 8) | (thirdByte ?? 0);
    outputParts.push(
      base64Alphabet[(combinedBits >>> 18) & 63]! +
        base64Alphabet[(combinedBits >>> 12) & 63]! +
        (secondByte === undefined ? '=' : base64Alphabet[(combinedBits >>> 6) & 63]!) +
        (thirdByte === undefined ? '=' : base64Alphabet[combinedBits & 63]!),
    );
  }
  return outputParts.join('');
}

// --- exportación ---

/** Cómo va codificado el embedding en el JSONL (va en cada línea, para que sea autoexplicativo). */
export const embeddingExportFormat = 'float16-le-base64';

/** Una línea JSON por detección, con el embedding. */
export function formatDetectionJsonLine(record: DetectionRecord): string {
  return JSON.stringify({
    detectedAt: record.detectedAtIso,
    durationSeconds: record.durationSeconds,
    latitude: record.latitude,
    longitude: record.longitude,
    species: record.speciesLabel,
    speciesScore: roundScore(record.speciesScore),
    top: record.topClasses.map((classScore) => ({ label: classScore.label, score: roundScore(classScore.score) })),
    modelVersion: record.modelVersion,
    embedding: {
      format: embeddingExportFormat,
      dimensions: record.embeddingFloat16Bytes.length / 2,
      data: bytesToBase64(record.embeddingFloat16Bytes),
    },
  });
}

export function formatDetectionsJsonLines(records: readonly DetectionRecord[]): string {
  return records.map(formatDetectionJsonLine).join('\n') + (records.length > 0 ? '\n' : '');
}

function csvField(fieldValue: string | number | null): string {
  if (fieldValue === null) return '';
  const fieldText = String(fieldValue);
  return /[",\n\r;]/.test(fieldText) ? `"${fieldText.replace(/"/g, '""')}"` : fieldText;
}

const csvTopCount = 5;

/**
 * CSV sin embeddings, para hojas de cálculo. `commonNameForLabel` añade el nombre común de la
 * especie en el idioma de la app.
 */
export function formatDetectionsCsv(
  records: readonly DetectionRecord[],
  commonNameForLabel: (label: string) => string,
): string {
  const headerFields = ['detected_at', 'duration_s', 'latitude', 'longitude', 'species', 'common_name', 'species_score'];
  for (let rankIndex = 1; rankIndex <= csvTopCount; rankIndex++) headerFields.push(`top${rankIndex}_label`, `top${rankIndex}_score`);
  headerFields.push('model_version');
  const csvLines = [headerFields.join(',')];
  for (const record of records) {
    const rowFields: (string | number | null)[] = [
      record.detectedAtIso,
      record.durationSeconds,
      record.latitude,
      record.longitude,
      record.speciesLabel,
      commonNameForLabel(record.speciesLabel),
      roundScore(record.speciesScore),
    ];
    for (let rankIndex = 0; rankIndex < csvTopCount; rankIndex++) {
      const classScore = record.topClasses[rankIndex];
      rowFields.push(classScore?.label ?? null, classScore ? roundScore(classScore.score) : null);
    }
    rowFields.push(record.modelVersion);
    csvLines.push(rowFields.map(csvField).join(','));
  }
  return csvLines.join('\n') + '\n';
}

// --- filas de la base de datos ---

export interface DetectionRow {
  id: number;
  detected_at: string;
  duration_seconds: number;
  latitude: number | null;
  longitude: number | null;
  species_label: string;
  species_score: number;
  top_classes_json: string;
  model_version: string;
  embedding: Uint8Array;
}

export function rowToDetectionRecord(detectionRow: DetectionRow): DetectionRecord {
  const parsedTopClasses: unknown = JSON.parse(detectionRow.top_classes_json);
  return {
    id: detectionRow.id,
    detectedAtIso: detectionRow.detected_at,
    durationSeconds: detectionRow.duration_seconds,
    latitude: detectionRow.latitude,
    longitude: detectionRow.longitude,
    speciesLabel: detectionRow.species_label,
    speciesScore: detectionRow.species_score,
    topClasses: Array.isArray(parsedTopClasses) ? (parsedTopClasses as LoggedClassScore[]) : [],
    modelVersion: detectionRow.model_version,
    embeddingFloat16Bytes: detectionRow.embedding,
  };
}
