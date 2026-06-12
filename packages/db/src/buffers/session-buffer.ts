import { getSafeJson } from '@openpanel/json';
import { getRedisCache, type Redis } from '@openpanel/redis';
import { assocPath, clone } from 'ramda';
import { ch, TABLE_NAMES } from '../clickhouse/client';
import type { IClickhouseEvent } from '../services/event.service';
import type { IClickhouseSession } from '../services/session.service';
import { BaseBuffer } from './base-buffer';

export class SessionBuffer extends BaseBuffer {
  private batchSize = process.env.SESSION_BUFFER_BATCH_SIZE
    ? Number.parseInt(process.env.SESSION_BUFFER_BATCH_SIZE, 10)
    : 1000;
  private chunkSize = process.env.SESSION_BUFFER_CHUNK_SIZE
    ? Number.parseInt(process.env.SESSION_BUFFER_CHUNK_SIZE, 10)
    : 1000;

  private readonly squashEnabled =
    process.env.SESSION_BUFFER_SQUASH !== 'false' &&
    process.env.SESSION_BUFFER_SQUASH !== '0';

  private readonly redisKey = 'session-buffer';
  private redis: Redis;
  constructor() {
    super({
      name: 'session',
      onFlush: async () => {
        await this.processBuffer();
      },
    });
    this.redis = getRedisCache();
  }

  public async getExistingSession(
    options:
      | {
          sessionId: string;
        }
      | {
          projectId: string;
          profileId: string;
        }
  ) {
    let hit: string | null = null;
    if ('sessionId' in options) {
      hit = await this.redis.get(`session:${options.sessionId}`);
    } else {
      const value = await this.redis.get(
        `session:${options.projectId}:${options.profileId}`
      );
      if (!value) {
        return null;
      }

      // Backward compat: old keys stored full JSON, new keys store just the sessionId
      if (value.startsWith('{')) {
        return getSafeJson<IClickhouseSession>(value);
      }

      hit = await this.redis.get(`session:${value}`);
    }

    if (hit) {
      return getSafeJson<IClickhouseSession>(hit);
    }

    return null;
  }

