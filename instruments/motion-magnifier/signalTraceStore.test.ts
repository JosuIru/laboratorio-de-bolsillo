import { createSignalTraceStore } from './signalTraceStore';

describe('traza en vivo del monitor', () => {
  it('guarda los últimos valores en orden y avisa uno de cada N', () => {
    const traceStore = createSignalTraceStore(4, 2);
    const notifications: number[] = [];
    const unsubscribe = traceStore.subscribe(() => notifications.push(traceStore.getRevision()));
    for (let traceValue = 1; traceValue <= 6; traceValue++) traceStore.push(traceValue);
    expect(Array.from(traceStore.readInOrder())).toEqual([3, 4, 5, 6]);
    expect(notifications).toEqual([1, 2, 3]);

    traceStore.clear();
    expect(traceStore.readInOrder().length).toBe(0);
    expect(notifications).toHaveLength(4);
    unsubscribe();
    traceStore.push(7);
    traceStore.push(8);
    expect(notifications).toHaveLength(4);
  });
});
