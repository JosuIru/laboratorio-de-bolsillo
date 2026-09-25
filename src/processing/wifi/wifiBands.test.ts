import {
  channelFromFrequency,
  channelWidthMhzFromAndroidCode,
  frequencyFromChannel,
  isDfsChannel,
  wifiStandardLabel,
} from './wifiBands';

describe('channelFromFrequency', () => {
  it('reconoce los canales de 2,4 GHz, incluido el 14', () => {
    expect(channelFromFrequency(2412)).toEqual({ band: '2.4GHz', channelNumber: 1 });
    expect(channelFromFrequency(2437)).toEqual({ band: '2.4GHz', channelNumber: 6 });
    expect(channelFromFrequency(2472)).toEqual({ band: '2.4GHz', channelNumber: 13 });
    expect(channelFromFrequency(2484)).toEqual({ band: '2.4GHz', channelNumber: 14 });
  });

  it('reconoce 5 y 6 GHz', () => {
    expect(channelFromFrequency(5180)).toEqual({ band: '5GHz', channelNumber: 36 });
    expect(channelFromFrequency(5745)).toEqual({ band: '5GHz', channelNumber: 149 });
    expect(channelFromFrequency(5955)).toEqual({ band: '6GHz', channelNumber: 1 });
    expect(channelFromFrequency(5935)).toEqual({ band: '6GHz', channelNumber: 2 });
    expect(channelFromFrequency(6115)).toEqual({ band: '6GHz', channelNumber: 33 });
  });

  it('devuelve null fuera de las bandas Wi‑Fi', () => {
    expect(channelFromFrequency(0)).toBeNull();
    expect(channelFromFrequency(Number.NaN)).toBeNull();
    expect(channelFromFrequency(3500)).toBeNull();
  });

  it('frequencyFromChannel es la inversa', () => {
    for (const frequencyMhz of [2412, 2462, 2484, 5180, 5500, 5825, 5935, 5955, 7115]) {
      const channel = channelFromFrequency(frequencyMhz);
      expect(channel).not.toBeNull();
      expect(frequencyFromChannel(channel!)).toBe(frequencyMhz);
    }
  });
});

describe('anchos, estándares y DFS', () => {
  it('traduce los códigos de ancho de Android', () => {
    expect([0, 1, 2, 3, 4, 5, -1].map(channelWidthMhzFromAndroidCode)).toEqual([20, 40, 80, 160, 160, 320, 20]);
  });

  it('pone nombre comercial a los estándares', () => {
    expect(wifiStandardLabel(6)).toContain('Wi‑Fi 6');
    expect(wifiStandardLabel(0)).toBeNull();
    expect(wifiStandardLabel(null)).toBeNull();
  });

  it('marca DFS solo entre los canales 52 y 144 de 5 GHz', () => {
    expect(isDfsChannel({ band: '5GHz', channelNumber: 36 })).toBe(false);
    expect(isDfsChannel({ band: '5GHz', channelNumber: 100 })).toBe(true);
    expect(isDfsChannel({ band: '5GHz', channelNumber: 149 })).toBe(false);
    expect(isDfsChannel({ band: '2.4GHz', channelNumber: 6 })).toBe(false);
  });
});
