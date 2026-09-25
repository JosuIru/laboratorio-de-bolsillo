import {
  channelFromFrequency,
  frequencyFromChannel,
  isDfsChannel,
  recommendableChannelsByBand,
  type WifiBand,
} from './wifiBands';

/**
 * Congestión por canal a partir de un escaneo de redes vecinas. Cada red ocupa un tramo de
 * espectro (según su ancho de canal) y «estorba» a un canal candidato en proporción al solape y
 * a lo fuerte que se oye. Es una estimación: el escaneo no dice cuánto tráfico mueve cada red,
 * solo que existe y con qué intensidad llega.
 */

export interface NeighborNetwork {
  bssid: string;
  ssid: string | null;
  rssiDbm: number;
  /** Frecuencia del canal primario de 20 MHz. */
  frequencyMhz: number;
  /** Centro de todo el canal si es de 40/80/160 MHz (0 o null si no se sabe). */
  centerFrequencyMhz: number | null;
  channelWidthMhz: number;
}

export type RecommendableBand = Exclude<WifiBand, '6GHz'>;

export interface ChannelCongestion {
  channelNumber: number;
  /** Suma de solape × peso de señal de las redes que tocan el canal. 0 = libre. */
  congestionScore: number;
  /** Redes que se solapan (aunque sea en parte) con el canal. */
  overlappingNetworkCount: number;
  /** Redes cuyo canal primario es exactamente este. */
  primaryNetworkCount: number;
  isDfs: boolean;
}

export interface BandChannelAnalysis {
  band: RecommendableBand;
  /** Solo los canales recomendables de la banda. */
  candidateChannels: ChannelCongestion[];
  /** Canal menos congestionado (null si no hay candidatos). */
  bestChannel: ChannelCongestion | null;
  networkCount: number;
  /** Redes vecinas de todas las bandas, sin las propias. */
  neighborNetworks: readonly NeighborNetwork[];
}

/** Ancho real de un canal «de 20 MHz»: en 2,4 GHz la máscara espectral ocupa unos 22 MHz. */
function nominalChannelWidthMhz(band: WifiBand): number {
  return band === '2.4GHz' ? 22 : 20;
}

/** Peso de una red según cómo se oye: −50 dBm o más → 1; −95 dBm o menos → 0. */
export function signalWeight(rssiDbm: number): number {
  return Math.min(1, Math.max(0, (rssiDbm + 95) / 45));
}

/** Tramo de espectro [inicio, fin] en MHz que ocupa una red. */
export function occupiedSpectrumMhz(network: NeighborNetwork): [number, number] | null {
  const primaryChannel = channelFromFrequency(network.frequencyMhz);
  if (!primaryChannel) return null;
  if (network.channelWidthMhz > 20 && network.centerFrequencyMhz && network.centerFrequencyMhz > 0) {
    const halfWidth = network.channelWidthMhz / 2;
    return [network.centerFrequencyMhz - halfWidth, network.centerFrequencyMhz + halfWidth];
  }
  const halfWidth = nominalChannelWidthMhz(primaryChannel.band) / 2;
  return [network.frequencyMhz - halfWidth, network.frequencyMhz + halfWidth];
}

function overlapLength(firstRange: [number, number], secondRange: [number, number]): number {
  return Math.max(0, Math.min(firstRange[1], secondRange[1]) - Math.max(firstRange[0], secondRange[0]));
}

/** En 5 GHz se prefiere un canal sin DFS salvo que el DFS esté claramente más libre. */
export const dfsRankingPenalty = 0.25;

