import type { MeasurementFieldDescriptor } from '@/core/measurements/schema';
import type { Measurement } from '@/core/measurements/types';

import { buildExportFileName, escapeCsvCell, measurementsToCsv, measurementsToJson } from './formatMeasurements';

const exampleFields: MeasurementFieldDescriptor[] = [
  { key: 'dominantFrequencyHz', labelKey: 'f', type: 'number', unit: 'Hz' },
  { key: 'label', labelKey: 'l', type: 'string' },
  { key: 'spectrum', labelKey: 's', type: 'numberArray' },
];

const exampleMeasurements: Measurement[] = [
  {
    id: 'm1',
    instrumentId: 'audio-spectrum',
    schemaVersion: 1,
    timestamp: Date.UTC(2026, 8, 25, 16, 30, 0),
    location: { latitude: 43.263, longitude: -2.935 },
    values: { dominantFrequencyHz: 440.5, label: 'Diapasón, "La"', spectrum: [0.1, 0.2] },
    attachments: [
      { id: 'a1', kind: 'audio', fileUri: 'file:///private/a.wav', fileName: 'a.wav', mimeType: 'audio/wav' },
    ],
    note: '=HYPERLINK("http://malicioso")',
  },
  {
    id: 'm2',
    instrumentId: 'audio-spectrum',
    schemaVersion: 1,
    timestamp: Date.UTC(2026, 8, 25, 16, 31, 0),
    values: { dominantFrequencyHz: -1, label: 'Línea 1\nLínea 2', spectrum: [] },
    attachments: [],
  },
];

describe('escapeCsvCell', () => {
  it.each([
    ['simple', 'simple'],
    ['con,coma', '"con,coma"'],
    ['con "comillas"', '"con ""comillas"""'],
    ['multi\nlínea', '"multi\nlínea"'],
    [' espacios ', '" espacios "'],
  ])('%j → %j', (rawCellText, expectedCell) => {
    expect(escapeCsvCell(rawCellText)).toBe(expectedCell);
  });
});

describe('measurementsToCsv', () => {
  const csvText = measurementsToCsv(exampleMeasurements, { fields: exampleFields });
  const csvLines = csvText.replace(/^﻿/, '').split('\r\n');

  it('empieza con BOM UTF-8 y termina con salto de línea', () => {
    expect(csvText.startsWith('﻿')).toBe(true);
    expect(csvText.endsWith('\r\n')).toBe(true);
  });

  it('pone la unidad en la cabecera de cada campo', () => {
    expect(csvLines[0]).toBe(
      'id,timestamp_iso,schema_version,latitude,longitude,altitude_m,location_accuracy_m,' +
        'calibration_profile_id,note,attachments,dominantFrequencyHz [Hz],label,spectrum',
    );
  });

  it('escribe los valores, escapa comillas y neutraliza fórmulas en textos del usuario', () => {
    expect(csvLines[1]).toBe(
      'm1,2026-09-25T16:30:00.000Z,1,43.263,-2.935,,,,' +
        `"'=HYPERLINK(""http://malicioso"")",a.wav,440.5,"Diapasón, ""La""","[0.1,0.2]"`,
    );
  });

  it('no altera números negativos y mantiene los saltos de línea dentro de comillas', () => {
    expect(csvText).toContain(',-1,"Línea 1\nLínea 2",[]\r\n');
  });

  it('puede omitir el BOM', () => {
    expect(measurementsToCsv([], { fields: [] }, { includeByteOrderMark: false }).startsWith('id,')).toBe(true);
  });
});

describe('measurementsToJson', () => {
  const exportDocument = JSON.parse(
    measurementsToJson(exampleMeasurements, 'audio-spectrum', { fields: exampleFields, version: 1 }, new Date(0)),
  );

  it('incluye metadatos del formato y del instrumento', () => {
    expect(exportDocument.format).toBe('laboratorio-de-bolsillo/measurements');
    expect(exportDocument.exportedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(exportDocument.instrument.id).toBe('audio-spectrum');
    expect(exportDocument.instrument.fields).toHaveLength(3);
  });

  it('no filtra rutas locales de los adjuntos', () => {
    expect(exportDocument.measurements[0].attachments[0]).toEqual({
      id: 'a1',
      kind: 'audio',
      fileName: 'a.wav',
      mimeType: 'audio/wav',
    });
    expect(JSON.stringify(exportDocument)).not.toContain('file:///');
  });
});

describe('buildExportFileName', () => {
  it('genera un nombre sin caracteres problemáticos', () => {
    expect(buildExportFileName('seismograph', 'csv', new Date(Date.UTC(2026, 8, 25, 18, 30, 5)))).toBe(
      'seismograph-2026-09-25T18-30-05.csv',
    );
  });
});
