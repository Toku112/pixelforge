import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { exposeApi, transfer, wrapWorker, type Endpoint } from '../../../src/workers/rpc';

/** Adapts a Node MessagePort to the subset of the DOM Worker API that wrapWorker uses. */
function fakeWorker(port: MessagePort, errorListeners: ((ev: unknown) => void)[] = []): Worker {
  return {
    postMessage: (msg: unknown, list: Transferable[]) => port.postMessage(msg, list as never),
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      if (type === 'message') port.on('message', (data: unknown) => fn({ data }));
      if (type === 'error') errorListeners.push(fn);
    },
    terminate: () => port.close(),
  } as unknown as Worker;
}

function endpoint(port: MessagePort): Endpoint {
  return {
    postMessage: (msg, list) => port.postMessage(msg, list as never),
    addEventListener: (_type, fn) => port.on('message', (data: unknown) => fn({ data } as MessageEvent)),
  };
}

const api = {
  add: (a: number, b: number) => a + b,
  async slowEcho(s: string) {
    await new Promise((r) => setTimeout(r, 5));
    return s;
  },
  fail: (): number => {
    throw new Error('boom');
  },
  fill: (buf: Uint8Array, v: number) => transfer(buf.fill(v), [buf.buffer]),
};

const open: MessagePort[] = [];
function connect() {
  const { port1, port2 } = new MessageChannel();
  open.push(port1, port2);
  exposeApi(api, endpoint(port2));
  return wrapWorker<typeof api>(fakeWorker(port1));
}

afterEach(() => {
  for (const p of open.splice(0)) p.close();
});

describe('worker RPC', () => {
  it('calls methods and returns results with types preserved', async () => {
    const client = connect();
    await expect(client.add(2, 3)).resolves.toBe(5);
    await expect(client.slowEcho('hi')).resolves.toBe('hi');
  });

  it('matches concurrent responses to the right calls', async () => {
    const client = connect();
    const results = await Promise.all([client.slowEcho('a'), client.add(1, 1), client.slowEcho('b')]);
    expect(results).toEqual(['a', 2, 'b']);
  });

  it('propagates worker errors as rejections', async () => {
    const client = connect();
    await expect(client.fail()).rejects.toThrow('boom');
  });

  it('rejects unknown methods', async () => {
    const client = connect() as unknown as { nope: () => Promise<unknown> };
    await expect(client.nope()).rejects.toThrow('Unknown worker method "nope"');
  });

  it('transfers marked buffers instead of copying them', async () => {
    const client = connect();
    const buf = new Uint8Array(1024);
    const result = await client.fill(transfer(buf, [buf.buffer]), 7);
    expect(buf.byteLength).toBe(0); // detached: ownership moved to the worker
    expect(result.length).toBe(1024);
    expect(result.every((v) => v === 7)).toBe(true);
  });

  it('rejects pending and later calls once the worker fails to load', async () => {
    const { port1, port2 } = new MessageChannel();
    open.push(port1, port2);
    const errorListeners: ((ev: unknown) => void)[] = [];
    // No exposeApi on port2: the "worker" never answers, as when its script fails to load.
    const client = wrapWorker<typeof api>(fakeWorker(port1, errorListeners));
    const pending = client.add(1, 2);
    for (const fn of errorListeners) fn({ message: 'blocked' });
    await expect(pending).rejects.toThrow('Worker failed: blocked');
    await expect(client.add(3, 4)).rejects.toThrow('Worker failed: blocked');
  });

  it('rejects calls after terminate()', async () => {
    const client = connect();
    client.terminate();
    await expect(client.add(1, 1)).rejects.toThrow('Worker terminated');
  });

  it('is not mistaken for a promise', async () => {
    const client = connect();
    const awaited = await Promise.resolve(client);
    expect(awaited).toBe(client);
  });
});
