import {
  findRoomIndexAt,
  flattenRooms,
  isPointInsideHouse,
  planDistance,
  type PlanPoint,
  roomFromCorners,
  type SignalMeasurementPoint,
  unflattenRooms,
} from './floorPlan';
import {
  colorForRssi,
  interpolateHeatmap,
  interpolateRssiAt,
  renderHeatmapPixels,
  summarizeDeadZones,
} from './heatmapInterpolation';
import { recommendRepeaterLocation } from './repeaterRecommendation';

const planAspectRatio = 1.25;
const routerLocation: PlanPoint = { x: 0.1, y: 0.1 };

/** Modelo log-distancia: −35 dBm a 1/20 del plano del router y exponente 3,5 (interiores con paredes). */
function syntheticRssiAt(point: PlanPoint): number {
  const distance = Math.max(0.05, planDistance(point, routerLocation, planAspectRatio));
  return -35 - 35 * Math.log10(distance / 0.05);
}

function measureOnGrid(columnCount: number, rowCount: number): SignalMeasurementPoint[] {
  const measurementPoints: SignalMeasurementPoint[] = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
      const point = { x: (columnIndex + 0.5) / columnCount, y: (rowIndex + 0.5) / rowCount };
      measurementPoints.push({ ...point, rssiDbm: syntheticRssiAt(point) });
    }
  }
  return measurementPoints;
}

describe('plano', () => {
  it('crea habitaciones ajustadas a la rejilla desde dos esquinas en cualquier orden', () => {
    expect(roomFromCorners({ x: 0.52, y: 0.9 }, { x: 0.13, y: 0.26 }, 10, 10)).toEqual({
      left: 0.1,
      top: 0.3,
      right: 0.5,
      bottom: 0.9,
    });
    expect(roomFromCorners({ x: 0.5, y: 0.5 }, { x: 0.51, y: 0.52 }, 10, 10)).toBeNull();
  });

  it('sin habitaciones todo es casa; con habitaciones, solo su interior', () => {
    const rooms = [{ left: 0, top: 0, right: 0.5, bottom: 0.5 }];
    expect(isPointInsideHouse({ x: 0.9, y: 0.9 }, [])).toBe(true);
    expect(isPointInsideHouse({ x: 0.25, y: 0.25 }, rooms)).toBe(true);
    expect(isPointInsideHouse({ x: 0.9, y: 0.9 }, rooms)).toBe(false);
  });

  it('al tocar elige la habitación más pequeña y el aplanado es reversible', () => {
    const rooms = [
      { left: 0, top: 0, right: 1, bottom: 1 },
      { left: 0.2, top: 0.2, right: 0.4, bottom: 0.4 },
    ];
    expect(findRoomIndexAt({ x: 0.3, y: 0.3 }, rooms)).toBe(1);
    expect(findRoomIndexAt({ x: 0.8, y: 0.8 }, rooms)).toBe(0);
    expect(findRoomIndexAt({ x: 0.3, y: 0.3 }, [])).toBe(-1);
    expect(unflattenRooms(flattenRooms(rooms))).toEqual(rooms);
  });
});

describe('interpolateRssiAt (IDW)', () => {
  const measurementPoints: SignalMeasurementPoint[] = [
    { x: 0, y: 0, rssiDbm: -40 },
    { x: 1, y: 0, rssiDbm: -80 },
  ];

  it('es exacta en los puntos medidos y devuelve null sin puntos', () => {
    expect(interpolateRssiAt({ x: 0, y: 0 }, measurementPoints, 1)).toBe(-40);
    expect(interpolateRssiAt({ x: 0.5, y: 0.5 }, [], 1)).toBeNull();
  });

  it('en el punto medio da la media y siempre queda entre el mínimo y el máximo', () => {
    expect(interpolateRssiAt({ x: 0.5, y: 0 }, measurementPoints, 1)).toBeCloseTo(-60, 10);
    for (const x of [0.1, 0.3, 0.7, 0.9]) {
      const value = interpolateRssiAt({ x, y: 0.4 }, measurementPoints, 1)!;
      expect(value).toBeGreaterThanOrEqual(-80);
      expect(value).toBeLessThanOrEqual(-40);
    }
  });

  it('un exponente mayor pega más el valor al punto más cercano', () => {
    const nearFirstPoint = { x: 0.3, y: 0 };
    const softValue = interpolateRssiAt(nearFirstPoint, measurementPoints, 1, 1)!;
    const sharpValue = interpolateRssiAt(nearFirstPoint, measurementPoints, 1, 4)!;
    expect(Math.abs(sharpValue + 40)).toBeLessThan(Math.abs(softValue + 40));
  });
});

