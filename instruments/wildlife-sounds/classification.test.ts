import {
  confidenceBarFraction,
  confidenceLevelFor,
  decideDetectionLogging,
  displayNameFor,
  topScoringClasses,
} from './classification';
import type { SoundClass } from './modelManifest';

const blackbird: SoundClass = {
  label: 'Turdus merula',
  kind: 'species',
  group: 'bird',
  names: { es: 'Mirlo común', eu: 'Zozoa', en: 'Common Blackbird' },
};
const thrushWithoutLocalNames: SoundClass = {
  label: 'Zoothera aurea',
  kind: 'species',
  group: 'bird',
  names: { es: null, eu: null, en: "White's Thrush" },
};
const speech: SoundClass = { label: 'Speech', kind: 'sound', names: { es: 'Habla', eu: 'Hizketa', en: 'Speech' }, isHumanVoice: true };
const wind: SoundClass = { label: 'Wind', kind: 'sound', names: { es: 'Viento', eu: 'Haizea', en: 'Wind' } };
const classes = [blackbird, thrushWithoutLocalNames, speech, wind];

describe('topScoringClasses', () => {
  it('devuelve las mejores ordenadas y descarta valores no finitos', () => {
    expect(topScoringClasses([1, 9, Number.NaN, 5, 7], 3)).toEqual([
      { classIndex: 1, score: 9 },
      { classIndex: 4, score: 7 },
      { classIndex: 3, score: 5 },
    ]);
    expect(topScoringClasses([2], 5)).toEqual([{ classIndex: 0, score: 2 }]);
  });
});

describe('confianza', () => {
  it('clasifica las puntuaciones en dudoso, posible y probable', () => {
    expect(confidenceLevelFor(5)).toBe('doubtful');
    expect(confidenceLevelFor(7)).toBe('possible');
    expect(confidenceLevelFor(12)).toBe('probable');
  });

  it('la barra va de 0 a 1 sin salirse', () => {
    expect(confidenceBarFraction(-10)).toBe(0);
    expect(confidenceBarFraction(9)).toBeCloseTo(0.5);
    expect(confidenceBarFraction(40)).toBe(1);
  });
});

describe('displayNameFor', () => {
  it('usa el idioma de la app y, si falta, los otros por orden', () => {
    expect(displayNameFor(blackbird, 'eu')).toBe('Zozoa');
    expect(displayNameFor(blackbird, 'es')).toBe('Mirlo común');
    expect(displayNameFor(thrushWithoutLocalNames, 'eu')).toBe("White's Thrush");
    expect(displayNameFor({ ...thrushWithoutLocalNames, names: { es: null, eu: null, en: null } }, 'es')).toBe(
      'Zoothera aurea',
    );
    expect(displayNameFor({ ...wind, label: 'Car_passing_by', names: { es: null, eu: null, en: null } }, 'es')).toBe(
      'Car passing by',
    );
  });
});

describe('decideDetectionLogging', () => {
  it('apunta la mejor especie que llega al umbral', () => {
    expect(
      decideDetectionLogging(
        [
          { classIndex: 3, score: 11 },
          { classIndex: 0, score: 9 },
        ],
        classes,
      ),
    ).toEqual({ kind: 'log', speciesClassIndex: 0, speciesScore: 9 });
  });

  it('no apunta nada si hay voz humana entre las tres primeras, aunque cante un mirlo', () => {
    expect(
      decideDetectionLogging(
        [
          { classIndex: 0, score: 12 },
          { classIndex: 2, score: 6 },
        ],
        classes,
      ),
    ).toEqual({ kind: 'human-voice' });
  });

  it('ignora una voz humana muy débil o fuera de las tres primeras', () => {
    const topWithDistantSpeech = [
      { classIndex: 0, score: 12 },
      { classIndex: 1, score: 8 },
      { classIndex: 3, score: 7 },
      { classIndex: 2, score: 6 },
    ];
    expect(decideDetectionLogging(topWithDistantSpeech, classes).kind).toBe('log');
    expect(
      decideDetectionLogging(
        [
          { classIndex: 0, score: 12 },
          { classIndex: 2, score: 1 },
        ],
        classes,
      ).kind,
    ).toBe('log');
  });

  it('no apunta sonidos generales ni especies dudosas', () => {
    expect(decideDetectionLogging([{ classIndex: 3, score: 14 }], classes)).toEqual({ kind: 'below-threshold' });
    expect(decideDetectionLogging([{ classIndex: 0, score: 5 }], classes)).toEqual({ kind: 'below-threshold' });
  });
});
