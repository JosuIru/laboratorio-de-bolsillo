import {
  buildImageAttachmentSqlCondition,
  collectMeasurementImages,
  isImageAttachment,
  partitionAttachments,
} from './imageAttachments';
import type { Attachment, Measurement } from './types';

function buildAttachment(attachmentId: string, fileName: string, mimeType: string): Attachment {
  return { id: attachmentId, kind: 'photo', fileUri: `file:///documents/${fileName}`, fileName, mimeType };
}

describe('detección de adjuntos de imagen', () => {
  it.each([
    ['image/png', 'captura.png', true],
    ['image/jpeg', 'foto.jpg', true],
    ['IMAGE/WEBP', 'foto.webp', true],
    ['image/svg+xml', 'dibujo.svg', false],
    ['text/csv', 'serie.csv', false],
    ['text/csv', 'engañoso.png', false],
    ['application/octet-stream', 'sin-tipo.JPEG', true],
    ['', 'vacio.heic', true],
    ['application/octet-stream', 'serie.bin', false],
    ['audio/wav', 'sonido.wav', false],
  ])('%s + %s → %s', (mimeType, fileName, expectedIsImage) => {
    expect(isImageAttachment({ mimeType, fileName })).toBe(expectedIsImage);
  });

  it('separa imágenes y demás adjuntos conservando el orden', () => {
    const attachments = [
      buildAttachment('a1', 'uno.png', 'image/png'),
      buildAttachment('a2', 'datos.csv', 'text/csv'),
      buildAttachment('a3', 'dos.jpg', 'image/jpeg'),
    ];
    const { imageAttachments, otherAttachments } = partitionAttachments(attachments);
    expect(imageAttachments.map((attachment) => attachment.id)).toEqual(['a1', 'a3']);
    expect(otherAttachments.map((attachment) => attachment.id)).toEqual(['a2']);
  });

  it('reúne las imágenes de varias mediciones con su instrumento y fecha', () => {
    const measurements: Measurement[] = [
      {
        id: 'm1',
        instrumentId: 'moon',
        schemaVersion: 1,
        timestamp: 200,
        values: {},
        attachments: [buildAttachment('a1', 'luna.png', 'image/png'), buildAttachment('a2', 'x.csv', 'text/csv')],
      },
      { id: 'm2', instrumentId: 'seismograph', schemaVersion: 1, timestamp: 100, values: {}, attachments: [] },
      {
        id: 'm3',
        instrumentId: 'superzoom',
        schemaVersion: 1,
        timestamp: 50,
        values: {},
        attachments: [buildAttachment('a3', 'zoom.png', 'image/png')],
      },
    ];
    expect(collectMeasurementImages(measurements)).toEqual([
      { attachment: measurements[0]!.attachments[0], measurementId: 'm1', instrumentId: 'moon', timestamp: 200 },
      { attachment: measurements[2]!.attachments[0], measurementId: 'm3', instrumentId: 'superzoom', timestamp: 50 },
    ]);
  });

  it('la condición SQL usa el alias y cubre tipo MIME y extensiones', () => {
    const sqlCondition = buildImageAttachmentSqlCondition('a');
    expect(sqlCondition).toContain("lower(a.mime_type) LIKE 'image/%'");
    expect(sqlCondition).toContain("<> 'image/svg+xml'");
    expect(sqlCondition).toContain("lower(a.file_name) LIKE '%.png'");
    expect(sqlCondition).toContain("lower(a.file_name) LIKE '%.jpeg'");
    // Sin parámetros: se puede concatenar sin desordenar los `?` del resto de la consulta.
    expect(sqlCondition).not.toContain('?');
  });
});
