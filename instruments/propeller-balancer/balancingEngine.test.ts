import {
  measureRotationVibration,
  solveFourRunBalancing,
  splitCorrectionBetweenBlades,
  trialPositionsDegrees,
} from './balancingEngine';

/** Vibraciones de las cuatro pasadas para un desequilibrio y un efecto de prueba conocidos. */
function simulateFourRuns(initialAmplitude: number, unbalanceAngleDegrees: number, trialEffectAmplitude: number) {
  const unbalanceX = initialAmplitude * Math.cos((unbalanceAngleDegrees * Math.PI) / 180);
  const unbalanceY = initialAmplitude * Math.sin((unbalanceAngleDegrees * Math.PI) / 180);
  const trialAmplitudes = trialPositionsDegrees.map((positionDegrees) =>
    Math.hypot(
      unbalanceX + trialEffectAmplitude * Math.cos((positionDegrees * Math.PI) / 180),
      unbalanceY + trialEffectAmplitude * Math.sin((positionDegrees * Math.PI) / 180),
    ),
  ) as [number, number, number];
  return { initialAmplitude, trialAmplitudes };
}

describe('solveFourRunBalancing', () => {
  it.each([
    [0.8, 30, 0.5],
    [0.5, 200, 0.4],
    [1.2, 300, 0.9],
  ])(
    'desequilibrio %s a %s° con efecto de prueba %s: corrige en el lado opuesto',
    (initialAmplitude, angleDegrees, effect) => {
      const balancingSolution = solveFourRunBalancing({
        ...simulateFourRuns(initialAmplitude, angleDegrees, effect),
        trialMassGrams: 2,
      });
      expect(typeof balancingSolution).toBe('object');
      if (typeof balancingSolution === 'string') return;
      expect(balancingSolution.trialEffectAmplitude).toBeCloseTo(effect, 6);
      expect(balancingSolution.correctionMassGrams).toBeCloseTo((2 * initialAmplitude) / effect, 6);
      expect(balancingSolution.correctionAngleDegrees).toBeCloseTo((angleDegrees + 180) % 360, 4);
      expect(balancingSolution.fitResidual).toBeLessThan(1e-6);
    },
  );

  it('avisa si el peso de prueba apenas cambia la vibración', () => {
    expect(solveFourRunBalancing({ ...simulateFourRuns(1, 90, 0.05), trialMassGrams: 1 })).toBe('trial-too-small');
  });

  it('avisa si las medidas no encajan', () => {
    expect(solveFourRunBalancing({ initialAmplitude: 1, trialAmplitudes: [0.2, 3, 0.2], trialMassGrams: 1 })).toBe(
      'inconsistent',
    );
  });

  it('no calcula nada si ya está equilibrada', () => {
    expect(solveFourRunBalancing({ initialAmplitude: 0.01, trialAmplitudes: [0.3, 0.3, 0.3], trialMassGrams: 1 })).toBe(
      'already-balanced',
    );
  });
});

