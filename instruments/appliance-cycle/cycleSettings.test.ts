import {
  buildDetectorSettings,
  defaultApplianceCycleSettings,
  parseStoredApplianceCycleSettings,
  sensitivityPresets,
} from './cycleSettings';

describe('parseStoredApplianceCycleSettings', () => {
  it('lee una configuración válida', () => {
    expect(parseStoredApplianceCycleSettings(JSON.stringify({ sensitivityLevel: 'high', quietMinutesToFinish: 5 }))).toEqual({
      sensitivityLevel: 'high',
      quietMinutesToFinish: 5,
    });
  });

  it('vuelve a los valores por defecto con datos corruptos o fuera de las opciones', () => {
    expect(parseStoredApplianceCycleSettings(null)).toEqual(defaultApplianceCycleSettings);
    expect(parseStoredApplianceCycleSettings('{no es json')).toEqual(defaultApplianceCycleSettings);
    expect(parseStoredApplianceCycleSettings('null')).toEqual(defaultApplianceCycleSettings);
    expect(
      parseStoredApplianceCycleSettings(JSON.stringify({ sensitivityLevel: 'extrema', quietMinutesToFinish: 7 })),
    ).toEqual(defaultApplianceCycleSettings);
  });
});

describe('buildDetectorSettings', () => {
  it('pasa los minutos a segundos y aplica la sensibilidad', () => {
    const detectorSettings = buildDetectorSettings({ sensitivityLevel: 'low', quietMinutesToFinish: 10 });
    expect(detectorSettings.quietSecondsToFinish).toBe(600);
    expect(detectorSettings.backgroundMultiplier).toBe(sensitivityPresets.low.backgroundMultiplier);
    expect(detectorSettings.minimumThreshold).toBe(sensitivityPresets.low.minimumThreshold);
  });

  it('las sensibilidades van ordenadas: más alta, umbrales más bajos', () => {
    const { high, medium, low } = sensitivityPresets;
    expect(high.minimumThreshold).toBeLessThan(medium.minimumThreshold);
    expect(medium.minimumThreshold).toBeLessThan(low.minimumThreshold);
    expect(high.fallbackThreshold).toBeLessThan(medium.fallbackThreshold);
    expect(medium.fallbackThreshold).toBeLessThan(low.fallbackThreshold);
  });
});