  async getSession(
    event: IClickhouseEvent
  ): Promise<[IClickhouseSession] | [IClickhouseSession, IClickhouseSession]> {
    const existingSession = await this.getExistingSession({
      sessionId: event.session_id,
    });

    if (existingSession) {
      const oldSession = assocPath(['sign'], -1, clone(existingSession));
      const newSession = assocPath(['sign'], 1, clone(existingSession));

      newSession.version = existingSession.version + 1;

      // Events can arrive out of order (client-side batching, retries, offline
      // queueing). Treat the session window as [min(event ts), max(event ts)]
      // so duration stays non-negative and entry/exit reflect actual order.
      const eventTime = new Date(event.created_at).getTime();
      const startTime = new Date(newSession.created_at).getTime();
      const endTime = new Date(newSession.ended_at).getTime();

      if (eventTime >= endTime) {
        newSession.ended_at = event.created_at;
        if (event.path) {
          newSession.exit_path = event.path;
        }
        if (event.origin) {
          newSession.exit_origin = event.origin;
        }
      }

      if (eventTime < startTime) {
        newSession.created_at = event.created_at;
        if (event.path) {
          newSession.entry_path = event.path;
        }
        if (event.origin) {
          newSession.entry_origin = event.origin;
        }
      } else {
        if (!newSession.entry_path && event.path) {
          newSession.entry_path = event.path;
        }
        if (!newSession.entry_origin && event.origin) {
          newSession.entry_origin = event.origin;
        }
      }

      newSession.duration =
        new Date(newSession.ended_at).getTime() -
        new Date(newSession.created_at).getTime();

      const addedRevenue = event.name === 'revenue' ? (event.revenue ?? 0) : 0;
      newSession.revenue = (newSession.revenue ?? 0) + addedRevenue;

      if (event.name === 'screen_view' && event.path) {
        newSession.screen_view_count += 1;
      } else {
        newSession.event_count += 1;
      }

      if (newSession.screen_view_count > 1) {
        newSession.is_bounce = false;
      }

      // If the profile_id is set and it's different from the device_id, we need to update the profile_id
      if (event.profile_id && event.profile_id !== event.device_id) {
        newSession.profile_id = event.profile_id;
      }

      if (event.groups) {
        newSession.groups = [
          ...new Set([...(newSession.groups ?? []), ...event.groups]),
        ];
      }

      return [newSession, oldSession];
    }

    return [
      {
        id: event.session_id,
        is_bounce: true,
        profile_id: event.profile_id,
        project_id: event.project_id,
        device_id: event.device_id,
        groups: event.groups,
        created_at: event.created_at,
        ended_at: event.created_at,
        event_count: event.name === 'screen_view' ? 0 : 1,
        screen_view_count: event.name === 'screen_view' ? 1 : 0,
        entry_path: event.path,
        entry_origin: event.origin,
        exit_path: event.path,
        exit_origin: event.origin,
        revenue: event.name === 'revenue' ? (event.revenue ?? 0) : 0,
        referrer: event.referrer,
        referrer_name: event.referrer_name,
        referrer_type: event.referrer_type,
        os: event.os,
        os_version: event.os_version,
        browser: event.browser,
        browser_version: event.browser_version,
        device: event.device,
        brand: event.brand,
        model: event.model,
        country: event.country,
        region: event.region,
        city: event.city,
        longitude: event.longitude ?? null,
        latitude: event.latitude ?? null,
        duration: event.duration,
        utm_medium: event.properties?.['__query.utm_medium']
          ? String(event.properties?.['__query.utm_medium'])
          : '',
        utm_source: event.properties?.['__query.utm_source']
          ? String(event.properties?.['__query.utm_source'])
          : '',
        utm_campaign: event.properties?.['__query.utm_campaign']
          ? String(event.properties?.['__query.utm_campaign'])
          : '',
        utm_content: event.properties?.['__query.utm_content']
          ? String(event.properties?.['__query.utm_content'])
          : '',
        utm_term: event.properties?.['__query.utm_term']
          ? String(event.properties?.['__query.utm_term'])
          : '',
        sign: 1,
        version: 1,
      },
    ];
  }

  protected getRedisListKey(): string {
    return this.redisKey;
  }

  async add(event: IClickhouseEvent) {
    if (!event.session_id) {
      return;
    }

    if (['session_start', 'session_end'].includes(event.name)) {
      return;
    }

    return this.timeAdd(async () => {
      try {
        // Plural since we will delete the old session with sign column
        const sessions = await this.getSession(event);
        const [newSession] = sessions;

        const multi = this.redis.multi();
        multi.set(
          `session:${newSession.id}`,
          JSON.stringify(newSession),
          'EX',
          60 * 60
        );
        if (newSession.profile_id) {
          multi.set(
            `session:${newSession.project_id}:${newSession.profile_id}`,
            newSession.id,
            'EX',
            60 * 60
          );
        }
        // Push the whole (-1, +1) pair as ONE list entry. The flush consumes
        // the queue in batchSize slices; with one row per entry a slice
        // boundary could land between a pair's two rows and split it across
        // two flushes. Combined with the old boundary-row squash, that left
        // permanently unbalanced sign rows in ClickHouse. One entry per
        // add() makes the pair atomic: no batch boundary can split it.
        multi.rpush(this.redisKey, JSON.stringify(sessions));
        // Append LLEN at the end so we can read ground-truth queue length
        // from the exec result without an extra round-trip.
        multi.llen(this.redisKey);
        const result = await multi.exec();

        const llenIndex = (result?.length ?? 1) - 1;
        const bufferLength = (result?.[llenIndex]?.[1] as number) ?? 0;

        if (bufferLength >= this.batchSize) {
          await this.tryFlush({ trigger: 'add' });
        }
      } catch (error) {
        this.logger.error({ err: error }, 'Failed to add session');
      }
    });
  }

