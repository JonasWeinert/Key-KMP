export type UnlistenFn = () => void;
export interface Event<T> {
  event: string;
  id: number;
  payload: T;
}
export async function listen<T>(
  event: string,
  callback: (event: Event<T>) => void,
): Promise<UnlistenFn> {
  const bridge = (
    window as unknown as {
      key: { on(event: string, callback: (payload: T) => void): UnlistenFn };
    }
  ).key;
  return bridge.on(event, (payload) => callback({ event, id: 0, payload }));
}
