import {
  combineBaselineRecordings,
  compareFingerprints,
  createDomainAccumulator,
  type DomainFingerprint,
  type MachineFingerprint,
} from './machineFingerprint';

const bandCentersHz = [100, 125, 160, 200];

function domainFingerprint(bandLevelsDecibels: number[], overallLevelDecibels: number): DomainFingerprint {
  return { bandCentersHz, bandLevelsDecibels, overallLevelDecibels, frameCount: 10 };
}

function machineFingerprint(audio: DomainFingerprint | null, vibration: DomainFingerprint | null): MachineFingerprint {
  return { audio, vibration, capturedAt: 0, durationSeconds: 10 };
}

describe('createDomainAccumulator', () => {
  it('promedia en potencia, no en dB', () => {
    const accumulator = createDomainAccumulator([100]);
    accumulator.push([1]);
    accumulator.push([0.01]);
    const fingerprint = accumulator.finish()!;
    // Media de 1 y 0,01 en potencia = 0,505 → −2,97 dB (en dB habría salido −10 dB).
    expect(fingerprint.bandLevelsDecibels[0]).toBeCloseTo(-2.97, 2);
    expect(fingerprint.frameCount).toBe(2);
  });

  it('el nivel global es la suma de las bandas', () => {
    const accumulator = createDomainAccumulator([100, 200]);
    accumulator.push([1, 1]);
    expect(accumulator.finish()!.overallLevelDecibels).toBeCloseTo(3.01, 2);
  });

  it('sin tramas no hay huella', () => {
    expect(createDomainAccumulator([100]).finish()).toBeNull();
  });
});

describe('combineBaselineRecordings', () => {
  it('una sola grabación queda igual, sin dispersión', () => {
    const recording = machineFingerprint(domainFingerprint([-40, -45, -50, -60], -38), null);
    const baseline = combineBaselineRecordings([recording])!;
    expect(baseline.audio).toEqual(recording.audio);
    expect(baseline.recordingCount).toBe(1);
  });

  it('sin grabaciones no hay huella', () => {
    expect(combineBaselineRecordings([])).toBeNull();
  });
});

describe('compareFingerprints', () => {
  const healthyAudio = domainFingerprint([-40, -45, -50, -60], -38);
  const healthyVibration = domainFingerprint([-30, -35, -40, -50], -28);
  const healthyMachine = machineFingerprint(healthyAudio, healthyVibration);

  it('la misma huella es normal', () => {
    const diagnosis = compareFingerprints(healthyMachine, healthyMachine);
    expect(diagnosis.verdict).toBe('normal');
    expect(diagnosis.largestIncreaseDecibels).toBe(0);
    expect(diagnosis.overallDeltaDecibels).toEqual({ audio: 0, vibration: 0 });
  });

  it('una sola banda que sube 8 dB queda en vigilancia y sale la primera', () => {
    const worseVibration = domainFingerprint([-30, -35, -32, -50], -27);
    const diagnosis = compareFingerprints(healthyMachine, machineFingerprint(healthyAudio, worseVibration));
    expect(diagnosis.verdict).toBe('watch');
    expect(diagnosis.bandDeviations[0]).toEqual({ domain: 'vibration', centerHz: 160, deltaDecibels: 8 });
  });

  it('una sola banda que sube 10 dB (un tono nuevo) da alerta', () => {
    const newTone = domainFingerprint([-30, -35, -30, -50], -27.5);
    expect(compareFingerprints(healthyMachine, machineFingerprint(healthyAudio, newTone)).verdict).toBe('alert');
  });

  it('dos bandas que suben 7 dB dan alerta', () => {
    const twoBandsUp = domainFingerprint([-30, -28, -33, -50], -27);
    expect(compareFingerprints(healthyMachine, machineFingerprint(healthyAudio, twoBandsUp)).verdict).toBe('alert');
  });

  it('una banda sola que sube 4 dB es normal', () => {
    const oneBandUp = domainFingerprint([-40, -45, -46, -60], -37.5);
    expect(compareFingerprints(healthyMachine, machineFingerprint(oneBandUp, healthyVibration)).verdict).toBe('normal');
  });

  it('descuenta la variación normal entre las grabaciones de la huella base', () => {
    const baseline = combineBaselineRecordings([
      machineFingerprint(domainFingerprint([-40, -45, -50, -60], -38), null),
      machineFingerprint(domainFingerprint([-36, -41, -50, -60], -34), null),
    ])!;
    expect(baseline.recordingCount).toBe(2);
    // Las dos primeras bandas varían ±2 dB entre grabaciones; el global, lo mismo.
    expect(baseline.audio!.bandSpreadDecibels![0]).toBeCloseTo(2, 0);
    expect(baseline.audio!.bandSpreadDecibels![2]).toBe(0);
    const sameAsSecondRecording = machineFingerprint(domainFingerprint([-36, -41, -50, -60], -34), null);
    expect(compareFingerprints(baseline, sameAsSecondRecording).verdict).toBe('normal');
  });

  it('una subida de 4 dB queda en vigilancia', () => {
    const slightlyLouder = domainFingerprint([-36, -45, -50, -60], -35);
    expect(compareFingerprints(healthyMachine, machineFingerprint(slightlyLouder, healthyVibration)).verdict).toBe('watch');
  });

  it('un tono nuevo que sale del ruido cuenta desde el suelo, no desde −200 dB', () => {
    const baselineWithSilentBand = machineFingerprint(domainFingerprint([-40, -200, -50, -60], -38), null);
    const currentWithNewTone = machineFingerprint(domainFingerprint([-40, -90, -50, -60], -38), null);
    const diagnosis = compareFingerprints(baselineWithSilentBand, currentWithNewTone);
    expect(diagnosis.bandDeviations[0]).toEqual({ domain: 'audio', centerHz: 125, deltaDecibels: 10 });
  });

  it('ignora las bandas que están bajo el ruido en las dos medidas', () => {
    const quietBaseline = machineFingerprint(domainFingerprint([-40, -150, -50, -60], -38), null);
    const quietCurrent = machineFingerprint(domainFingerprint([-40, -120, -50, -60], -38), null);
    const diagnosis = compareFingerprints(quietBaseline, quietCurrent);
    expect(diagnosis.bandDeviations.find((deviation) => deviation.centerHz === 125)).toBeUndefined();
  });

  it('compara solo los dominios presentes en las dos huellas', () => {
    const audioOnly = machineFingerprint(healthyAudio, null);
    const diagnosis = compareFingerprints(healthyMachine, audioOnly);
    expect(diagnosis.overallDeltaDecibels.vibration).toBeNull();
    expect(diagnosis.bandDeviations.every((deviation) => deviation.domain === 'audio')).toBe(true);
  });
});
