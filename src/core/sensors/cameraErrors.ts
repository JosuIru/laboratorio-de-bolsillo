/**
 * Errores de cámara que son parte del ciclo de vida normal y no hay que mostrar: al bloquear
 * el móvil o salir de la pantalla, Android cancela las operaciones pendientes (zoom, enfoque,
 * exposición) con «Camera is not active» u «OperationCanceled».
 */
export function isExpectedCameraInterruption(cameraError: { message?: string } | null | undefined): boolean {
  return /not active|OperationCanceled/i.test(cameraError?.message ?? '');
}
