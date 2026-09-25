import { isExpectedCameraInterruption } from './cameraErrors';

describe('isExpectedCameraInterruption', () => {
  it.each([
    ['Camera is not active!', true],
    ['androidx.camera.core.CameraControl$OperationCanceledException: Camera is not active.', true],
    ['operationcanceled', true],
    ['Camera permission denied', false],
    ['', false],
  ])('%j → %p', (errorMessage, isExpected) => {
    expect(isExpectedCameraInterruption(new Error(errorMessage))).toBe(isExpected);
  });

  it('tolera errores sin mensaje', () => {
    expect(isExpectedCameraInterruption(null)).toBe(false);
    expect(isExpectedCameraInterruption({})).toBe(false);
  });
});
