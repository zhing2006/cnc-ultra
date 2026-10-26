export async function compareSimulation() {
  const { createRenderer } = await import('../src/engine/renderer.ts');
  const { GpuSimulation } = await import('../src/engine/simulation/gpu.ts');
  const { CpuSimulation } = await import('../src/engine/simulation/cpu.ts');
  const { checksum } = await import('../src/engine/simulation/fixed.ts');
  const { GpuChecksum } = await import('../src/engine/simulation/checksum.ts');
  const { gridEdges } = await import('../src/engine/simulation/state.ts');
  const { bubbleGround, groundLayout, updateGroundKeys, groundSprites, GpuGround } = await import('../src/game/simulation/ground.ts');
  const { simulationScene } = await import('../src/demo/simulation-scene.ts');
  const { readScenario } = await import('../src/game/formats/scenario.ts');
  const { buildScene } = await import('../src/game/scene.ts');
  const { loadData } = await import('../src/game/data-files.ts');
  const { PalettePipeline } = await import('../src/engine/indexed/pipeline.ts');
  const { paint } = await import('../tests/reference/paint.ts');
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:16px;height:16px';
  document.body.append(canvas);
  const renderer = await createRenderer(canvas, { onDeviceLost: message => console.error(message) });
  if (!renderer) throw new Error('no WebGPU');
  const failures: string[] = [];
  const equal = (a: ArrayLike<number>, b: ArrayLike<number>, label: string) => {
    const at = Array.from(a).findIndex((value, i) => value !== b[i]);
    if (a.length !== b.length || at >= 0) failures.push(`${label}: word ${at}: ${a[at]} != ${b[at]}`);
  };
  try {
    for (const mode of ['vehicles', 'infantry', 'mixed']) {
      const width = mode === 'mixed' ? 73 : 29, height = 19, passable = new Uint8Array(width * height).fill(1);
      for (let y = 2; y < 16; y++) if (y !== 10) passable[y * width + 14] = 0;
      const setup = { grid: gridEdges(width, height, passable), seed: 0x123456,
        spots: [[128,128],[64,64],[192,64],[64,192],[192,192]] as [number,number][],
        units: Array.from({length: 96}, (_, i) => ({cell: Math.floor(i / 12) * width + i % 12, speed: 48,
          kind: mode === 'infantry' || (mode === 'mixed' && i % 3 !== 0) ? 1 : 0})) };
      const cpu = new CpuSimulation(setup), gpu = new GpuSimulation(renderer.three, setup), replay = new GpuSimulation(renderer.three, setup);
      try {
        for (let frame = 1; frame <= 90; frame++) {
          const commands = [1,20,45].includes(frame) ? [{ frame, target: (frame === 45 ? height - 2 : 9) * width + width - 4 }] : [];
          cpu.step(commands); gpu.step(commands); replay.step(commands);
          if (frame % 15 === 0 || frame === 1 || frame === 45) {
            const [snapshot, digest, second] = await Promise.all([gpu.snapshot(), gpu.checksum(), replay.checksum()]);
            for (const name of ['control','units','distance','next','occupancy'] as const) equal(snapshot[name], cpu[name], `${mode} ${frame} ${name}`);
            equal(digest, cpu.checksum(), `checksum ${frame}`); equal(digest, second, `replay ${frame}`);
          }
        }
      } finally { gpu.dispose(); replay.dispose(); }
    }

    const mix = await loadData();
    const crossingScenario = readScenario(`[Map]\nX=0\nY=0\nWidth=6\nHeight=6\nTheater=Temperate\n[Units]\n0=GoodGuy,MTNK,256,130,0,Guard,None\n1=BadGuy,MTNK,256,131,0,Guard,None\n`, new Uint8Array(8192).fill(255));
    const crossingScene = buildScene(mix, crossingScenario);
    const crossingCells = new Uint8Array(64 * 64);
    for (let y = 0; y < 6; y++) crossingCells.fill(1, y * 64, y * 64 + 6);
    const crossingSetup = { grid: gridEdges(64, 64, crossingCells), seed: 1,
      spots: [[128,128]] as [number,number][], units: [{cell:130,speed:32},{cell:131,speed:0}] };
    const crossingCpu = new CpuSimulation(crossingSetup), crossingGpu = new GpuSimulation(renderer.three, crossingSetup);
    const crossingLayout = groundLayout(crossingScene, crossingCpu.units);
    const crossingPipeline = new PalettePipeline(renderer.three, {...crossingScene.setup, spriteCapacity:crossingLayout.count,
      dynamicSprites: {maxWidth:Math.max(...crossingScene.sprites.map(s => s.region.width)),maxHeight:Math.max(...crossingScene.sprites.map(s => s.region.height))}});
    const crossingGround = new GpuGround(renderer.three, crossingGpu, crossingPipeline, crossingLayout);
    try {
      // CONQUER.CPP, Main_Loop: Sort precedes Logic.AI. A starts left of B at the same y.
      // Tick 1 reserves its destination. Tick 2 moves A south, but its drawing order stays A,B.
      // Only tick 3 sorts using that new position. These expected orders do not use bubbleGround.
      const expectedOrders = [[0,1],[0,1],[0,1],[1,0]];
      const view = {x:42,y:40,width:68,height:62};
      for (let frame = 0; frame <= 3; frame++) {
        if (frame > 0) {
          const commands = frame === 1 ? [{frame,target:194}] : [];
          crossingGround.sort();
          crossingCpu.step(commands); crossingGpu.step(commands);
          crossingGround.updateSprites();
        }
        equal(new Uint32Array(await renderer.three.getArrayBufferAsync(crossingGround.order.order)), expectedOrders[frame],
          `draw order before logic at tick ${frame}`);
        const readback = crossingPipeline.readIndices(view);
        const expected = paint(crossingScene, groundSprites(crossingScene, crossingLayout, crossingCpu.units,
          new Uint32Array(expectedOrders[frame])), view, frame, true);
        equal(await readback, expected, `crossing tank pixels at tick ${frame}`);
      }
    } finally { crossingGround.dispose(); crossingPipeline.dispose(); crossingGpu.dispose(); }

    const { scene, setup, passable } = simulationScene(mix);
    const cpu = new CpuSimulation(setup), gpu = new GpuSimulation(renderer.three, setup);
    const layout = groundLayout(scene, cpu.units);
    const order = Uint32Array.from({length: scene.objects.length}, (_,i) => i), movingKeys = layout.keys.slice();
    const pipeline = new PalettePipeline(renderer.three, {...scene.setup, spriteCapacity: layout.count + 1,
      dynamicSprites: {maxWidth: Math.max(...scene.sprites.map(s => s.region.width)), maxHeight: Math.max(...scene.sprites.map(s => s.region.height))}});
    const ground = new GpuGround(renderer.three, gpu, pipeline, layout);
    const combined = new GpuChecksum(renderer.three, [...gpu.buffers(), ground.order.order]);
    const center = setup.units[2].cell;
    const views = [
      {x: center % setup.grid.width * 24 - 120, y: Math.floor(center / setup.grid.width) * 24 - 96, width: 360, height: 288},
      {x: center % setup.grid.width * 24 - 10, y: Math.floor(center / setup.grid.width) * 24 - 15, width: 160, height: 130},
    ];
    try {
      const target = passable.findIndex((value, cell) => !!value && cell % setup.grid.width > 24 && Math.floor(cell / setup.grid.width) > 20);
      for (let frame = 0; frame <= 90; frame++) {
        if (frame > 0) {
          const commands = frame === 1 ? [{frame, target}] : [];
          updateGroundKeys(layout, cpu.units, movingKeys); bubbleGround(order, movingKeys); ground.sort();
          cpu.step(commands); gpu.step(commands);
          ground.updateSprites();
        }
        if ([0,1,8,15,45,90].includes(frame)) {
          equal(await combined.read(), checksum([...cpu.buffers(), order]), `complete simulation checksum ${frame}`);
          for (const view of views) {
            const readback = pipeline.readIndices(view);
            const expected = paint(scene, groundSprites(scene, layout, cpu.units, order), view, frame, true);
            equal(await readback, expected, `moving pixels ${frame} ${view.x},${view.y}`);
          }
        }
      }
      const moved = setup.units.filter((u,i) => cpu.units[i * 12 + 2] !== u.cell).length;
      if (moved < 100) failures.push(`Only ${moved} of 320 tanks moved to another cell`);
    } finally { combined.dispose(); ground.dispose(); pipeline.dispose(); gpu.dispose(); }
  } finally { renderer.dispose(); canvas.remove(); }
  return failures;
}
