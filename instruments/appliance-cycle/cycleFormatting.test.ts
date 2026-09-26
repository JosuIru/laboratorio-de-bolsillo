import { alarmPatternDurationSeconds, generateAlarmPattern } from './alarmPattern';
import { formatCycleDuration, formatLocalDateTime, formatLocalTime } from './cycleFormatting';

describe('formatCycleDuration', () => {
  it('minutos y segundos, y horas solo si las hay', () => {
    expect(formatCycleDuration(0)).toBe('0:00');
    expect(formatCycleDuration(309)).toBe('5:09');
    expect(formatCycleDuration(3909.4)).toBe('1:05:09');
    expect(formatCycleDuration(-3)).toBe('0:00');
  });
});

describe('formatLocalDateTime', () => {
  it('usa la hora local con ceros a la izquierda', () => {
    const localDate = new Date(2026, 8, 6, 7, 5, 30);
    expect(formatLocalDateTime(localDate)).toBe('2026-09-06 07:05');
    expect(formatLocalTime(localDate)).toBe('07:05');
  });
});

describe('generateAlarmPattern', () => {
  it('tres pitidos y un silencio al final, sin saturar', () => {
    const patternSampleRateHz = 8000;
    const patternSamples = generateAlarmPattern(patternSampleRateHz);
    expect(patternSamples).toHaveLength(Math.round(alarmPatternDurationSeconds * patternSampleRateHz));
    const peakAmplitude = patternSamples.reduce((peak, sampleValue) => Math.max(peak, Math.abs(sampleValue)), 0);
    expect(peakAmplitude).toBeGreaterThan(0.5);
    expect(peakAmplitude).toBeLessThanOrEqual(1);
    const trailingSilence = patternSamples.subarray(patternSamples.length - patternSampleRateHz / 2);
    expect(trailingSilence.every((sampleValue) => sampleValue === 0)).toBe(true);
  });
});
