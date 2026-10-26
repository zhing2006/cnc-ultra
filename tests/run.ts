// Browser checks. Starts its own Vite server on a free port next to one Chromium, runs the checks
// side by side and closes everything it opened.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Browser } from '@playwright/test';
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer, type Logger } from 'vite';
import type { Session } from './browser.ts';
import { checkShadowComposition } from './palette.ts';
import { checkDeviceLossRestart, checkNoWebGLFallback } from './renderer.ts';
import { checkOriginalVisuals } from './visuals.ts';
import { checkSimulation } from './simulation.ts';
import { checkCombat } from './combat.ts';
import { checkSelectionReady } from './startup.ts';
import { checkUnits } from './units.ts';
import { checkEconomy,checkTransport,checkCoordination,checkCompaction,checkFactoryOrders,checkAirProductionOrders } from './economy.ts';
import { discoverGpus, identifyGpu, launchGpu } from './gpu.ts';
import { checkMatchFoundations } from './match-foundations.ts';
import { checkMatchRendering } from './match-rendering.ts';
import { checkMatch } from './match.ts';
import { checkMatchAI } from './match-ai.ts';
import { checkNavigation } from './navigation.ts';
import { checkMatchCrew } from './match-crew.ts';
import { checkMatchRegressions } from './match-regressions.ts';
import { checkHarvest } from './harvest.ts';
import { checkComputeBatch } from './compute-batch.ts';
import { checkCampaignAssets, checkCampaignState, checkCampaignSimulation, checkCampaignScore, checkCampaignVictory, checkCampaignRules, checkCampaignMap, checkCampaignReinforcements, checkCampaignRescue, checkCampaignAI, checkCampaignAudio,checkCampaignTheaters,checkCampaignRouting,checkCampaignRendering } from './campaign.ts';
import { checkCampaignEntry,checkCampaignDevelopmentEntry } from './campaign-entry.ts';
import { checkDebug } from './debug.ts';

const started = performance.now();
const seconds = (since: number) => `${((performance.now() - since) / 1000).toFixed(1)}s`;

const serverProblems: string[] = [];
const logger: Logger = {
  info() {},
  warn(message) { serverProblems.push(message); },
  warnOnce(message) { serverProblems.push(message); },
  error(message) { serverProblems.push(message); },
  clearScreen() {},
  hasWarned: false,
  hasErrorLogged() { return false; },
};

const server = await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  customLogger: logger,
  // Keep the dependency cache apart from the dev server's.
  cacheDir: 'node_modules/.vite-tests',
  server: {
    host: '127.0.0.1',
    port: 0,
    strictPort: false,
    // The checks never edit files. Vite's config merge drops watch: null, so ignore every path instead.
    watch: { ignored: () => true },
    hmr: false,
    // Each check collects its own page's errors; forwarded copies would land here a second time.
    forwardConsole: false,
  },
});

