import { EconomyRuntime } from '../src/game/simulation/economy-runtime.ts';
import { EconomyReport } from '../src/game/simulation/economy-report.ts';
import { runMatchSimulation } from './match-simulation-fixture.ts';

/** Time the real fixed-tick path; shader preparation and final snapshots are excluded. */
export async function measureMatchBatch(ticks: number) {
  const rows: { wallMs: number; cpuMs: number; submits: number }[] = [];
  const begin = EconomyRuntime.prototype.beginTick, read = EconomyReport.prototype.read;
  const submit = GPUQueue.prototype.submit;
  let started = 0, submits = 0;
  EconomyRuntime.prototype.beginTick = function () {
    started = performance.now(); submits = 0;
    return begin.call(this);
  };
  GPUQueue.prototype.submit = function (commands) { submits++; return submit.call(this, commands); };
  EconomyReport.prototype.read = async function () {
    const pending = read.call(this), cpuMs = performance.now() - started, count = submits;
    const result = await pending;
    if (this.battle.frame > 100) rows.push({ wallMs: performance.now() - started, cpuMs, submits: count });
    return result;
  };
  try {
    const result = await runMatchSimulation({ seed: 1995, ticks, captureState: true });
    const summarize = (values: number[]) => {
      values.sort((a, b) => a - b);
      return { mean: values.reduce((a, b) => a + b, 0) / values.length,
        p50: values[Math.floor(values.length / 2)], p95: values[Math.floor(values.length * .95)] };
    };
    return {
      samples: rows.length, wallMs: summarize(rows.map(r => r.wallMs)),
      cpuMs: summarize(rows.map(r => r.cpuMs)), submits: summarize(rows.map(r => r.submits)),
      snapshot: { frame: result.frame, state: result.state, actors: result.actors, houses: result.houses,
        structures: result.structures, orders: result.orders, outcome: result.outcome },
    };
  } finally {
    EconomyRuntime.prototype.beginTick = begin; EconomyReport.prototype.read = read;
    GPUQueue.prototype.submit = submit;
  }
}
