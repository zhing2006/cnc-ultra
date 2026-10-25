import { expect, it } from 'vitest';
import { SimulationDriver, type SimulationScheduler } from './driver.ts';
import { CpuSimulation } from './cpu.ts';
import { gridEdges, type MoveCommand } from './state.ts';

function scheduling() {
  const tasks: (() => void)[] = [];
  let time = 0;
  const scheduler: SimulationScheduler = {
    now: () => time,
    enqueue(task) { tasks.push(task); },
    dispose() { tasks.length = 0; },
  };
  return { scheduler, tasks, cost(ms: number) { time += ms; },
    flush() { while (tasks.length) tasks.shift()!(); },
  };
}

it('runs the same numbered commands and fixed steps at 1x, 10x and 100x', () => {
  const setup = { grid: gridEdges(12, 8, new Uint8Array(96).fill(1)), seed: 1995,
    spots: [[128, 128]] as const, units: [{ cell: 13, speed: 32 }, { cell: 25, speed: 32 }],
  };
  const commands: MoveCommand[] = [{ frame: 1, target: 81 }, { frame: 60, target: 22 }];
  const expected = new CpuSimulation(setup);
  for (let i = 1; i <= 120; i++) expected.step(commands.filter(c => c.frame === i));
  for (const speed of [1, 10, 100]) {
    const simulation = new CpuSimulation(setup), schedule = scheduling();
    const driver = new SimulationDriver(15, () => simulation.step(commands.filter(c => c.frame === simulation.control[0] + 1)), schedule.scheduler);
    driver.setSpeed(speed);
    const duration = 8000 / speed;
    for (let time = 0; time < duration; time += 1000 / 60) { driver.advance(time); schedule.flush(); }
    driver.advance(duration); schedule.flush();
    expect(simulation.control[0]).toBe(120);
    expect(simulation.buffers()).toEqual(expected.buffers());
    driver.dispose();
  }
});

it('resumes on each report without waiting for another draw frame or overlapping steps', async () => {
  const schedule = scheduling(), reports: number[] = [], pending: (() => void)[] = [];
  let frame = 0;
  const driver = new SimulationDriver(15, () => {
    expect(reports.length).toBe(frame);
    const tick = ++frame;
    return new Promise<void>(resolve => pending.push(() => { reports.push(tick); resolve(); }));
  }, schedule.scheduler);
  driver.setSpeed(10);
  driver.advance(0); driver.advance(100); schedule.flush();
  expect(frame).toBe(1);
  for (let completed = 1; completed <= 15; completed++) {
    expect(pending).toHaveLength(1);
    pending.shift()!(); await Promise.resolve(); schedule.flush();
    expect(frame).toBe(Math.min(15, completed + 1));
  }
  expect(reports).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  driver.dispose();
});

it('yields expensive fast-forward slices and discards time debt on pause and speed changes', () => {
  const schedule = scheduling();
  let frame = 0;
  const driver = new SimulationDriver(15, () => { frame++; schedule.cost(1); }, schedule.scheduler);
  driver.setSpeed(100); driver.advance(0); driver.advance(100);
  schedule.tasks.shift()!();
  expect(frame).toBe(4);
  expect(schedule.tasks).toHaveLength(1);
  driver.setPaused(true); schedule.flush(); driver.advance(60000);
  expect(frame).toBe(4);
  driver.setSpeed(1); driver.setPaused(false);
  driver.advance(60000); driver.advance(60100); schedule.flush();
  expect(frame).toBe(5);
  driver.dispose();
});

it('does not resume a paused or disposed game when a previous report arrives', async () => {
  const schedule = scheduling();
  let release!: () => void, frame = 0;
  const driver = new SimulationDriver(15, () => { frame++; return new Promise<void>(resolve => { release = resolve; }); }, schedule.scheduler);
  driver.setSpeed(100); driver.advance(0); driver.advance(100); schedule.flush();
  driver.setPaused(true);
  release(); await Promise.resolve(); schedule.flush();
  expect(frame).toBe(1);
  driver.setPaused(false); driver.advance(1000); driver.advance(1100); schedule.flush();
  expect(frame).toBe(2);
  driver.dispose(); release(); await Promise.resolve(); schedule.flush();
  expect(frame).toBe(2);
});

it('surfaces an asynchronous GPU report failure instead of silently stalling', async () => {
  const schedule = scheduling(), failure = new Error('GPU report failed');
  const driver = new SimulationDriver(15, () => Promise.reject(failure), schedule.scheduler);
  driver.advance(0); driver.advance(100); schedule.flush(); await Promise.resolve();
  expect(() => driver.advance(200)).toThrow(failure);
  driver.dispose();
});

it('runs the original zero-delay speed in yielding slices, even with identical clock readings', () => {
  const schedule = scheduling(); let frames = 0;
  const driver = new SimulationDriver(15, () => { frames++; schedule.cost(1); }, schedule.scheduler);
  driver.setSpeed(Infinity); driver.advance(100); driver.advance(100);
  schedule.tasks.shift()!(); expect(frames).toBe(4); expect(schedule.tasks).toHaveLength(1);
  schedule.tasks.shift()!(); expect(frames).toBe(8);
  driver.setPaused(true); schedule.flush(); expect(frames).toBe(8); driver.dispose();
});
