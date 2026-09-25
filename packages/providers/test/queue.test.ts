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

describe('overflow signalling', () => {
  it('reports once when dropping starts, not once per dropped item', () => {
    const overflows: number[] = [];
    const q = new AsyncQueue<number>({
      highWaterMark: 3,
      onOverflow: (info) => overflows.push(info.droppedThisEpisode),
    });
    for (let i = 0; i < 20; i += 1) q.push(i);
    expect(q.dropped).toBe(17);
    // One signal for the whole episode. 17 control messages would be noise, and the 17th would
    // itself be dropped.
    expect(overflows).toEqual([1]);
    expect(q.overflowing).toBe(true);
  });

  it('carries the numbers a consumer needs to act', () => {
    let info: { droppedTotal: number; buffered: number; highWaterMark: number } | undefined;
    const q = new AsyncQueue<number>({ highWaterMark: 2, onOverflow: (i) => (info = i) });
    for (let i = 0; i < 5; i += 1) q.push(i);
    expect(info).toMatchObject({ droppedTotal: 1, buffered: 2, highWaterMark: 2 });
  });

  it('reports recovery once the buffer drains to half, not to the mark itself', async () => {
    const events: string[] = [];
    const q = new AsyncQueue<number>({
      highWaterMark: 4,
      onOverflow: () => events.push('overflow'),
      onRecover: () => events.push('recover'),
    });
    for (let i = 0; i < 10; i += 1) q.push(i);
    expect(events).toEqual(['overflow']);

    const iterator = q[Symbol.asyncIterator]();
    // Draining to 3 is still above half of 4; recovery waits until 2.
    await iterator.next();
    expect(events).toEqual(['overflow']);
    await iterator.next();
    expect(events).toEqual(['overflow', 'recover']);
    expect(q.overflowing).toBe(false);
  });

  it('starts a new episode after recovery', async () => {
    const events: string[] = [];
    const q = new AsyncQueue<number>({
      highWaterMark: 2,
      onOverflow: () => events.push('overflow'),
      onRecover: () => events.push('recover'),
    });
    for (let i = 0; i < 5; i += 1) q.push(i);
    const iterator = q[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    expect(events).toEqual(['overflow', 'recover']);

    for (let i = 0; i < 5; i += 1) q.push(i);
    expect(events).toEqual(['overflow', 'recover', 'overflow']);
  });

  it('counts each episode separately', async () => {
    const episodes: number[] = [];
    const q = new AsyncQueue<number>({
      highWaterMark: 2,
      onOverflow: () => {},
      onRecover: (info) => episodes.push(info.droppedThisEpisode),
    });
    for (let i = 0; i < 6; i += 1) q.push(i);
    const iterator = q[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    expect(episodes).toEqual([4]);
  });

  it('pushUrgent survives continued pressure, and is delivered first', async () => {
    const q = new AsyncQueue<number>({ highWaterMark: 2 });
    for (let i = 0; i < 5; i += 1) q.push(i);
    q.pushUrgent(999);
    // Pressure continues. Appending to the buffer would have evicted the notice within two pushes.
    for (let i = 0; i < 20; i += 1) q.push(i);

    const iterator = q[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe(999);
  });

  it('pushUrgent goes straight to a waiting consumer', async () => {
    const q = new AsyncQueue<number>({ highWaterMark: 2 });
    const pending = q[Symbol.asyncIterator]().next();
    q.pushUrgent(42);
    expect((await pending).value).toBe(42);
  });

  it('ignores pushUrgent after the queue has ended', () => {
    const q = new AsyncQueue<number>({ highWaterMark: 2 });
    q.end();
    expect(() => q.pushUrgent(1)).not.toThrow();
    expect(q.size).toBe(0);
  });
});