  /**
   * Collapse a batch of session rows to the minimal multiset that is
   * algebraically equivalent under VersionedCollapsingMergeTree: group by
   * (id, version), sum the signs, and emit only the non-zero groups.
   * Versions whose -1 and +1 rows are both in the batch net to zero and
   * are dropped; what remains is, per session, the cancel of the state a
   * previous flush inserted (when an update chain spans flushes) and the
   * newest state. Inserting the netted rows is equivalent to inserting
   * every row — for any downstream sum(sign...) query and for merge-time
   * collapsing — because it is pure sign algebra, independent of row
   * order and batch boundaries.
   *
   * This replaces the previous oldest(-1)/newest(+1) heuristic, which
   * assumed the batch's oldest -1 always cancelled a row some earlier
   * flush had inserted. When the row it actually cancelled sat in the
   * SAME batch (a session created and updated within one flush window),
   * or had been dropped by the squash of a previous batch (a pair torn
   * across a batch boundary), the emitted -1 cancelled nothing. Those
   * orphan cancel rows permanently skew every sum(sign * ...) metric —
   * pageviews, session counts, bounce rate — increasingly negative.
   */
  private netSessionRows(rows: IClickhouseSession[]): IClickhouseSession[] {
    if (rows.length <= 1) {
      return rows;
    }

    const groups = new Map<string, { row: IClickhouseSession; net: number }>();
    for (const row of rows) {
      const key = `${row.id} ${row.version}`;
      const group = groups.get(key);
      if (group) {
        group.net += row.sign;
      } else {
        groups.set(key, { row, net: row.sign });
      }
    }

    const out: IClickhouseSession[] = [];
    for (const { row, net } of groups.values()) {
      if (net === 0) {
        continue;
      }
      const sign = net > 0 ? 1 : -1;
      // |net| > 1 only happens when the same (id, version, sign) row was
      // enqueued more than once (e.g. a re-queued chunk whose insert had
      // actually landed); emit |net| copies so the multiset stays exact.
      for (let i = 0; i < Math.abs(net); i++) {
        out.push(row.sign === sign ? row : { ...row, sign });
      }
    }

    if (out.length < rows.length) {
      this.logger.debug(
        {
          inputRows: rows.length,
          outputRows: out.length,
          dropped: rows.length - out.length,
        },
        'Session batch netted'
      );
    }

    return out;
  }