let browser: Browser | undefined;
try {
  [browser] = await Promise.all([launchGpu(), server.listen()]);
  const address = server.httpServer?.address();
  assert(address && typeof address === 'object', 'the Vite server should listen on a TCP port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  console.log(`Isolated test server: ${baseUrl}`);
  const argument = process.argv.find(value => value.startsWith('--gpus='));
  const acceptance = process.argv.includes('--acceptance');
  const requested: (string | undefined)[] = argument ? argument.slice(7).split(',') : [undefined];
  assert(requested.every(value => value === undefined || value === 'amd' || value === 'nvidia'), 'Supported GPU choices are nvidia and amd');
  const choices = argument ? await discoverGpus(browser) : [];
  const reports: {
    gpu: Awaited<ReturnType<typeof identifyGpu>>;
    checks: number;
    failures: { check: string; error: string }[];
    seconds: number;
  }[] = [];

  const allChecks: [string, (session: Session) => Promise<void>][] = [
    ['Airstrip and helipad deliveries preserve player orders',checkAirProductionOrders],
    ['Player orders interrupt factory exits without blocking production',checkFactoryOrders],
    ['Campaign infantry death colors and hovercraft unloading order',checkCampaignRendering],
    ['Campaign threat avoidance and deterministic continuation',checkCampaignRouting],
    ['Worker decoding and bounded campaign music buffers',checkCampaignAudio],
    ['Original campaign base rebuilding and reserve production', checkCampaignAI],
    ['Campaign crate continuation and civilian evacuation', checkCampaignRescue],
    ['Original airborne reinforcement team arrival and unloading', checkCampaignReinforcements],
    ['Campaign airstrikes, events and reinforcement columns', checkCampaignRules],
    ['Original campaign country selection and branching', checkCampaignMap],
    ['Debug damage modifiers match CPU and preserve enemy damage', checkDebug],
    ['Original campaign opening, menu and first mission', checkCampaignEntry],
    ['Campaign entry with development archives only',checkCampaignDevelopmentEntry],
    ['Winter and desert campaign interfaces',checkCampaignTheaters],
    ['Campaign archive byte ranges', checkCampaignAssets],
    ['Local save files preserve simulation continuation', checkCampaignState],
    ['Campaign naval movement and first-mission continuation', checkCampaignSimulation],
    ['Original score presentation and hall of fame', checkCampaignScore],
    ['GDI first mission production, reinforcements and victory', checkCampaignVictory],
    ['Batched compute preserves uploads and readback order', checkComputeBatch],
    ['Independent house sight and fixed-tick fast-forward', checkMatchFoundations],
    ['Fixed-tick effects and deferred sprite projection', checkMatchRendering],
    ['Two AI openings, control handover and deterministic restart', checkMatch],
    ['AI production deployment and blocked construction', checkMatchAI],
    ['Reachable prefixes for sealed movement destinations', checkNavigation],
    ['Dual-house economy, capture and crew missions', checkMatchCrew],
    ['Match rule and cloak regressions', checkMatchRegressions],
    ['Refinery queue, interrupted docking and apron clearance', checkHarvest],
    [acceptance?'Full economy, aircraft, transport and building acceptance':'Tiberium, building damage and aircraft controls', checkEconomy],
    ['Reusable actor slots, laser beams and building effects',checkCompaction],
    ['Ground layer transitions and mass aircraft coordination',checkCoordination],
    ['APC passenger controls and aircraft exploration',checkTransport],
    ['loading stages and selection ready before first input', checkSelectionReady],
    ['ground combat, deterministic impacts and survivors', checkCombat],
    ['original unit movement, multiple targets, sight and controls', checkUnits],
    ['integer CPU/GPU simulation, contention and deterministic replay', checkSimulation],
    ['no WebGL fallback when the WebGPU device cannot be created', checkNoWebGLFallback],
    ['restart after the GPU device is lost while starting and while running', checkDeviceLossRestart],
    ['shadows and house colors compose like drawing each sprite in turn', checkShadowComposition],
    ['original object order, cloaking, integer zoom and the asset preview', checkOriginalVisuals],
  ];
  const only=process.argv.find(value=>value.startsWith('--only='))?.slice(7).split(',');
  const checkId=(check:(session:Session)=>Promise<void>)=>check.name.replace(/^check/,'').toLowerCase();
  if(only)assert(only.every(id=>allChecks.some(([,check])=>checkId(check)===id)),`Unknown check selection: ${only.join(',')}`);
  const checks=only?allChecks.filter(([,check])=>only.includes(checkId(check))):allChecks;
  await mkdir('test-results', { recursive: true });
  const saveReport = (complete: boolean) => writeFile('test-results/acceptance.json', JSON.stringify({
    requested: requested.map(vendor => vendor ?? 'default'), profile:acceptance?'acceptance':'daily', checks:checks.map(([,check])=>checkId(check)), complete, runs: reports,
  }, null, 2));
  await saveReport(false);
  for (const vendor of requested) {
    if (vendor !== undefined) {
      const choice = choices.find(choice => choice.vendor === vendor);
      assert(choice || process.platform !== 'win32', `No ${vendor} hardware adapter is available; milestone acceptance cannot skip it`);
      await browser.close();
      browser = await launchGpu(choice);
    }
    const gpu = await identifyGpu(browser, baseUrl, vendor);
    console.log(`GPU environment: ${JSON.stringify(gpu)}`);
    let releasePerformance!: () => void;
    let peers = checks.length - 1;
    const performanceReady = new Promise<void>(resolve => { releasePerformance = resolve; });
    if(peers===0)releasePerformance();
    const session: Session = { browser, baseUrl, gpu, performanceReady, acceptance };
    const suiteStart = Date.now();
    // Bound simultaneous shader preparation rather than stretching startup deadlines.
    // Combat may wait for the other checks before benchmarking; the other three workers keep draining the queue.
    const results: PromiseSettledResult<void>[] = new Array(checks.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, checks.length) }, async () => {
      while (next < checks.length) {
        const index = next++, [name, check] = checks[index], start = performance.now();
        try {
          await check(session);
          console.log(`ok   [${gpu.vendor}] ${name} (${seconds(start)})`);
          results[index] = { status: 'fulfilled', value: undefined };
        } catch (error) {
          console.error(`FAIL [${gpu.vendor}] ${name} (${seconds(start)})`);
          console.error(error);
          results[index] = { status: 'rejected', reason: error };
        } finally {
          if (check !== checkCombat && --peers === 0) releasePerformance();
        }
      }
    }));
    const failures = results.flatMap((result, i) => result.status === 'rejected' ? [{ check: checks[i][0], error: String(result.reason) }] : []);
    for (const failure of failures) console.error(failure);
    const directory = `test-results/${gpu.vendor}`;
    await mkdir(directory, { recursive: true });
    // Existing checks retain their stable artifact names; archive each GPU run
    // before the next one replaces them. Never copy artifacts from an older run.
    for (const file of await readdir('test-results', { withFileTypes: true })) {
      if (file.isFile() && /\.(json|png)$/.test(file.name) && (await stat(`test-results/${file.name}`)).mtimeMs >= suiteStart) {
        await copyFile(`test-results/${file.name}`, `${directory}/${file.name}`);
      }
    }
    const report = { gpu, checks: checks.length, failures, seconds: (Date.now() - suiteStart) / 1000 };
    reports.push(report);
    await writeFile(`${directory}/acceptance.json`, JSON.stringify(report, null, 2));
    await saveReport(false);
  }
  await saveReport(true);
  assert.equal(reports.reduce((sum, report) => sum + report.failures.length, 0), 0, 'GPU acceptance checks failed');
  assert.deepEqual(serverProblems, [], 'the Vite dev server should not warn or report errors');
} finally {
  try {
    await browser?.close();
  } finally {
    await server.close();
  }
}
console.log(`browser checks passed (${seconds(started)} total)`);
