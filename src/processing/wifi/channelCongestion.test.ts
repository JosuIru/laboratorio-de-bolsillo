import {
  analyzeBandChannels,
  groupNetworksByPrimaryChannel,
  isChannelChangeWorthwhile,
  measureChannelCongestion,
  type NeighborNetwork,
  occupiedSpectrumMhz,
  signalWeight,
} from './channelCongestion';

let bssidCounter = 0;
function neighbor(frequencyMhz: number, rssiDbm: number, extra: Partial<NeighborNetwork> = {}): NeighborNetwork {
  bssidCounter++;
  return {
    bssid: `aa:bb:cc:00:00:${bssidCounter.toString(16).padStart(2, '0')}`,
    ssid: `vecino-${bssidCounter}`,
    rssiDbm,
    frequencyMhz,
    centerFrequencyMhz: null,
    channelWidthMhz: 20,
    ...extra,
  };
}

describe('signalWeight y occupiedSpectrumMhz', () => {
  it('pesa más las redes que se oyen fuerte', () => {
    expect(signalWeight(-40)).toBe(1);
    expect(signalWeight(-50)).toBe(1);
    expect(signalWeight(-72.5)).toBeCloseTo(0.5, 10);
    expect(signalWeight(-100)).toBe(0);
  });

  it('una red de 2,4 GHz ocupa 22 MHz y una de 80 MHz usa su frecuencia central', () => {
    expect(occupiedSpectrumMhz(neighbor(2437, -60))).toEqual([2426, 2448]);
    expect(occupiedSpectrumMhz(neighbor(5180, -60, { channelWidthMhz: 80, centerFrequencyMhz: 5210 }))).toEqual([
      5170, 5250,
    ]);
    expect(occupiedSpectrumMhz(neighbor(1000, -60))).toBeNull();
  });
});

describe('measureChannelCongestion', () => {
  it('una red en el canal 3 molesta a los canales 1 y 6, no al 11', () => {
    const networks = [neighbor(2422, -50)];
    expect(measureChannelCongestion('2.4GHz', 1, networks).congestionScore).toBeGreaterThan(0);
    expect(measureChannelCongestion('2.4GHz', 6, networks).congestionScore).toBeGreaterThan(0);
    expect(measureChannelCongestion('2.4GHz', 11, networks).congestionScore).toBe(0);
    expect(measureChannelCongestion('2.4GHz', 1, networks).primaryNetworkCount).toBe(0);
  });

  it('una red de 80 MHz ocupa los cuatro canales de 20 MHz de su bloque', () => {
    const networks = [neighbor(5180, -50, { channelWidthMhz: 80, centerFrequencyMhz: 5210 })];
    for (const channelNumber of [36, 40, 44, 48]) {
      expect(measureChannelCongestion('5GHz', channelNumber, networks).congestionScore).toBeCloseTo(1, 10);
    }
    expect(measureChannelCongestion('5GHz', 52, networks).congestionScore).toBe(0);
    expect(measureChannelCongestion('5GHz', 36, networks).primaryNetworkCount).toBe(1);
  });
});

describe('analyzeBandChannels', () => {
  it('en 2,4 GHz recomienda el canal libre entre 1, 6 y 11', () => {
    const networks = [neighbor(2412, -45), neighbor(2412, -60), neighbor(2437, -55), neighbor(2462, -85)];
    const analysis = analyzeBandChannels('2.4GHz', networks);
    expect(analysis.bestChannel?.channelNumber).toBe(11);
    expect(analysis.networkCount).toBe(4);
    expect(analysis.candidateChannels.map((channel) => channel.channelNumber)).toEqual([1, 6, 11]);
  });

  it('no cuenta la red propia como vecina', () => {
    const ownNetwork = neighbor(2462, -30);
    const networks = [neighbor(2412, -50), neighbor(2437, -50), ownNetwork];
    const analysis = analyzeBandChannels('2.4GHz', networks, [ownNetwork.bssid.toUpperCase()]);
    expect(analysis.bestChannel?.channelNumber).toBe(11);
    expect(analysis.networkCount).toBe(2);
  });

  it('en 5 GHz prefiere un canal sin DFS si está casi igual de libre', () => {
    const networks = [neighbor(5180, -80), neighbor(5200, -80), neighbor(5220, -80), neighbor(5240, -80)];
    // 36-48 levemente ocupados (peso ≈ 0,33); los DFS vacíos ganan porque la diferencia supera la penalización.
    expect(analyzeBandChannels('5GHz', networks).bestChannel?.isDfs).toBe(true);
    const lightNetworks = [neighbor(5180, -90)];
    // Solo el 36 tiene algo: gana el 40, que no es DFS.
    expect(analyzeBandChannels('5GHz', lightNetworks).bestChannel?.channelNumber).toBe(40);
  });

  it('sin vecinos cualquier canal vale y se queda con el primero', () => {
    expect(analyzeBandChannels('2.4GHz', []).bestChannel?.channelNumber).toBe(1);
  });

  it('solo aconseja cambiar si la mejora es clara, también desde canales no estándar', () => {
    const networks = [neighbor(2412, -45), neighbor(2417, -50), neighbor(2422, -50)];
    const analysis = analyzeBandChannels('2.4GHz', networks);
    expect(isChannelChangeWorthwhile(analysis, 1)).toBe(true);
    expect(isChannelChangeWorthwhile(analysis, 3)).toBe(true);
    expect(isChannelChangeWorthwhile(analysis, analysis.bestChannel!.channelNumber)).toBe(false);
    const quietAnalysis = analyzeBandChannels('2.4GHz', [neighbor(2412, -90)]);
    expect(isChannelChangeWorthwhile(quietAnalysis, 1)).toBe(false);
  });
});

describe('groupNetworksByPrimaryChannel', () => {
  it('agrupa por banda y canal, ordena canales y dentro de cada uno por señal', () => {
    const groups = groupNetworksByPrimaryChannel([
      neighbor(5180, -70),
      neighbor(2437, -80),
      neighbor(2437, -40),
      neighbor(2412, -60),
      neighbor(999, -60),
    ]);
    expect(groups.map((group) => `${group.band}:${group.channelNumber}`)).toEqual(['2.4GHz:1', '2.4GHz:6', '5GHz:36']);
    expect(groups[1]!.networks.map((network) => network.rssiDbm)).toEqual([-40, -80]);
  });
});
