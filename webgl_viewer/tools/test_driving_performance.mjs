import assert from 'node:assert/strict';
import { DrivingPerformanceMonitor } from '../js/gameplay/driving_performance.js';

const monitor = new DrivingPerformanceMonitor({ historyFrames: 120, cpuBudgetMs: 10, gpuBudgetMs: 12 });
monitor.beginFrame({ driving: false });
monitor.measure('worldRender', () => { for (let i = 0; i < 1000; i++); });
assert.equal(monitor.endFrame({ cpuMs: 2 }), null, 'on-foot frames must not pollute driving measurements');

monitor.startBenchmark({ seconds: 5, label: 'unit-route' });
for (let frame = 0; frame < 8; frame++) {
    monitor.beginFrame({ driving: true });
    monitor.measure('vehiclePhysics', () => { for (let i = 0; i < 1000; i++); });
    monitor.mark('worldRender', 2 + frame * 0.1);
    monitor.endFrame({ cpuMs: 8 + frame * 0.1, gpuMs: 10 + frame * 0.1, speedMps: 20, drawCalls: 240 });
    monitor.advanceBenchmarkWallTime(0.75);
}

const snapshot = monitor.getSnapshot();
assert.equal(snapshot.sampleCount, 8, 'driving ledger must retain occupied-vehicle samples only');
assert.ok(snapshot.phases.vehiclePhysics.p95Ms >= 0, 'vehicle physics p95 should be available');
assert.ok(snapshot.phases.worldRender.p95Ms >= 2, 'world render phase should be summarized');
assert.ok(snapshot.cpu.p95Ms > 0 && snapshot.gpu.p95Ms > 0, 'CPU and GPU percentiles should be recorded');
assert.equal(monitor.getBenchmark().complete, true, 'benchmark should complete from wall-clock drive time');

console.log('driving performance ledger: phase p95s, budgets, and benchmark capture passed');