export function measureChannelCongestion(
  band: RecommendableBand,
  channelNumber: number,
  networks: readonly NeighborNetwork[],
): ChannelCongestion {
  const channelWidth = nominalChannelWidthMhz(band);
  const centerFrequency = frequencyFromChannel({ band, channelNumber });
  const channelRange: [number, number] = [centerFrequency - channelWidth / 2, centerFrequency + channelWidth / 2];
  let congestionScore = 0;
  let overlappingNetworkCount = 0;
  let primaryNetworkCount = 0;
  for (const network of networks) {
    const primaryChannel = channelFromFrequency(network.frequencyMhz);
    if (primaryChannel?.band !== band) continue;
    if (primaryChannel.channelNumber === channelNumber) primaryNetworkCount++;
    const networkRange = occupiedSpectrumMhz(network);
    if (!networkRange) continue;
    const overlapFraction = overlapLength(channelRange, networkRange) / channelWidth;
    if (overlapFraction <= 0) continue;
    overlappingNetworkCount++;
    congestionScore += overlapFraction * signalWeight(network.rssiDbm);
  }
  return {
    channelNumber,
    congestionScore,
    overlappingNetworkCount,
    primaryNetworkCount,
    isDfs: isDfsChannel({ band, channelNumber }),
  };
}

/**
 * Analiza una banda. `ownBssids` son los puntos de acceso propios (la red a la que estás
 * conectado): no cuentan como vecinos.
 */
export function analyzeBandChannels(
  band: RecommendableBand,
  networks: readonly NeighborNetwork[],
  ownBssids: readonly string[] = [],
): BandChannelAnalysis {
  const ownBssidSet = new Set(ownBssids.map((bssid) => bssid.toLowerCase()));
  const neighborNetworks = networks.filter((network) => !ownBssidSet.has(network.bssid.toLowerCase()));
  const candidateChannels = recommendableChannelsByBand[band].map((channelNumber) =>
    measureChannelCongestion(band, channelNumber, neighborNetworks),
  );
  const rankingScore = (channel: ChannelCongestion) =>
    channel.congestionScore + (channel.isDfs ? dfsRankingPenalty : 0);
  const bestChannel = candidateChannels.reduce<ChannelCongestion | null>(
    (currentBest, channel) =>
      currentBest === null || rankingScore(channel) < rankingScore(currentBest) - 1e-9 ? channel : currentBest,
    null,
  );
  const networkCount = neighborNetworks.filter(
    (network) => channelFromFrequency(network.frequencyMhz)?.band === band,
  ).length;
  return { band, candidateChannels, bestChannel, networkCount, neighborNetworks };
}

/** Redes agrupadas por canal primario, de más a menos señal (para la lista de vecinos). */
export function groupNetworksByPrimaryChannel(
  networks: readonly NeighborNetwork[],
): { band: WifiBand; channelNumber: number; networks: NeighborNetwork[] }[] {
  const groupsByKey = new Map<string, { band: WifiBand; channelNumber: number; networks: NeighborNetwork[] }>();
  for (const network of networks) {
    const primaryChannel = channelFromFrequency(network.frequencyMhz);
    if (!primaryChannel) continue;
    const groupKey = `${primaryChannel.band}:${primaryChannel.channelNumber}`;
    const existingGroup = groupsByKey.get(groupKey);
    if (existingGroup) existingGroup.networks.push(network);
    else groupsByKey.set(groupKey, { ...primaryChannel, networks: [network] });
  }
  const bandOrder: WifiBand[] = ['2.4GHz', '5GHz', '6GHz'];
  return [...groupsByKey.values()]
    .map((group) => ({ ...group, networks: [...group.networks].sort((first, second) => second.rssiDbm - first.rssiDbm) }))
    .sort(
      (first, second) =>
        bandOrder.indexOf(first.band) - bandOrder.indexOf(second.band) || first.channelNumber - second.channelNumber,
    );
}

/**
 * ¿Merece la pena cambiar de canal? Solo si el mejor está claramente más libre que el actual
 * (la congestión fluctúa y cada cambio corta la conexión unos segundos).
 */
export const worthwhileImprovement = 0.5;

export function isChannelChangeWorthwhile(
  analysis: BandChannelAnalysis,
  currentChannelNumber: number,
): boolean {
  if (!analysis.bestChannel || analysis.bestChannel.channelNumber === currentChannelNumber) return false;
  const currentCongestion = measureChannelCongestion(analysis.band, currentChannelNumber, analysis.neighborNetworks);
  return currentCongestion.congestionScore - analysis.bestChannel.congestionScore >= worthwhileImprovement;
}
