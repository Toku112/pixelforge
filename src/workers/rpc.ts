/**
 * Minimal typed request/response RPC over `postMessage`, used between the main
 * thread and our Web Workers. Worker modules call `exposeApi(api)`; the main thread
 * wraps the `Worker` with `wrapWorker<typeof api>()` and gets promise-returning
 * methods with the same names and argument types.
 *
 * Large buffers should be transferred rather than copied: wrap an argument or a
 * return value with `transfer(value, [buffer])`.
 */

type AnyFn = (...args: never[]) => unknown;
export type WorkerApi = Record<string, AnyFn>;

export type Remote<T extends WorkerApi> = {
  [K in keyof T]: (...args: Parameters<T[K]>) => Promise<Awaited<ReturnType<T[K]>>>;
};

const RPC_TAG = '__pfRpc';

interface RpcRequest {
  [RPC_TAG]: true;
  id: number;
  method: string;
  args: unknown[];
}

type RpcResponse =
  { [RPC_TAG]: true; id: number; ok: true; value: unknown } | { [RPC_TAG]: true; id: number; ok: false; error: string };

/** The subset of a worker scope / `Worker` / `MessagePort` that the RPC needs. */
export interface Endpoint {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
}

const transferLists = new WeakMap<object, Transferable[]>();

/** Marks `value` so the listed buffers are transferred (zero-copy) when it is posted. */
export function transfer<T extends object>(value: T, list: Transferable[]): T {
  transferLists.set(value, list);
  return value;
}

function transfersOf(values: readonly unknown[]): Transferable[] {
  const out: Transferable[] = [];
  for (const v of values) {
    if (v !== null && typeof v === 'object') out.push(...(transferLists.get(v) ?? []));
  }
  return out;
}

function isRpc(data: unknown): data is { [RPC_TAG]: true } {
  return typeof data === 'object' && data !== null && (data as Record<string, unknown>)[RPC_TAG] === true;
}

/** Serves `api` on `endpoint` (defaults to the current worker scope). */
export function exposeApi(api: WorkerApi, endpoint: Endpoint = self as unknown as Endpoint): void {
  endpoint.addEventListener('message', (ev: MessageEvent) => {
    if (!isRpc(ev.data)) return;
    const req = ev.data as RpcRequest;
    void (async () => {
      let response: RpcResponse;
      let list: Transferable[] = [];
      try {
        const fn = Object.hasOwn(api, req.method) ? api[req.method] : undefined;
        if (!fn) throw new Error(`Unknown worker method "${req.method}"`);
        const value = await (fn as (...a: unknown[]) => unknown)(...req.args);
        list = transfersOf([value]);
        response = { [RPC_TAG]: true, id: req.id, ok: true, value };
      } catch (e) {
        response = { [RPC_TAG]: true, id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      endpoint.postMessage(response, list);
    })();
  });
}

export interface WrappedWorker {
  /** Stops the worker and rejects all pending calls. */
  terminate(): void;
}

/** Returns a typed client for a worker that called `exposeApi`. */
export function wrapWorker<T extends WorkerApi>(worker: Worker): Remote<T> & WrappedWorker {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  // Once the worker has failed or been terminated, every later call rejects immediately.
  let dead: Error | null = null;
  const fail = (error: Error) => {
    dead ??= error;
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };

  worker.addEventListener('message', (ev: MessageEvent) => {
    if (!isRpc(ev.data)) return;
    const res = ev.data as RpcResponse;
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    if (res.ok) p.resolve(res.value);
    else p.reject(new Error(res.error));
  });
  worker.addEventListener('error', (ev: ErrorEvent) => {
    fail(new Error(`Worker failed: ${ev.message || 'it could not be loaded'}`));
  });

  const call = (method: string, args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (dead) {
        reject(dead);
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const req: RpcRequest = { [RPC_TAG]: true, id, method, args };
      worker.postMessage(req, transfersOf(args));
    });

  const terminate = () => {
    worker.terminate();
    fail(new Error('Worker terminated'));
  };

  return new Proxy({} as Remote<T> & WrappedWorker, {
    get(_target, prop) {
      if (prop === 'terminate') return terminate;
      // Not a thenable: prevents `await client` from calling a remote "then".
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return (...args: unknown[]) => call(prop, args);
    },
  });
}
