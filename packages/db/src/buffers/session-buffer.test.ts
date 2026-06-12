import { getRedisCache } from '@openpanel/redis';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ch } from '../clickhouse/client';

vi.mock('../clickhouse/client', () => ({
  ch: {
    insert: vi.fn().mockResolvedValue(undefined),
  },
  TABLE_NAMES: {
    sessions: 'sessions',
  },
}));

import { SessionBuffer } from './session-buffer';
import type { IClickhouseEvent } from '../services/event.service';

const redis = getRedisCache();

function makeEvent(overrides: Partial<IClickhouseEvent>): IClickhouseEvent {
  return {
    id: 'event-1',
    project_id: 'project-1',
    profile_id: 'profile-1',
    device_id: 'device-1',
    session_id: 'session-1',
    name: 'screen_view',
    path: '/home',
    origin: '',
    referrer: '',
    referrer_name: '',
    referrer_type: '',
    duration: 0,
    properties: {},
    created_at: new Date().toISOString(),
    groups: [],
    ...overrides,
  } as IClickhouseEvent;
}

beforeEach(async () => {
  const keys = [
    ...await redis.keys('session*'),
    ...await redis.keys('lock:session'),
  ];
  if (keys.length > 0) await redis.del(...keys);
  vi.mocked(ch.insert).mockClear();
  vi.mocked(ch.insert).mockResolvedValue(undefined as any);
});

/** All rows passed to ch.insert across every call (including failed calls). */
function insertedRows(): any[] {
  return vi
    .mocked(ch.insert)
    .mock.calls.flatMap((call) => (call[0] as any).values as any[]);
}

afterAll(async () => {
  try {
    await redis.quit();
  } catch {}
});