  /**
   * Consume the queue head and insert the rows into ClickHouse.
   *
   * Mirrors the event-buffer's consume pattern:
   *
   *   - LPOP with COUNT atomically claims the head — there is no
   *     LRANGE/LTRIM window, so a partial chunk failure can never cause
   *     the next flush to re-insert chunks that already landed in CH.
   *   - Each chunk inserts independently (settled semantics) under the
   *     chInsertConcurrency cap; failed chunks are re-queued at the head
   *     and retried on the next flush.
   *   - Any unexpected throw re-queues everything still in flight in the
   *     finally block, so a bug in our own code cannot lose rows.
   *
   * Queue entries are JSON arrays holding one add()'s rows — the (-1, +1)
   * pair of a session update, or the single +1 of a new session — so a
   * batch boundary can never separate a pair. Entries written by older
   * builds (one row per entry) are consumed transparently.
   *
   * A single high-activity session can produce many (-1, +1) pairs within
   * one flush window. The VersionedCollapsingMergeTree on `sessions`
   * would collapse them at merge time, but inserting all the intermediate
   * rows costs network bytes, gzip CPU, CH ingest and merge work — so we
   * net them out per (id, version) first (see netSessionRows). Set
   * SESSION_BUFFER_SQUASH=false to disable as a safety hatch.
   */
  async processBuffer() {
    const popStart = performance.now();
    // ioredis LPOP with COUNT returns string[] | null
    const popped = (await this.redis.lpop(this.redisKey, this.batchSize)) as
      | string[]
      | null;
    const popMs = performance.now() - popStart;

    if (!popped || popped.length === 0) {
      this.reportFlushStats({ rowsProcessed: 0, phases: { lrangeMs: popMs } });
      return;
    }

    // Entries held in-flight by this worker. Re-queued in the finally
    // block if anything throws before success/failure is partitioned.
    let inFlight: string[] = popped;

    try {
      const parsed: IClickhouseSession[] = [];
      for (const raw of popped) {
        const entry = getSafeJson<IClickhouseSession | IClickhouseSession[]>(
          raw
        );
        if (!entry) {
          continue;
        }
        for (const session of Array.isArray(entry) ? entry : [entry]) {
          parsed.push({
            ...session,
            duration: Math.max(0, session.duration || 0),
          });
        }
      }

      const sessions = this.squashEnabled
        ? this.netSessionRows(parsed)
        : parsed;

      const chStart = performance.now();
      const chunks = this.chunks(sessions, this.chunkSize);
      const results: PromiseSettledResult<unknown>[] = new Array(
        chunks.length
      );
      let nextChunkIdx = 0;
      const insertWorker = async (): Promise<void> => {
        while (true) {
          const idx = nextChunkIdx++;
          if (idx >= chunks.length) {
            return;
          }
          try {
            const value = await ch.insert({
              table: TABLE_NAMES.sessions,
              values: chunks[idx]!,
              format: 'JSONEachRow',
              clickhouse_settings: this.getClickhouseSettings(),
            });
            results[idx] = { status: 'fulfilled', value };
          } catch (err) {
            results[idx] = { status: 'rejected', reason: err };
          }
        }
      };
      const workerCount = Math.max(
        1,
        Math.min(this.chInsertConcurrency, chunks.length)
      );
      await Promise.all(
        Array.from({ length: workerCount }, () => insertWorker())
      );
      const chInsertMs = performance.now() - chStart;

      const failedChunks: IClickhouseSession[][] = [];
      let firstError: unknown = null;
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        if (r.status === 'rejected') {
          failedChunks.push(chunks[i]!);
          if (firstError === null) {
            firstError = r.reason;
          }
        }
      }

      // Only failed rows stay in flight — succeeded chunks are committed
      // to CH and must not be re-queued. Each failed chunk is re-queued
      // as one array entry (the same format add() writes); already-netted
      // rows net to themselves on the retry flush.
      inFlight = failedChunks.map((chunk) => JSON.stringify(chunk));

      const failedRowCount = failedChunks.reduce((n, c) => n + c.length, 0);
      if (failedRowCount > 0) {
        this.logger.warn(
          {
            failedChunkCount: failedChunks.length,
            failedRowCount,
            successRowCount: sessions.length - failedRowCount,
            firstError,
          },
          'Partial CH insert failure; failed chunks re-queued at head'
        );
      }

      this.reportFlushStats({
        rowsProcessed: sessions.length - failedRowCount,
        phases: { lrangeMs: popMs, chInsertMs },
      });

      if (firstError !== null) {
        // Surface the flush failure to tryFlush (which records an errored
        // flush observation). The finally block below has already
        // re-queued the failed chunks by the time this propagates.
        throw firstError;
      }
    } finally {
      // ALWAYS re-queue entries still in flight (failed chunks OR an
      // unexpected mid-flush throw). LPUSH with multiple values inserts
      // them in reverse order, so we reverse the array to preserve the
      // original queue order at the head.
      if (inFlight.length > 0) {
        try {
          await this.redis.lpush(this.redisKey, ...inFlight.slice().reverse());
        } catch (requeueErr) {
          // If even the re-queue fails, log loudly — rows are LOST.
          this.logger.error(
            { err: requeueErr, lostEntryCount: inFlight.length },
            'CRITICAL: failed to re-queue sessions to Redis — rows LOST'
          );
        }
      }
    }
  }
}
