import { startRecorderInOrder, stopRecorderInOrder } from './recorderQueue';

/** Imita el módulo nativo: un solo grabador activo a la vez y llamadas que tardan un poco. */
let recordingOwner: FakeRecorder | null = null;
const nativeCallMilliseconds = 10;

function waitMilliseconds(durationMilliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, durationMilliseconds));
}

class FakeRecorder {
  startCallCount = 0;
  async start() {
    this.startCallCount++;
    await waitMilliseconds(nativeCallMilliseconds);
    if (recordingOwner && recordingOwner !== this) {
      return { status: 'error' as const, message: 'Another recording is already in progress' };
    }
    recordingOwner = this;
    return { status: 'success' as const };
  }
  async stop() {
    await waitMilliseconds(nativeCallMilliseconds);
    if (recordingOwner === this) recordingOwner = null;
    return { status: 'success' as const, path: '', size: 0, duration: 0 };
  }
}

function createRecorder() {
  // El tipo de la librería pide un FileInfo completo: para la cola basta con start y stop.
  return new FakeRecorder() as FakeRecorder & Parameters<typeof startRecorderInOrder>[0];
}

beforeEach(() => {
  recordingOwner = null;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('cola de arranque y parada del grabador', () => {
  it('una parada pedida mientras arranca espera al arranque y deja el grabador parado', async () => {
    const audioRecorder = createRecorder();
    const startPromise = startRecorderInOrder(audioRecorder, () => false);
    const stopPromise = stopRecorderInOrder(audioRecorder);
    await jest.runAllTimersAsync();
    await expect(startPromise).resolves.toEqual({ status: 'success' });
    await stopPromise;
    expect(recordingOwner).toBeNull();
  });

  it('si se cancela con el arranque en marcha, para el grabador y devuelve null', async () => {
    const audioRecorder = createRecorder();
    let isCancelled = false;
    const startPromise = startRecorderInOrder(audioRecorder, () => isCancelled);
    isCancelled = true;
    await jest.runAllTimersAsync();
    await expect(startPromise).resolves.toBeNull();
    expect(recordingOwner).toBeNull();
  });

  it('no llega a arrancar si se cancela antes de su turno', async () => {
    const firstRecorder = createRecorder();
    const secondRecorder = createRecorder();
    void startRecorderInOrder(firstRecorder, () => false);
    const secondStartPromise = startRecorderInOrder(secondRecorder, () => true);
    await jest.runAllTimersAsync();
    await expect(secondStartPromise).resolves.toBeNull();
    expect(secondRecorder.startCallCount).toBe(0);
    void stopRecorderInOrder(firstRecorder);
    await jest.runAllTimersAsync();
    expect(recordingOwner).toBeNull();
  });

  it('un arranque espera a la parada del grabador anterior', async () => {
    const firstRecorder = createRecorder();
    const secondRecorder = createRecorder();
    void startRecorderInOrder(firstRecorder, () => false);
    void stopRecorderInOrder(firstRecorder);
    const secondStartPromise = startRecorderInOrder(secondRecorder, () => false);
    await jest.runAllTimersAsync();
    await expect(secondStartPromise).resolves.toEqual({ status: 'success' });
    expect(recordingOwner).toBe(secondRecorder);
    expect(secondRecorder.startCallCount).toBe(1);
  });

  it('reintenta si otro grabador suelta el micrófono un poco más tarde', async () => {
    const firstRecorder = createRecorder();
    const secondRecorder = createRecorder();
    void startRecorderInOrder(firstRecorder, () => false);
    await jest.runAllTimersAsync();
    const secondStartPromise = startRecorderInOrder(secondRecorder, () => false);
    // La parada del primero llega después (p. ej. en la limpieza del render siguiente).
    await jest.advanceTimersByTimeAsync(nativeCallMilliseconds * 2);
    void stopRecorderInOrder(firstRecorder);
    await jest.runAllTimersAsync();
    await expect(secondStartPromise).resolves.toEqual({ status: 'success' });
    expect(recordingOwner).toBe(secondRecorder);
    expect(secondRecorder.startCallCount).toBe(2);
  });
});
