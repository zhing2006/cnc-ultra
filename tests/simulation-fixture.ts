export async function compareSimulation() {
  const { createRenderer } = await import('../src/engine/renderer.ts');
  const { GpuSimulation } = await import('../src/engine/simulation/gpu.ts');
  const { releaseStorage } = await import('../src/engine/simulation/resources.ts');
  const { CpuSimulation } = await import('../src/engine/simulation/cpu.ts');
  const { fixedAdd, fixedSub, fixedMul, fixedDiv, hash32, randomWord, checksum } = await import('../src/engine/simulation/fixed.ts');
  const { GpuChecksum } = await import('../src/engine/simulation/checksum.ts');
  const { fixedMulNode, fixedDivNode, randomNode } = await import('../src/engine/simulation/integer-nodes.ts');
  const { gridEdges } = await import('../src/engine/simulation/state.ts');
  const { GpuOrder } = await import('../src/engine/simulation/order.ts');
  const { bubbleGround, insertGround, groundLayout, updateGroundKeys, groundSprites, GpuGround } = await import('../src/game/simulation/ground.ts');
  const { simulationScene } = await import('../src/game/simulation/scene.ts');
  const { readScenario } = await import('../src/game/formats/scenario.ts');
  const { buildScene } = await import('../src/game/scene.ts');
  const { loadData } = await import('../src/game/data-files.ts');
  const { PalettePipeline } = await import('../src/engine/indexed/pipeline.ts');
  const { paint } = await import('../tests/reference/paint.ts');
  const { StorageBufferAttribute } = await import('three/webgpu');
  const { Fn, storage, instanceIndex, uint } = await import('three/tsl');
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
    const cases: [number, number][] = [[0,256],[-385,129],[-2147483648,-1],[2147483647,2147483647],[-2147483648,257]];
    for (let i = 0; i < 160; i++) cases.push([hash32(i) | 0, (hash32(i + 999) | 0) || 1]);
    const input = new StorageBufferAttribute(new Int32Array(cases.flat()), 1);
    const output = new StorageBufferAttribute(new Int32Array(cases.length * 5), 1);
    const ins = storage(input, 'int', cases.length * 2).toReadOnly(), out = storage(output, 'int', cases.length * 5);
    const arithmetic = Fn(() => {
      const i = instanceIndex, a = ins.element(i.mul(2)), b = ins.element(i.mul(2).add(1)), start = i.mul(5);
      out.element(start).assign(a.add(b)); out.element(start.add(1)).assign(a.sub(b));
      out.element(start.add(2)).assign(fixedMulNode(a, b)); out.element(start.add(3)).assign(fixedDivNode(a, b));
      out.element(start.add(4)).assign(randomNode(uint(a), uint(b), i, uint(3)));
    })().compute(cases.length);
    try {
      renderer.three.compute(arithmetic);
      const actual = new Int32Array(await renderer.three.getArrayBufferAsync(output));
      const expected = new Int32Array(cases.flatMap(([a,b], i) => [fixedAdd(a,b),fixedSub(a,b),fixedMul(a,b),fixedDiv(a,b),randomWord(a,b,i,3)]));
      equal(actual, expected, 'fixed point and random words');
    } finally { arithmetic.dispose(); releaseStorage(renderer.three, [input, output]); }

    const keyValues = new Int32Array([1,9, 2,1, 3,1, 4,7, 5,3, 6,1, 7,3]);
    const keys = new StorageBufferAttribute(keyValues, 1);
    const sorted = new GpuOrder(renderer.three, keys, new Uint32Array([0,1,2,3,4,5]));
    let cpuOrder = new Uint32Array([0,1,2,3,4,5]);
    try {
      sorted.step(); bubbleGround(cpuOrder, keyValues);
      equal(new Uint32Array(await renderer.three.getArrayBufferAsync(sorted.order)).subarray(0,6), cpuOrder, 'one bubble pass');
      const inserting = Array.from(cpuOrder); insertGround(inserting, keyValues, 6);
      sorted.insert(6); cpuOrder = new Uint32Array(inserting);
      equal(new Uint32Array(await renderer.three.getArrayBufferAsync(sorted.order)), cpuOrder, 'insert into partially sorted layer');
      sorted.step(); bubbleGround(cpuOrder, keyValues);
      equal(new Uint32Array(await renderer.three.getArrayBufferAsync(sorted.order)), cpuOrder, 'bubble after insertion');
    } finally { sorted.dispose(); releaseStorage(renderer.three, [keys]); }

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
    const drawData = new Float32Array(await renderer.three.getArrayBufferAsync(pipeline.spriteBuffer));
    equal(drawData.subarray(0, layout.packed.length), layout.packed, 'initial sprite instances');
    const spatial = (pipeline as unknown as {spatial: {offsets: InstanceType<typeof StorageBufferAttribute>; items: InstanceType<typeof StorageBufferAttribute>}}).spatial;
    const offsets = new Uint32Array(await renderer.three.getArrayBufferAsync(spatial.offsets));
    const items = new Uint32Array(await renderer.three.getArrayBufferAsync(spatial.items));
    for (let bin = 0; bin < 24 * 24; bin++) {
      const x = bin % 24, y = Math.floor(bin / 24), expected: number[] = [];
      for (let i = 0; i < layout.count; i++) {
        const at = i * 12, [left,top,w,h] = layout.packed.subarray(at,at+4);
        if (w > 0 && h > 0 && x >= Math.floor(left/64) && x <= Math.floor((left+w-1)/64) && y >= Math.floor(top/64) && y <= Math.floor((top+h-1)/64)) expected.push(i);
      }
      const actual = Array.from(items.subarray(offsets[bin],offsets[bin+1])).sort((a,b) => a-b);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) { failures.push(`bin ${bin}: ${actual} != ${expected}`); break; }
    }
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
          equal(new Uint32Array(await renderer.three.getArrayBufferAsync(ground.order.order)), order, `moving order ${frame}`);
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