describe('interpolateHeatmap con un router sintético', () => {
  const measurementPoints = measureOnGrid(4, 5);
  const heatmapGrid = interpolateHeatmap(measurementPoints, {
    columnCount: 40,
    rowCount: 50,
    aspectRatio: planAspectRatio,
    rooms: [],
  });

  it('reproduce la señal verdadera en las celdas no medidas con error acotado', () => {
    let absoluteErrorSum = 0;
    let cellCount = 0;
    for (let rowIndex = 5; rowIndex < 50; rowIndex += 7) {
      for (let columnIndex = 3; columnIndex < 40; columnIndex += 6) {
        const truth = syntheticRssiAt({ x: (columnIndex + 0.5) / 40, y: (rowIndex + 0.5) / 50 });
        absoluteErrorSum += Math.abs(heatmapGrid.rssiDbm[rowIndex * 40 + columnIndex]! - truth);
        cellCount++;
      }
    }
    // 20 puntos para toda la casa: IDW suaviza, pero el error medio queda en unos pocos dB.
    expect(absoluteErrorSum / cellCount).toBeLessThan(5);
  });

  it('la señal baja al alejarse del router', () => {
    const nearRouter = heatmapGrid.rssiDbm[3 * 40 + 3]!;
    const farCorner = heatmapGrid.rssiDbm[48 * 40 + 38]!;
    expect(nearRouter).toBeGreaterThan(farCorner + 15);
  });

  it('encuentra la zona muerta en la esquina opuesta al router', () => {
    const deadZoneSummary = summarizeDeadZones(heatmapGrid);
    expect(deadZoneSummary.deadFraction).toBeGreaterThan(0.02);
    expect(deadZoneSummary.deadFraction).toBeLessThan(0.6);
    expect(deadZoneSummary.deadZoneCentroid!.x).toBeGreaterThan(0.5);
    expect(deadZoneSummary.deadZoneCentroid!.y).toBeGreaterThan(0.5);
  });

  it('recomienda el repetidor entre el router y la zona muerta, con señal suficiente', () => {
    const recommendation = recommendRepeaterLocation(heatmapGrid, measurementPoints.length, planAspectRatio);
    expect(recommendation.status).toBe('recommended');
    if (recommendation.status !== 'recommended') return;
    expect(recommendation.rssiDbm).toBeGreaterThanOrEqual(-70);
    const routerToDeadZone = planDistance(routerLocation, recommendation.deadZoneCentroid, planAspectRatio);
    const routerToRepeater = planDistance(routerLocation, recommendation.location, planAspectRatio);
    const repeaterToDeadZone = planDistance(recommendation.location, recommendation.deadZoneCentroid, planAspectRatio);
    expect(routerToRepeater).toBeLessThan(routerToDeadZone);
    expect(repeaterToDeadZone).toBeLessThan(routerToDeadZone);
    // Casi en línea recta entre los dos.
    expect(routerToRepeater + repeaterToDeadZone).toBeLessThan(routerToDeadZone * 1.25);
  });
});

describe('recommendRepeaterLocation: casos sin recomendación', () => {
  const gridOptions = { columnCount: 20, rowCount: 20, aspectRatio: 1, rooms: [] };

  it('pide más puntos si hay pocos', () => {
    const fewPoints = [{ x: 0.5, y: 0.5, rssiDbm: -90 }];
    expect(recommendRepeaterLocation(interpolateHeatmap(fewPoints, gridOptions), 1, 1).status).toBe(
      'not-enough-points',
    );
  });

  it('no recomienda nada si toda la casa tiene buena señal', () => {
    const goodPoints = measureOnGrid(3, 3).map((point) => ({ ...point, rssiDbm: -50 }));
    expect(recommendRepeaterLocation(interpolateHeatmap(goodPoints, gridOptions), 9, 1).status).toBe('no-dead-zone');
  });

  it('avisa si no hay ningún sitio con señal suficiente para el repetidor', () => {
    const badPoints = measureOnGrid(3, 3).map((point) => ({ ...point, rssiDbm: -85 }));
    expect(recommendRepeaterLocation(interpolateHeatmap(badPoints, gridOptions), 9, 1).status).toBe('no-good-spot');
  });
});

describe('máscara de habitaciones y píxeles', () => {
  const rooms = [{ left: 0, top: 0, right: 0.5, bottom: 1 }];
  const measurementPoints = [
    { x: 0.1, y: 0.1, rssiDbm: -45 },
    { x: 0.4, y: 0.9, rssiDbm: -88 },
  ];
  const heatmapGrid = interpolateHeatmap(measurementPoints, { columnCount: 10, rowCount: 10, aspectRatio: 1, rooms });

  it('fuera de las habitaciones no hay valor', () => {
    expect(heatmapGrid.insideHouse[0]).toBe(1);
    expect(heatmapGrid.insideHouse[9]).toBe(0);
    expect(Number.isNaN(heatmapGrid.rssiDbm[9]!)).toBe(true);
  });

  it('pinta transparente fuera, opaco cerca de las medidas y con rayas en la zona muerta', () => {
    const pixels = new Uint8Array(10 * 10 * 4);
    renderHeatmapPixels(heatmapGrid, pixels);
    expect(pixels[9 * 4 + 3]).toBe(0);
    expect(pixels[3]).toBe(210);
    // La celda de la medida buena es verde; alguna celda de la zona muerta está oscurecida.
    expect(pixels[1]!).toBeGreaterThan(pixels[0]!);
    const deadCellIndices = [8 * 10 + 3, 8 * 10 + 4, 9 * 10 + 3, 9 * 10 + 4, 9 * 10 + 2];
    const darkenedCellCount = deadCellIndices.filter((cellIndex) => pixels[cellIndex * 4]! < 100).length;
    expect(darkenedCellCount).toBeGreaterThan(0);
  });

  it('la escala de color va de rojo a verde', () => {
    const [worstRed, worstGreen] = colorForRssi(-95);
    const [bestRed, bestGreen] = colorForRssi(-40);
    expect(worstRed).toBeGreaterThan(worstGreen);
    expect(bestGreen).toBeGreaterThan(bestRed);
  });
});