describe('splitCorrectionBetweenBlades', () => {
  it('sobre una pala, todo el peso a esa pala', () => {
    const { bladeCorrections } = splitCorrectionBetweenBlades(3, 120, 3);
    expect(bladeCorrections).toHaveLength(1);
    expect(bladeCorrections[0]!.bladeNumber).toBe(2);
    expect(bladeCorrections[0]!.massGrams).toBeCloseTo(3, 6);
  });

  it('entre dos palas, reparte de forma que la suma vectorial da la corrección', () => {
    const { bladeCorrections } = splitCorrectionBetweenBlades(2, 45, 4);
    const sumX = bladeCorrections.reduce(
      (partialSum, bladeCorrection) =>
        partialSum + bladeCorrection.massGrams * Math.cos(((bladeCorrection.bladeNumber - 1) * 90 * Math.PI) / 180),
      0,
    );
    const sumY = bladeCorrections.reduce(
      (partialSum, bladeCorrection) =>
        partialSum + bladeCorrection.massGrams * Math.sin(((bladeCorrection.bladeNumber - 1) * 90 * Math.PI) / 180),
      0,
    );
    expect(Math.hypot(sumX, sumY)).toBeCloseTo(2, 6);
    expect((Math.atan2(sumY, sumX) * 180) / Math.PI).toBeCloseTo(45, 6);
  });

  it('con dos palas: lo que va a lo largo de las palas a la de ese lado, y lo lateral al buje', () => {
    const bladeSplit = splitCorrectionBetweenBlades(1, 300, 2);
    // 300°: cos = 0,5 (hacia la pala 1) y sin = −0,87 (a 270°).
    expect(bladeSplit.bladeCorrections).toEqual([{ bladeNumber: 1, massGrams: expect.closeTo(0.5, 6) }]);
    expect(bladeSplit.hubCorrection!.angleDegrees).toBe(270);
    expect(bladeSplit.hubCorrection!.massGrams).toBeCloseTo(Math.sqrt(3) / 2, 6);
    for (const bladeCorrection of bladeSplit.bladeCorrections) expect(bladeCorrection.massGrams).toBeLessThan(1);
  });

  it('con dos palas y la corrección sobre una pala, no hace falta nada en el buje', () => {
    const bladeSplit = splitCorrectionBetweenBlades(2, 180, 2);
    expect(bladeSplit.bladeCorrections).toEqual([{ bladeNumber: 2, massGrams: expect.closeTo(2, 6) }]);
    expect(bladeSplit.hubCorrection).toBeNull();
  });

  it('pasa de la última pala a la primera', () => {
    const bladeNumbers = splitCorrectionBetweenBlades(1, 330, 3).bladeCorrections.map(
      (bladeCorrection) => bladeCorrection.bladeNumber,
    );
    expect(bladeNumbers.sort()).toEqual([1, 3]);
  });
});

describe('measureRotationVibration', () => {
  function rotatingUnbalance(rotationHz: number, amplitude: number, sampleRateHz: number, seconds: number) {
    const sampleCount = Math.round(sampleRateHz * seconds);
    const timestampsSeconds = Float64Array.from(
      { length: sampleCount },
      (_, sampleIndex) => sampleIndex / sampleRateHz,
    );
    let pseudoRandomState = 99;
    const noise = () => {
      pseudoRandomState = (pseudoRandomState * 1103515245 + 12345) % 2147483648;
      return (pseudoRandomState / 2147483648 - 0.5) * 0.02;
    };
    return {
      timestampsSeconds,
      x: timestampsSeconds.map((timeSeconds) => amplitude * Math.cos(2 * Math.PI * rotationHz * timeSeconds) + noise()),
      y: timestampsSeconds.map((timeSeconds) => amplitude * Math.sin(2 * Math.PI * rotationHz * timeSeconds) + noise()),
      z: timestampsSeconds.map(() => 9.81 + noise()),
    };
  }

  it('encuentra la frecuencia de giro y mide la amplitud (suma de potencias de los ejes)', () => {
    const rotationVibration = measureRotationVibration(rotatingUnbalance(23.3, 0.5, 200, 6), 5, 90)!;
    expect(rotationVibration.rotationFrequencyHz).toBeCloseTo(23.3, 0);
    // Giro en un plano: dos ejes con amplitud 0,5 → √2 · 0,5.
    expect(rotationVibration.amplitude).toBeCloseTo(0.5 * Math.SQRT2, 1);
  });

  it('la amplitud es proporcional al desequilibrio', () => {
    const smallVibration = measureRotationVibration(rotatingUnbalance(30, 0.2, 200, 6), 5, 90)!;
    const largeVibration = measureRotationVibration(rotatingUnbalance(30, 0.6, 200, 6), 5, 90)!;
    expect(largeVibration.amplitude / smallVibration.amplitude).toBeCloseTo(3, 1);
  });

  it('con pocas muestras no mide', () => {
    expect(measureRotationVibration(rotatingUnbalance(30, 0.5, 200, 0.3), 5, 90)).toBeNull();
  });
});
