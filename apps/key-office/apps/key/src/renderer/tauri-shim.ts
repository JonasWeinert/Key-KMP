/** Adapter for the shared Key reader; workspace binding is owned by Electron. */
export interface InvokeOptions {
  headers?: Record<string, string>;
}
export function invoke<T = unknown>(
  command: string,
  args?: Record<string, unknown> | Uint8Array | ArrayBuffer,
  options?: InvokeOptions,
): Promise<T> {
  const bridge = (
    window as unknown as {
      key: {
        invoke<T>(
          command: string,
          args?: unknown,
          workspaceId?: string,
          options?: InvokeOptions,
        ): Promise<T>;
      };
    }
  ).key;
  return bridge.invoke<T>(command, args, undefined, options);
}