describe('SessionBuffer', () => {
  let sessionBuffer: SessionBuffer;

  beforeEach(() => {
    sessionBuffer = new SessionBuffer();
  });

  it('adds a new session to the buffer', async () => {
    const sizeBefore = await sessionBuffer.getBufferSize();
    await sessionBuffer.add(makeEvent({}));
    const sizeAfter = await sessionBuffer.getBufferSize();

    expect(sizeAfter).toBe(sizeBefore + 1);
  });

  it('skips session_start and session_end events', async () => {
    const sizeBefore = await sessionBuffer.getBufferSize();
    await sessionBuffer.add(makeEvent({ name: 'session_start' }));
    await sessionBuffer.add(makeEvent({ name: 'session_end' }));
    const sizeAfter = await sessionBuffer.getBufferSize();

    expect(sizeAfter).toBe(sizeBefore);
  });

  it('updates existing session on subsequent events', async () => {
    const t0 = Date.now();
    await sessionBuffer.add(makeEvent({ created_at: new Date(t0).toISOString() }));

    // Second event updates the same session — emits old (sign=-1) + new
    // (sign=1) as ONE atomic queue entry, so a flush batch boundary can
    // never split the pair across two flushes.
    const sizeBefore = await sessionBuffer.getBufferSize();
    await sessionBuffer.add(makeEvent({ created_at: new Date(t0 + 5000).toISOString() }));
    const sizeAfter = await sessionBuffer.getBufferSize();

    expect(sizeAfter).toBe(sizeBefore + 1);

    const entries = await redis.lrange('session-buffer', 0, -1);
    const pair = JSON.parse(entries[1]!);
    expect(pair.map((r: any) => [r.sign, r.version])).toEqual([
      [1, 2],
      [-1, 1],
    ]);
  });

  it('processes buffer and inserts sessions into ClickHouse', async () => {
    await sessionBuffer.add(makeEvent({}));

    const insertSpy = vi
      .spyOn(ch, 'insert')
      .mockResolvedValueOnce(undefined as any);

    await sessionBuffer.processBuffer();

    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ table: 'sessions', format: 'JSONEachRow' })
    );
    expect(await sessionBuffer.getBufferSize()).toBe(0);

    insertSpy.mockRestore();
  });

  it('retains sessions in queue when ClickHouse insert fails', async () => {
    await sessionBuffer.add(makeEvent({}));

    const insertSpy = vi
      .spyOn(ch, 'insert')
      .mockRejectedValueOnce(new Error('ClickHouse unavailable'));

    // Errors now propagate to tryFlush (which handles them by resyncing the
    // counter). processBuffer no longer swallows — we still verify the
    // safety property: the queue is preserved.
    await expect(sessionBuffer.processBuffer()).rejects.toThrow(
      'ClickHouse unavailable',
    );
    expect(await sessionBuffer.getBufferSize()).toBe(1);

    insertSpy.mockRestore();
  });

  it('retries re-queued rows on the next flush after a failure', async () => {
    await sessionBuffer.add(makeEvent({}));

    vi.mocked(ch.insert).mockRejectedValueOnce(new Error('boom'));
    await expect(sessionBuffer.processBuffer()).rejects.toThrow('boom');
    expect(await sessionBuffer.getBufferSize()).toBe(1);

    await sessionBuffer.processBuffer();

    expect(await sessionBuffer.getBufferSize()).toBe(0);
    const lastCall = vi.mocked(ch.insert).mock.calls.at(-1)!;
    const rows = (lastCall[0] as any).values as any[];
    expect(rows.map((r) => [r.sign, r.version])).toEqual([[1, 1]]);
  });

  it('nets a same-batch create + update chain down to the final state row', async () => {
    const t0 = Date.now();
    await sessionBuffer.add(makeEvent({ created_at: new Date(t0).toISOString() }));
    await sessionBuffer.add(makeEvent({ created_at: new Date(t0 + 1000).toISOString(), path: '/a' }));
    await sessionBuffer.add(makeEvent({ created_at: new Date(t0 + 2000).toISOString(), path: '/b' }));

    await sessionBuffer.processBuffer();

    // Queue rows: +1v1, (+1v2, -1v1), (+1v3, -1v2) — every version's signs
    // cancel except the final +1v3. The old boundary squash emitted an
    // orphan -1v1 here (its +1v1 was dropped from the same batch), which
    // permanently skewed sum(sign * ...) metrics negative.
    const rows = insertedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sign: 1,
      version: 3,
      screen_view_count: 3,
    });
    expect(await sessionBuffer.getBufferSize()).toBe(0);
  });

  it('emits a matched cancel + new state when a chain spans two flushes', async () => {
    const t0 = Date.now();
    await sessionBuffer.add(makeEvent({ created_at: new Date(t0).toISOString() }));
    await sessionBuffer.processBuffer();

    await sessionBuffer.add(makeEvent({ created_at: new Date(t0 + 1000).toISOString(), path: '/a' }));
    await sessionBuffer.processBuffer();

    const calls = vi.mocked(ch.insert).mock.calls;
    expect(calls).toHaveLength(2);
    const firstRows = (calls[0]![0] as any).values as any[];
    expect(firstRows.map((r) => [r.sign, r.version])).toEqual([[1, 1]]);
    const secondRows = ((calls[1]![0] as any).values as any[])
      .slice()
      .sort((a, b) => a.version - b.version || a.sign - b.sign);
    expect(secondRows.map((r) => [r.sign, r.version])).toEqual([
      [-1, 1],
      [1, 2],
    ]);

    // Across both flushes the inserted multiset nets to exactly one live
    // row — the +1 at version 2.
    const net = new Map<number, number>();
    for (const r of insertedRows()) {
      net.set(r.version, (net.get(r.version) ?? 0) + r.sign);
    }
    expect([...net.entries()].filter(([, n]) => n !== 0)).toEqual([[2, 1]]);
  });

  it('consumes legacy single-row queue entries', async () => {
    const t0 = Date.now();
    await sessionBuffer.add(makeEvent({ created_at: new Date(t0).toISOString() }));

    // Rewrite the queue the way pre-pair builds wrote it: one row per entry.
    const [pairEntry] = ((await redis.lpop('session-buffer', 1)) ?? []) as string[];
    const rows = JSON.parse(pairEntry!) as any[];
    for (const row of rows) {
      await redis.rpush('session-buffer', JSON.stringify(row));
    }

    await sessionBuffer.processBuffer();

    expect(insertedRows().map((r) => [r.sign, r.version])).toEqual([[1, 1]]);
    expect(await sessionBuffer.getBufferSize()).toBe(0);
  });

  it('inserts raw rows when SESSION_BUFFER_SQUASH=false', async () => {
    process.env.SESSION_BUFFER_SQUASH = 'false';
    try {
      const rawBuffer = new SessionBuffer();
      const t0 = Date.now();
      await rawBuffer.add(makeEvent({ created_at: new Date(t0).toISOString() }));
      await rawBuffer.add(makeEvent({ created_at: new Date(t0 + 1000).toISOString() }));

      await rawBuffer.processBuffer();

      const rows = insertedRows()
        .slice()
        .sort((a, b) => a.version - b.version || a.sign - b.sign);
      expect(rows.map((r) => [r.sign, r.version])).toEqual([
        [-1, 1],
        [1, 1],
        [1, 2],
      ]);
    } finally {
      delete process.env.SESSION_BUFFER_SQUASH;
    }
  });
});
