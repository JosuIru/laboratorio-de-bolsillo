/** Mock mínimo de VisionCamera para Jest: permite importar y renderizar sin cámara nativa. */
import { forwardRef } from 'react';

export const VisionCamera = {
  cameraPermissionStatus: 'not-determined',
  requestCameraPermission: async () => false,
};
export const Camera = forwardRef(function MockCamera() {
  return null;
});
export const useCameraDevice = () => undefined;
export const useFrameOutput = () => ({});
export const usePhotoOutput = () => ({});
export const CommonResolutions = {
  VGA_4_3: { width: 480, height: 640 },
  HD_4_3: { width: 768, height: 1024 },
  FHD_4_3: { width: 1440, height: 1920 },
  UHD_4_3: { width: 3024, height: 4032 },
};
