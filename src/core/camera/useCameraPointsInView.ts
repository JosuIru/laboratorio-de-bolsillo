import { type RefObject, useEffect, useState } from 'react';
import type { CameraRef } from 'react-native-vision-camera';

import { convertCameraPointsToViewPoints, type PreviewPoint } from './previewGeometry';

/**
 * Tras un cambio de tamaño, la vista previa nativa puede tardar un poco en reajustar su
 * transformación (o en arrancar): se repite la conversión pasados estos tiempos.
 */
const settledLayoutDelaysMilliseconds = [250, 1000];

/**
 * Posición en la vista de unos puntos guardados en coordenadas de cámara. Guardar los puntos en
 * coordenadas de cámara (y no en píxeles de la vista) hace que no se descoloquen cuando la vista
 * previa cambia de tamaño, p. ej. al pasar de 340 px de alto a pantalla completa.
 *
 * Se recalcula al cambiar los puntos o el tamaño de la vista, y otra vez un momento después, cuando
 * la vista nativa ya se ha reajustado. Un punto que aún no se puede convertir queda en `null`.
 */
export function useCameraPointsInView(
  cameraRef: RefObject<CameraRef | null>,
  cameraPoints: readonly (PreviewPoint | null)[],
  previewWidth: number,
  previewHeight: number,
): (PreviewPoint | null)[] {
  const [viewPoints, setViewPoints] = useState<(PreviewPoint | null)[]>(() => cameraPoints.map(() => null));

  useEffect(() => {
    function recalculateViewPoints() {
      const cameraView = cameraRef.current;
      setViewPoints(
        cameraView
          ? convertCameraPointsToViewPoints(cameraPoints, (cameraPoint) =>
              cameraView.convertCameraPointToViewPoint(cameraPoint),
            )
          : cameraPoints.map(() => null),
      );
    }
    recalculateViewPoints();
    const settledLayoutTimers = settledLayoutDelaysMilliseconds.map((delayMilliseconds) =>
      setTimeout(recalculateViewPoints, delayMilliseconds),
    );
    return () => settledLayoutTimers.forEach(clearTimeout);
  }, [cameraRef, cameraPoints, previewWidth, previewHeight]);

  return viewPoints;
}
