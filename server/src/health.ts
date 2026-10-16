/**
 * How Pixel itself is doing, one sample a minute for the last day (in memory; a restart starts over):
 * event-loop lag (anything that blocks the one thread shows here first), API request times, fleet
 * update times, database writes and size, Pixel's memory and CPU, and how many tabs are connected.
 */
import { config } from "./config.ts";
import { db } from "./db.ts";

export interface HealthSample {
  t: number;
  /** Event-loop lag over the minute, ms: worst and average. */
  lagMax: number;
  lagAvg: number;
  /** API requests: how many, and the slowest, ms. */
  requests: number;
  requestMax: number;
  /** Slowest fleet update (the Wall's state), ms. */
  fleetMax: number;
  /** Rows written by statements (not by triggers) during the minute. */
  writes: number;
  dbBytes: number;
  walBytes: number;
  rss: number;
  /** Pixel's CPU over the minute, percent of one core. */
  cpu: number;
  tabs: number;
}

const KEEP = 24 * 60;
const samples: HealthSample[] = [];
const minute = { lags: [] as number[], requests: 0, requestMax: 0, fleetMax: 0 };
let tabs = () => 0;
let lastWrites = 0;
let lastCpu = process.cpuUsage();
let lastAt = Date.now();
let timers: Timer[] = [];

export const recordRequest = (ms: number) => {
  minute.requests++;
  minute.requestMax = Math.max(minute.requestMax, ms);
};
export const recordFleetUpdate = (ms: number) => void (minute.fleetMax = Math.max(minute.fleetMax, ms));

const totalChanges = () => db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;

function sample() {
  const now = Date.now();
  const cpu = process.cpuUsage(lastCpu);
  const writes = totalChanges();
  const lags = minute.lags;
  samples.push({
    t: now,
    lagMax: lags.length ? Math.max(...lags) : 0,
    lagAvg: lags.length ? lags.reduce((a, b) => a + b, 0) / lags.length : 0,
    requests: minute.requests,
    requestMax: minute.requestMax,
    fleetMax: minute.fleetMax,
    writes: writes - lastWrites,
    dbBytes: Bun.file(config.dbPath).size,
    walBytes: Bun.file(`${config.dbPath}-wal`).size,
    rss: process.memoryUsage().rss,
    cpu: ((cpu.user + cpu.system) / 1000 / Math.max(1, now - lastAt)) * 100,
    tabs: tabs(),
  });
  if (samples.length > KEEP) samples.shift();
  Object.assign(minute, { lags: [], requests: 0, requestMax: 0, fleetMax: 0 });
  lastWrites = writes;
  lastCpu = process.cpuUsage();
  lastAt = now;
}

/** `countTabs`: open dashboard websockets. */
export function startHealth(countTabs: () => number) {
  if (timers.length) return;
  tabs = countTabs;
  lastWrites = totalChanges();
  // A 1 s timer that fires late by N ms means the thread was busy for N ms.
  let expected = Date.now() + 1000;
  timers = [
    setInterval(() => {
      minute.lags.push(Math.max(0, Date.now() - expected));
      expected = Date.now() + 1000;
    }, 1000),
    setInterval(sample, 60_000),
  ];
}

export function healthSamples() {
  return { samples, now: { tabs: tabs(), rss: process.memoryUsage().rss, dbBytes: Bun.file(config.dbPath).size, walBytes: Bun.file(`${config.dbPath}-wal`).size } };
}
export type PixelHealth = ReturnType<typeof healthSamples>;
