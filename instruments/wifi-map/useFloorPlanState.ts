import { useCallback, useMemo, useState } from 'react';

import type { PlanPoint, PlanRoom, SignalMeasurementPoint } from '@/processing/wifi/floorPlan';
import { interpolateHeatmap, summarizeDeadZones } from '@/processing/wifi/heatmapInterpolation';
import { recommendRepeaterLocation } from '@/processing/wifi/repeaterRecommendation';

import { heatmapColumnCount, heatmapRowCount, planAspectRatio } from './wifiMapConfiguration';

/** Punto del mapa con la frecuencia a la que estaba conectado (para avisar si cambia de banda). */
export interface MappedPoint extends SignalMeasurementPoint {
  frequencyMhz: number;
  sampleCount: number;
}

/**
 * Estado del mapa (habitaciones y puntos) y lo que se deriva de él: mapa de calor, zonas
 * muertas y sitio del repetidor. Vive en la pantalla principal para no perderse al cambiar de modo.
 */
export function useFloorPlanState() {
  const [rooms, setRooms] = useState<PlanRoom[]>([]);
  const [mappedPoints, setMappedPoints] = useState<MappedPoint[]>([]);
  const [pendingRoomCorner, setPendingRoomCorner] = useState<PlanPoint | null>(null);

  const heatmapGrid = useMemo(
    () =>
      mappedPoints.length >= 2
        ? interpolateHeatmap(mappedPoints, {
            columnCount: heatmapColumnCount,
            rowCount: heatmapRowCount,
            aspectRatio: planAspectRatio,
            rooms,
          })
        : null,
    [mappedPoints, rooms],
  );

  const deadZoneSummary = useMemo(() => (heatmapGrid ? summarizeDeadZones(heatmapGrid) : null), [heatmapGrid]);
  const repeaterRecommendation = useMemo(
    () => (heatmapGrid ? recommendRepeaterLocation(heatmapGrid, mappedPoints.length, planAspectRatio) : null),
    [heatmapGrid, mappedPoints.length],
  );

  const addRoom = useCallback((room: PlanRoom) => setRooms((previousRooms) => [...previousRooms, room]), []);
  const removeLastRoom = useCallback(() => setRooms((previousRooms) => previousRooms.slice(0, -1)), []);
  const clearRooms = useCallback(() => {
    setRooms([]);
    setPendingRoomCorner(null);
  }, []);
  const addPoint = useCallback(
    (mappedPoint: MappedPoint) => setMappedPoints((previousPoints) => [...previousPoints, mappedPoint]),
    [],
  );
  const removeLastPoint = useCallback(() => setMappedPoints((previousPoints) => previousPoints.slice(0, -1)), []);
  const clearPoints = useCallback(() => setMappedPoints([]), []);

  const measuredFrequencies = new Set(mappedPoints.map((mappedPoint) => mappedPoint.frequencyMhz));

  return {
    rooms,
    mappedPoints,
    pendingRoomCorner,
    setPendingRoomCorner,
    heatmapGrid,
    deadZoneSummary,
    repeaterRecommendation,
    hasMixedFrequencies: measuredFrequencies.size > 1,
    addRoom,
    removeLastRoom,
    clearRooms,
    addPoint,
    removeLastPoint,
    clearPoints,
  };
}

export type FloorPlanState = ReturnType<typeof useFloorPlanState>;
