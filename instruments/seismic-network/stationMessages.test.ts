import { buildStationCodeLine, formatDecimal, parseStationMessages } from './stationMessages';

describe('mensajes de estación', () => {
  it('ida y vuelta: lo que comparte una estación lo lee la central', () => {
    const stationReading = { stationName: 'Mesa 3', xMeters: 1.5, yMeters: -0.25, arrivalSeconds: 12.34567 };
    const sharedText = `Estación Mesa 3: llegada 12,346 s\n${buildStationCodeLine(stationReading)}`;
    expect(parseStationMessages(sharedText)).toEqual([stationReading]);
  });

  it('lee varios mensajes pegados de un chat y se queda con el último de cada nombre', () => {
    const pastedChat = [
      '[10:01] Ane: #sismo|A|0.000|0.000|3.10000',
      '[10:01] Jon: #sismo|B|3.000|0.000|3.11000',
      'texto que no es de ninguna estación',
      '[10:02] Ane: #sismo|A|0.000|0.000|3.10500',
      '#sismo|C|0,5|1|3,2',
    ].join('\n');
    expect(parseStationMessages(pastedChat)).toEqual([
      { stationName: 'A', xMeters: 0, yMeters: 0, arrivalSeconds: 3.105 },
      { stationName: 'B', xMeters: 3, yMeters: 0, arrivalSeconds: 3.11 },
      { stationName: 'C', xMeters: 0.5, yMeters: 1, arrivalSeconds: 3.2 },
    ]);
  });

  it('limpia nombres con separadores y descarta números rotos', () => {
    expect(buildStationCodeLine({ stationName: 'a|b', xMeters: 0, yMeters: 0, arrivalSeconds: 1 })).toBe(
      '#sismo|a b|0.000|0.000|1.00000',
    );
    expect(parseStationMessages('#sismo|X|1..2|0|1')).toEqual([]);
  });

  it('formatea con coma decimal', () => {
    expect(formatDecimal(3.14159, 3)).toBe('3,142');
  });
});
