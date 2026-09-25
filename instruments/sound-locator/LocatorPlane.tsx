import { Canvas, Line, Path, Rect, Skia, vec } from '@shopify/react-native-skia';
import { useMemo, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';

import { type ErrorEllipse, type PlanePoint, sampleHyperbolaBranch } from '@/processing/localization/multilateration';
import { useThemePalette } from '@/ui/theme';

export interface PlaneHyperbola {
  focusA: PlanePoint;
  focusB: PlanePoint;
  /** |x − B| − |x − A| (m). */
  rangeDifferenceMeters: number;
  color: string;
}

interface LocatorPlaneProps {
  receiverPositions: readonly PlanePoint[];
  receiverLabels: readonly string[];
  emitterIndex: number;
  hyperbolas: readonly PlaneHyperbola[];
  estimatedPosition: PlanePoint | null;
  errorEllipse: ErrorEllipse | null;
  alternativePosition: PlanePoint | null;
  accessibilityLabel: string;
}

const viewMarginMeters = 0.6;
/** Una elipse enorme no debe encoger el plano hasta no ver los móviles. */
const maximumIncludedEllipseMeters = 6;
const receiverMarkerSize = 10;
const labelOffsetPixels = 8;

function chooseGridStepMeters(spanMeters: number): number {
  for (const candidateStep of [0.25, 0.5, 1, 2, 5, 10]) {
    if (spanMeters / candidateStep <= 12) return candidateStep;
  }
  return 20;
}

function makeCirclePath(centerX: number, centerY: number, radius: number) {
  const circlePath = Skia.Path.Make();
  const segmentCount = 32;
  for (let segmentIndex = 0; segmentIndex <= segmentCount; segmentIndex++) {
    const angle = (2 * Math.PI * segmentIndex) / segmentCount;
    const pointX = centerX + radius * Math.cos(angle);
    const pointY = centerY + radius * Math.sin(angle);
    if (segmentIndex === 0) circlePath.moveTo(pointX, pointY);
    else circlePath.lineTo(pointX, pointY);
  }
  return circlePath;
}

/**
 * Plano de la medida: móviles (el emisor con un anillo), una hipérbola por cada móvil respecto
 * a A, el punto estimado con su elipse del 95 % y, si la hay, la otra solución posible.
 * El eje y apunta hacia arriba, como en un plano dibujado a mano.
 */
export function LocatorPlane({
  receiverPositions,
  receiverLabels,
  emitterIndex,
  hyperbolas,
  estimatedPosition,
  errorEllipse,
  alternativePosition,
  accessibilityLabel,
}: LocatorPlaneProps) {
  const themePalette = useThemePalette();
  const [canvasWidth, setCanvasWidth] = useState(0);
  const canvasHeight = canvasWidth;

  const drawing = useMemo(() => {
    const includedPoints: PlanePoint[] = [...receiverPositions];
    if (estimatedPosition) includedPoints.push(estimatedPosition);
    if (alternativePosition) includedPoints.push(alternativePosition);
    if (errorEllipse && estimatedPosition) {
      const includedRadius = Math.min(errorEllipse.semiMajorAxisMeters, maximumIncludedEllipseMeters);
      includedPoints.push(
        { x: estimatedPosition.x - includedRadius, y: estimatedPosition.y - includedRadius },
        { x: estimatedPosition.x + includedRadius, y: estimatedPosition.y + includedRadius },
      );
    }
    const finitePoints = includedPoints.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (finitePoints.length === 0 || canvasWidth <= 0) return null;
    const minimumX = Math.min(...finitePoints.map((point) => point.x)) - viewMarginMeters;
    const maximumX = Math.max(...finitePoints.map((point) => point.x)) + viewMarginMeters;
    const minimumY = Math.min(...finitePoints.map((point) => point.y)) - viewMarginMeters;
    const maximumY = Math.max(...finitePoints.map((point) => point.y)) + viewMarginMeters;
    const spanMeters = Math.max(maximumX - minimumX, maximumY - minimumY, 1);
    const pixelsPerMeter = Math.min(canvasWidth, canvasHeight) / spanMeters;
    const centerX = (minimumX + maximumX) / 2;
    const centerY = (minimumY + maximumY) / 2;
    const toScreen = (point: PlanePoint) => ({
      x: canvasWidth / 2 + (point.x - centerX) * pixelsPerMeter,
      y: canvasHeight / 2 - (point.y - centerY) * pixelsPerMeter,
    });

    const gridStepMeters = chooseGridStepMeters(spanMeters);
    const visibleHalfSpan = spanMeters / 2;
    const gridLines: { start: PlanePoint; end: PlanePoint; isAxis: boolean }[] = [];
    const firstGridX = Math.ceil((centerX - visibleHalfSpan) / gridStepMeters) * gridStepMeters;
    for (let gridX = firstGridX; gridX <= centerX + visibleHalfSpan; gridX += gridStepMeters) {
      gridLines.push({
        start: toScreen({ x: gridX, y: centerY - visibleHalfSpan }),
        end: toScreen({ x: gridX, y: centerY + visibleHalfSpan }),
        isAxis: Math.abs(gridX) < 1e-9,
      });
    }
    const firstGridY = Math.ceil((centerY - visibleHalfSpan) / gridStepMeters) * gridStepMeters;
    for (let gridY = firstGridY; gridY <= centerY + visibleHalfSpan; gridY += gridStepMeters) {
      gridLines.push({
        start: toScreen({ x: centerX - visibleHalfSpan, y: gridY }),
        end: toScreen({ x: centerX + visibleHalfSpan, y: gridY }),
        isAxis: Math.abs(gridY) < 1e-9,
      });
    }

    const hyperbolaPaths = hyperbolas.map((hyperbola) => {
      const hyperbolaPath = Skia.Path.Make();
      const branchPoints = sampleHyperbolaBranch(
        hyperbola.focusA,
        hyperbola.focusB,
        hyperbola.rangeDifferenceMeters,
        spanMeters * 1.5,
        96,
      );
      branchPoints?.forEach((branchPoint, pointIndex) => {
        const screenPoint = toScreen(branchPoint);
        if (pointIndex === 0) hyperbolaPath.moveTo(screenPoint.x, screenPoint.y);
        else hyperbolaPath.lineTo(screenPoint.x, screenPoint.y);
      });
      return { hyperbolaPath, color: hyperbola.color };
    });

    let ellipsePath = null;
    if (errorEllipse && estimatedPosition) {
      ellipsePath = Skia.Path.Make();
      const cosine = Math.cos(errorEllipse.orientationRadians);
      const sine = Math.sin(errorEllipse.orientationRadians);
      const segmentCount = 64;
      for (let segmentIndex = 0; segmentIndex <= segmentCount; segmentIndex++) {
        const angle = (2 * Math.PI * segmentIndex) / segmentCount;
        const alongMajor = errorEllipse.semiMajorAxisMeters * Math.cos(angle);
        const alongMinor = errorEllipse.semiMinorAxisMeters * Math.sin(angle);
        const screenPoint = toScreen({
          x: estimatedPosition.x + alongMajor * cosine - alongMinor * sine,
          y: estimatedPosition.y + alongMajor * sine + alongMinor * cosine,
        });
        if (segmentIndex === 0) ellipsePath.moveTo(screenPoint.x, screenPoint.y);
        else ellipsePath.lineTo(screenPoint.x, screenPoint.y);
      }
    }

    const receiverScreenPositions = receiverPositions.map(toScreen);
    const emitterScreenPosition = receiverScreenPositions[emitterIndex];
    return {
      gridLines,
      gridStepMeters,
      hyperbolaPaths,
      ellipsePath,
      receiverScreenPositions,
      emitterRingPath: emitterScreenPosition
        ? makeCirclePath(emitterScreenPosition.x, emitterScreenPosition.y, receiverMarkerSize)
        : null,
      estimatedScreenPosition: estimatedPosition ? toScreen(estimatedPosition) : null,
      alternativeRingPath: alternativePosition
        ? makeCirclePath(toScreen(alternativePosition).x, toScreen(alternativePosition).y, 7)
        : null,
    };
  }, [
    receiverPositions,
    estimatedPosition,
    alternativePosition,
    errorEllipse,
    hyperbolas,
    emitterIndex,
    canvasWidth,
    canvasHeight,
  ]);

  const crossHalfSize = 8;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={[styles.container, { borderColor: themePalette.border, backgroundColor: themePalette.surface }]}
      onLayout={(layoutEvent: LayoutChangeEvent) => setCanvasWidth(layoutEvent.nativeEvent.layout.width)}>
      {drawing ? (
        <View style={{ width: canvasWidth, height: canvasHeight }}>
          <Canvas style={{ width: canvasWidth, height: canvasHeight }}>
            {drawing.gridLines.map((gridLine, gridLineIndex) => (
              <Line
                key={`grid-${gridLineIndex}`}
                p1={vec(gridLine.start.x, gridLine.start.y)}
                p2={vec(gridLine.end.x, gridLine.end.y)}
                color={gridLine.isAxis ? themePalette.textSecondary : themePalette.border}
                strokeWidth={gridLine.isAxis ? 1 : StyleSheet.hairlineWidth}
              />
            ))}
            {drawing.hyperbolaPaths.map(({ hyperbolaPath, color }, hyperbolaIndex) => (
              <Path
                key={`hyperbola-${hyperbolaIndex}`}
                path={hyperbolaPath}
                style="stroke"
                strokeWidth={2}
                color={color}
              />
            ))}
            {drawing.ellipsePath ? (
              <Path path={drawing.ellipsePath} style="stroke" strokeWidth={2} color={themePalette.accent} />
            ) : null}
            {drawing.alternativeRingPath ? (
              <Path path={drawing.alternativeRingPath} style="stroke" strokeWidth={2} color={themePalette.danger} />
            ) : null}
            {drawing.emitterRingPath ? (
              <Path path={drawing.emitterRingPath} style="stroke" strokeWidth={2} color={themePalette.textPrimary} />
            ) : null}
            {drawing.receiverScreenPositions.map((screenPosition, receiverIndex) => (
              <Rect
                key={`receiver-${receiverIndex}`}
                x={screenPosition.x - receiverMarkerSize / 2}
                y={screenPosition.y - receiverMarkerSize / 2}
                width={receiverMarkerSize}
                height={receiverMarkerSize}
                color={themePalette.textPrimary}
              />
            ))}
            {drawing.estimatedScreenPosition ? (
              <>
                <Line
                  p1={vec(drawing.estimatedScreenPosition.x - crossHalfSize, drawing.estimatedScreenPosition.y)}
                  p2={vec(drawing.estimatedScreenPosition.x + crossHalfSize, drawing.estimatedScreenPosition.y)}
                  color={themePalette.accent}
                  strokeWidth={3}
                />
                <Line
                  p1={vec(drawing.estimatedScreenPosition.x, drawing.estimatedScreenPosition.y - crossHalfSize)}
                  p2={vec(drawing.estimatedScreenPosition.x, drawing.estimatedScreenPosition.y + crossHalfSize)}
                  color={themePalette.accent}
                  strokeWidth={3}
                />
              </>
            ) : null}
          </Canvas>
          {drawing.receiverScreenPositions.map((screenPosition, receiverIndex) => (
            <Text
              key={`label-${receiverIndex}`}
              style={[
                styles.receiverLabel,
                {
                  color: themePalette.textPrimary,
                  left: screenPosition.x + labelOffsetPixels,
                  top: screenPosition.y - labelOffsetPixels - 14,
                },
              ]}>
              {receiverLabels[receiverIndex] ?? ''}
            </Text>
          ))}
          <Text style={[styles.scaleLabel, { color: themePalette.textSecondary }]}>
            {`▦ ${drawing.gridStepMeters} m`}
          </Text>
        </View>
      ) : (
        <View style={styles.placeholder} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  placeholder: { aspectRatio: 1 },
  receiverLabel: { position: 'absolute', fontSize: 13, fontWeight: '700' },
  scaleLabel: { position: 'absolute', right: 6, bottom: 4, fontSize: 11 },
});
