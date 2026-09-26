import { defaultVehicleSettings, parseStoredVehicleSettings } from './vehicleSettingsStorage';

describe('parseStoredVehicleSettings', () => {
  it('lee las medidas, el tipo de vehículo y el cero guardados', () => {
    const storedSettings = {
      vehicleLayout: 'singleAxle',
      trackWidthCentimeters: 205,
      wheelbaseCentimeters: 380,
      jockeyDistanceCentimeters: 450,
      zeroOffset: { tiltXDegrees: 0.4, tiltYDegrees: -0.2 },
    };
    expect(parseStoredVehicleSettings(JSON.stringify(storedSettings))).toEqual(storedSettings);
  });

  it('usa los valores por defecto para lo que falte o no valga', () => {
    expect(
      parseStoredVehicleSettings(
        JSON.stringify({
          vehicleLayout: 'triciclo',
          trackWidthCentimeters: 10,
          wheelbaseCentimeters: 'larga',
          zeroOffset: { tiltXDegrees: 30, tiltYDegrees: 0 },
        }),
      ),
    ).toEqual(defaultVehicleSettings);
  });

  it('devuelve los valores por defecto con JSON roto o vacío', () => {
    expect(parseStoredVehicleSettings('{roto')).toEqual(defaultVehicleSettings);
    expect(parseStoredVehicleSettings(null)).toEqual(defaultVehicleSettings);
    expect(parseStoredVehicleSettings('null')).toEqual(defaultVehicleSettings);
  });
});
