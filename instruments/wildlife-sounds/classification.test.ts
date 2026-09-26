import {
  confidenceBarFraction,
  confidenceLevelFor,
  decideDetectionLogging,
  displayNameFor,
  relativeMarginScore,
  selectDisplayedResults,
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

  it('apunta la mejor especie aunque haya otras dentro del margen', () => {
    expect(
      decideDetectionLogging(
        [
          { classIndex: 0, score: 9 },
          { classIndex: 1, score: 8 },
        ],
        classes,
      ),
    ).toEqual({ kind: 'log', speciesClassIndex: 0, speciesScore: 9 });
  });

  it('no apunta sonidos generales ni especies dudosas', () => {
    expect(decideDetectionLogging([{ classIndex: 3, score: 14 }], classes)).toEqual({ kind: 'below-threshold' });
    expect(decideDetectionLogging([{ classIndex: 0, score: 5 }], classes)).toEqual({ kind: 'below-threshold' });
  });
});

describe('selectDisplayedResults', () => {
  const robin: SoundClass = { label: 'Erithacus rubecula', kind: 'species', names: { es: null, eu: null, en: null } };
  const wren: SoundClass = { label: 'Troglodytes troglodytes', kind: 'species', names: { es: null, eu: null, en: null } };
  const car: SoundClass = { label: 'Car', kind: 'sound', names: { es: null, eu: null, en: null } };
  // 0 mirlo, 1 petirrojo, 2 chochín, 3 viento, 4 coche
  const displayClasses = [blackbird, robin, wren, wind, car];
  const indicesOf = (rankedClasses: readonly { classIndex: number }[]) => rankedClasses.map((rankedClass) => rankedClass.classIndex);

  it('con una primera muy clara no muestra acompañantes lejanas', () => {
    const displayedResults = selectDisplayedResults(
      [
        { classIndex: 0, score: 14 },
        { classIndex: 1, score: 9 },
        { classIndex: 2, score: 7.5 },
      ],
      displayClasses,
    );
    expect(indicesOf(displayedResults.shownSpecies)).toEqual([0]);
    expect(indicesOf(displayedResults.doubtfulSpecies)).toEqual([1, 2]);
  });

  it('muestra las especies cercanas a la primera que llegan a «posible»', () => {
    const displayedResults = selectDisplayedResults(
      [
        { classIndex: 0, score: 11 },
        { classIndex: 1, score: 11 - relativeMarginScore + 0.5 },
        { classIndex: 2, score: 11 - relativeMarginScore },
      ],
      displayClasses,
    );
    expect(indicesOf(displayedResults.shownSpecies)).toEqual([0, 1]);
    expect(indicesOf(displayedResults.doubtfulSpecies)).toEqual([2]);
  });

  it('oculta lo dudoso aunque esté cerca de la primera', () => {
    const displayedResults = selectDisplayedResults(
      [
        { classIndex: 0, score: 6.5 },
        { classIndex: 1, score: 6 },
      ],
      displayClasses,
    );
    expect(displayedResults.shownSpecies).toEqual([]);
    expect(indicesOf(displayedResults.doubtfulSpecies)).toEqual([0, 1]);
  });

  it('el margen se mide desde la primera especie, no desde un sonido general', () => {
    const displayedResults = selectDisplayedResults(
      [
        { classIndex: 3, score: 15 },
        { classIndex: 0, score: 9 },
        { classIndex: 4, score: 8 },
      ],
      displayClasses,
    );
    expect(indicesOf(displayedResults.shownSpecies)).toEqual([0]);
    // El viento (15) se menciona; el coche (8) no llega a «también se oye».
    expect(indicesOf(displayedResults.alsoHeardSounds)).toEqual([3]);
  });

  it('acepta otro umbral absoluto', () => {
    expect(selectDisplayedResults([{ classIndex: 0, score: 8 }], displayClasses, 9).shownSpecies).toEqual([]);
  });
});
