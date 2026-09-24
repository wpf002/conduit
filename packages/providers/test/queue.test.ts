import { describe, expect, it } from 'vitest';
import { AsyncQueue } from '../src/queue.js';

async function take<T>(source: AsyncIterable<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) {
    out.push(item);
    if (out.length === n) break;
  }
  return out;
}

describe('AsyncQueue', () => {
  it('delivers items pushed before the consumer starts iterating', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.end();
    expect(await take(q, 2)).toEqual([1, 2]);
  });

  it('delivers items pushed after the consumer is already waiting', async () => {
    const q = new AsyncQueue<number>();
    const pending = take(q, 2);
    setTimeout(() => {
      q.push(10);
      q.push(20);
    }, 5);
    expect(await pending).toEqual([10, 20]);
  });

  it('drops the oldest items past the high water mark instead of growing without bound', () => {
    const q = new AsyncQueue<number>({ highWaterMark: 3 });
    for (let i = 0; i < 10; i += 1) q.push(i);
    expect(q.size).toBe(3);
    expect(q.dropped).toBe(7);
  });

  it('keeps the newest items when dropping', async () => {
    const q = new AsyncQueue<number>({ highWaterMark: 2 });
    for (const i of [1, 2, 3, 4]) q.push(i);
    q.end();
    const out: number[] = [];
    for await (const item of q) out.push(item);
    expect(out).toEqual([3, 4]);
  });

  it('throws the failure into the consumer', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.fail(new Error('key revoked'));
    await expect(async () => {
      for await (const _ of q) {
        /* drain */
      }
    }).rejects.toThrow('key revoked');
  });

  it('rejects a consumer that is already waiting when the failure arrives', async () => {
    const q = new AsyncQueue<number>();
    const pending = (async () => {
      for await (const _ of q) {
        /* wait */
      }
    })();
    setTimeout(() => q.fail(new Error('socket gone')), 5);
    await expect(pending).rejects.toThrow('socket gone');
  });

  it('ends cleanly and ignores pushes after the end', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.end();
    q.push(2);
    const out: number[] = [];
    for await (const item of q) out.push(item);
    expect(out).toEqual([1]);
    expect(q.ended).toBe(true);
  });

  it('is idempotent on end and fail', () => {
    const q = new AsyncQueue<number>();
    q.end();
    expect(() => {
      q.end();
      q.fail(new Error('ignored'));
    }).not.toThrow();
  });
});
