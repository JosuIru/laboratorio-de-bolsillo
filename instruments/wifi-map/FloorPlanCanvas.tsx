import { AlphaType, Canvas, Circle, ColorType, Image, Path, Rect, Skia } from '@shopify/react-native-skia';
import { memo, useMemo, useState } from 'react';
import { type GestureResponderEvent, type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';

import type { PlanPoint, PlanRoom, SignalMeasurementPoint } from '@/processing/wifi/floorPlan';
import { colorForRssi, type HeatmapGrid, renderHeatmapPixels } from '@/processing/wifi/heatmapInterpolation';
import { useThemePalette } from '@/ui/theme';

import { planAspectRatio, planGridColumnCount, planGridRowCount } from './wifiMapConfiguration';

interface FloorPlanCanvasProps {
  rooms: readonly PlanRoom[];
  measurementPoints: readonly SignalMeasurementPoint[];
  heatmapGrid: HeatmapGrid | null;
  repeaterLocation: PlanPoint | null;
  /** Primera esquina de una habitación a medio dibujar. */
  pendingRoomCorner: PlanPoint | null;
  /** Punto que se está midiendo ahora mismo. */
  measuringPoint: PlanPoint | null;
  onPlanPress(point: PlanPoint): void;
  accessibilityLabel: string;
}

function rgbToHex([red, green, blue]: readonly [number, number, number]): string {
  return `#${[red, green, blue].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Plano de la casa: rejilla, habitaciones, mapa de calor, puntos medidos y el sitio recomendado
 * para el repetidor. Se toca para colocar esquinas o puntos (coordenadas normalizadas 0-1).
 * Va memorizado: la conexión se lee cada 500 ms y no hace falta repintar el plano si no cambia.
 */
export const FloorPlanCanvas = memo(function FloorPlanCanvas({
  rooms,
  measurementPoints,
  heatmapGrid,
  repeaterLocation,
  pendingRoomCorner,
  measuringPoint,
  onPlanPress,
  accessibilityLabel,
}: FloorPlanCanvasProps) {
  const themePalette = useThemePalette();
  const [planWidth, setPlanWidth] = useState(0);
  const planHeight = planWidth * planAspectRatio;

  const gridPath = useMemo(() => {
    const path = Skia.Path.Make();
    if (planWidth <= 0) return path;
    for (let columnIndex = 0; columnIndex <= planGridColumnCount; columnIndex++) {
      const lineX = (columnIndex / planGridColumnCount) * planWidth;
      path.moveTo(lineX, 0);
      path.lineTo(lineX, planHeight);
    }
    for (let rowIndex = 0; rowIndex <= planGridRowCount; rowIndex++) {
      const lineY = (rowIndex / planGridRowCount) * planHeight;
      path.moveTo(0, lineY);
      path.lineTo(planWidth, lineY);
    }
    return path;
  }, [planWidth, planHeight]);

  const heatmapImage = useMemo(() => {
    if (!heatmapGrid) return null;
    const pixels = new Uint8Array(heatmapGrid.columnCount * heatmapGrid.rowCount * 4);
    renderHeatmapPixels(heatmapGrid, pixels);
    return Skia.Image.MakeImage(
      {
        width: heatmapGrid.columnCount,
        height: heatmapGrid.rowCount,
        alphaType: AlphaType.Unpremul,
        colorType: ColorType.RGBA_8888,
      },
      Skia.Data.fromBytes(pixels),
      heatmapGrid.columnCount * 4,
    );
  }, [heatmapGrid]);

  function handlePress(pressEvent: GestureResponderEvent) {
    if (planWidth <= 0) return;
    const { locationX, locationY } = pressEvent.nativeEvent;
    onPlanPress({
      x: Math.min(1, Math.max(0, locationX / planWidth)),
      y: Math.min(1, Math.max(0, locationY / planHeight)),
    });
  }

  const markerRadius = Math.max(6, planWidth / 40);

  return (
    <View
      onLayout={(layoutEvent: LayoutChangeEvent) => setPlanWidth(layoutEvent.nativeEvent.layout.width)}
      style={[styles.container, { borderColor: themePalette.border, backgroundColor: themePalette.background }]}>
      {planWidth > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          onPress={handlePress}
          style={{ width: planWidth, height: planHeight }}>
          <Canvas style={{ width: planWidth, height: planHeight }}>
            <Path path={gridPath} style="stroke" strokeWidth={StyleSheet.hairlineWidth} color={themePalette.border} />
            {rooms.map((room, roomIndex) => (
              <Rect
                key={`room-fill-${roomIndex}`}
                x={room.left * planWidth}
                y={room.top * planHeight}
                width={(room.right - room.left) * planWidth}
                height={(room.bottom - room.top) * planHeight}
                color={themePalette.surface}
              />
            ))}
            {heatmapImage ? (
              <Image image={heatmapImage} x={0} y={0} width={planWidth} height={planHeight} fit="fill" />
            ) : null}
            {rooms.map((room, roomIndex) => (
              <Rect
                key={`room-wall-${roomIndex}`}
                x={room.left * planWidth}
                y={room.top * planHeight}
                width={(room.right - room.left) * planWidth}
                height={(room.bottom - room.top) * planHeight}
                style="stroke"
                strokeWidth={3}
                color={themePalette.textPrimary}
              />
            ))}
            {measurementPoints.map((measurementPoint, pointIndex) => (
              <Circle
                key={`point-${pointIndex}`}
                cx={measurementPoint.x * planWidth}
                cy={measurementPoint.y * planHeight}
                r={markerRadius * 0.6}
                color={rgbToHex(colorForRssi(measurementPoint.rssiDbm))}
              />
            ))}
            {measurementPoints.map((measurementPoint, pointIndex) => (
              <Circle
                key={`point-ring-${pointIndex}`}
                cx={measurementPoint.x * planWidth}
                cy={measurementPoint.y * planHeight}
                r={markerRadius * 0.6}
                style="stroke"
                strokeWidth={1.5}
                color={themePalette.textPrimary}
              />
            ))}
            {pendingRoomCorner ? (
              <Circle
                cx={pendingRoomCorner.x * planWidth}
                cy={pendingRoomCorner.y * planHeight}
                r={markerRadius * 0.5}
                color={themePalette.accent}
              />
            ) : null}
            {measuringPoint ? (
              <Circle
                cx={measuringPoint.x * planWidth}
                cy={measuringPoint.y * planHeight}
                r={markerRadius}
                style="stroke"
                strokeWidth={3}
                color={themePalette.accent}
              />
            ) : null}
            {repeaterLocation ? (
              <Circle
                cx={repeaterLocation.x * planWidth}
                cy={repeaterLocation.y * planHeight}
                r={markerRadius * 1.4}
                style="stroke"
                strokeWidth={3}
                color={themePalette.accent}
              />
            ) : null}
          </Canvas>
          {measurementPoints.map((measurementPoint, pointIndex) => (
            <Text
              key={`label-${pointIndex}`}
              pointerEvents="none"
              style={[
                styles.pointLabel,
                {
                  left: measurementPoint.x * planWidth + markerRadius * 0.7,
                  top: measurementPoint.y * planHeight - 7,
                  color: themePalette.textPrimary,
                  backgroundColor: themePalette.surface,
                },
              ]}>
              {Math.round(measurementPoint.rssiDbm)}
            </Text>
          ))}
          {repeaterLocation ? (
            <Text
              pointerEvents="none"
              style={[
                styles.repeaterLabel,
                {
                  left: repeaterLocation.x * planWidth - 7,
                  top: repeaterLocation.y * planHeight - 10,
                  color: themePalette.accent,
                },
              ]}>
              R
            </Text>
          ) : null}
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  pointLabel: { position: 'absolute', fontSize: 10, fontVariant: ['tabular-nums'], paddingHorizontal: 2, borderRadius: 3 },
  repeaterLabel: { position: 'absolute', fontSize: 16, fontWeight: '800', width: 14, textAlign: 'center' },
});
