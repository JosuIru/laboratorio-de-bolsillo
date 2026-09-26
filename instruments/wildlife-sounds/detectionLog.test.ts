import {
  bytesToBase64,
  decodeFloat16LittleEndian,
  type DetectionRecord,
  encodeFloat16LittleEndian,
  float16BitsToFloat32,
  float32ToFloat16Bits,
  formatDetectionsCsv,
  formatDetectionsJsonLines,
  roundCoordinate,
  rowToDetectionRecord,
} from './detectionLog';

describe('float16', () => {
  it('codifica valores conocidos como el estándar IEEE 754', () => {
    expect(float32ToFloat16Bits(1)).toBe(0x3c00);
    expect(float32ToFloat16Bits(-2)).toBe(0xc000);
    expect(float32ToFloat16Bits(0)).toBe(0);
    expect(float32ToFloat16Bits(65504)).toBe(0x7bff);
    expect(float32ToFloat16Bits(1e6)).toBe(0x7c00);
    expect(float32ToFloat16Bits(2 ** -24)).toBe(1);
    expect(Number.isNaN(float16BitsToFloat32(float32ToFloat16Bits(Number.NaN)))).toBe(true);
  });

  it('ida y vuelta con error relativo menor que 1/1000', () => {
    const originalValues = Float32Array.from({ length: 1536 }, (_, valueIndex) => Math.sin(valueIndex) * 3.7);
    const decodedValues = decodeFloat16LittleEndian(encodeFloat16LittleEndian(originalValues));
    expect(decodedValues).toHaveLength(1536);
    for (let valueIndex = 0; valueIndex < originalValues.length; valueIndex++) {
      const originalValue = originalValues[valueIndex]!;
      expect(Math.abs(decodedValues[valueIndex]! - originalValue)).toBeLessThanOrEqual(Math.abs(originalValue) / 1000 + 1e-4);
    }
  });

  it('guarda 2 bytes por valor, little-endian', () => {
    expect(Array.from(encodeFloat16LittleEndian([1, -2]))).toEqual([0x00, 0x3c, 0x00, 0xc0]);
  });
});

describe('bytesToBase64', () => {
  it('coincide con la codificación estándar, con relleno', () => {
    const encoder = (text: string) => bytesToBase64(Uint8Array.from(text, (character) => character.charCodeAt(0)));
    expect(encoder('')).toBe('');
    expect(encoder('f')).toBe('Zg==');
    expect(encoder('fo')).toBe('Zm8=');
    expect(encoder('foo')).toBe('Zm9v');
    expect(encoder('foobar')).toBe('Zm9vYmFy');
    expect(bytesToBase64(Uint8Array.from([255, 254, 253]))).toBe('//79');
  });
});

describe('roundCoordinate', () => {
  it('redondea a 0,01°', () => {
    expect(roundCoordinate(43.31834)).toBe(43.32);
    expect(roundCoordinate(-1.98123)).toBe(-1.98);
  });
});

const sampleRecord: DetectionRecord = {
  id: 7,
  detectedAtIso: '2026-09-26T06:30:05.000Z',
  durationSeconds: 5,
  latitude: 43.32,
  longitude: -1.98,
  speciesLabel: 'Turdus merula',
  speciesScore: 11.23456,
  topClasses: [
    { label: 'Turdus merula', score: 11.23456 },
    { label: 'Wind', score: 6.5 },
  ],
  modelVersion: 'europa-1',
  embeddingFloat16Bytes: encodeFloat16LittleEndian([1, -2]),
};

describe('exportación', () => {
  it('JSONL: una línea por detección con el embedding en base64', () => {
    const jsonLines = formatDetectionsJsonLines([sampleRecord, { ...sampleRecord, id: 8 }]);
    const lines = jsonLines.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const parsedLine = JSON.parse(lines[0]!);
    expect(parsedLine).toEqual({
      detectedAt: '2026-09-26T06:30:05.000Z',
      durationSeconds: 5,
      latitude: 43.32,
      longitude: -1.98,
      species: 'Turdus merula',
      speciesScore: 11.23,
      top: [
        { label: 'Turdus merula', score: 11.23 },
        { label: 'Wind', score: 6.5 },
      ],
      modelVersion: 'europa-1',
      embedding: { format: 'float16-le-base64', dimensions: 2, data: 'ADwAwA==' },
    });
    expect(formatDetectionsJsonLines([])).toBe('');
  });

  it('CSV: cabecera, nombre común, top 5 con huecos vacíos y sin embedding', () => {
    const csvText = formatDetectionsCsv([{ ...sampleRecord, latitude: null, longitude: null }], () => 'Mirlo, común');
    const [headerLine, firstRow] = csvText.trimEnd().split('\n');
    expect(headerLine).toBe(
      'detected_at,duration_s,latitude,longitude,species,common_name,species_score,' +
        'top1_label,top1_score,top2_label,top2_score,top3_label,top3_score,top4_label,top4_score,top5_label,top5_score,' +
        'model_version',
    );
    expect(firstRow).toBe(
      '2026-09-26T06:30:05.000Z,5,,,Turdus merula,"Mirlo, común",11.23,Turdus merula,11.23,Wind,6.5,,,,,,,europa-1',
    );
  });
});

describe('rowToDetectionRecord', () => {
  it('convierte una fila de la base de datos', () => {
    const detectionRecord = rowToDetectionRecord({
      id: 3,
      detected_at: sampleRecord.detectedAtIso,
      duration_seconds: 5,
      latitude: null,
      longitude: null,
      species_label: 'Turdus merula',
      species_score: 11.2,
      top_classes_json: JSON.stringify(sampleRecord.topClasses),
      model_version: 'europa-1',
      embedding: sampleRecord.embeddingFloat16Bytes,
    });
    expect(detectionRecord.topClasses).toEqual(sampleRecord.topClasses);
    expect(detectionRecord.latitude).toBeNull();
    expect(detectionRecord.id).toBe(3);
  });
});
