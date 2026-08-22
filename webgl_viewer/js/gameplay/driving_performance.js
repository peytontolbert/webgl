function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function percentile(values, ratio) {
    if (!Array.isArray(values) || values.length === 0) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1));
    return sorted[index];
}

/**
 * Low-overhead driving profiler. It intentionally records only occupied-vehicle
 * frames, so UI, loading, and on-foot traversal cannot hide a driving spike.
 */
export class DrivingPerformanceMonitor {
    constructor({ historyFrames = 900, cpuBudgetMs = 10, gpuBudgetMs = 12 } = {}) {
        this.historyFrames = Math.max(120, Math.min(7200, historyFrames | 0));
        this.cpuBudgetMs = Math.max(1, finite(cpuBudgetMs, 10));
        this.gpuBudgetMs = Math.max(1, finite(gpuBudgetMs, 12));
        this._phaseHistory = new Map();
        this._framePhases = new Map();
        this._frames = [];
        this._frameDriving = false;
        this._benchmark = null;
        this._lastSnapshot = null;
    }

    beginFrame({ driving = false } = {}) {
        this._frameDriving = !!driving;
        this._framePhases.clear();
    }

    measure(name, callback) {
        if (typeof callback !== 'function') return undefined;
        if (!this._frameDriving) return callback();
        const startedAt = performance.now();
        try {
            return callback();
        } finally {
            const elapsed = Math.max(0, performance.now() - startedAt);
            const key = String(name || 'other');
            this._framePhases.set(key, (this._framePhases.get(key) || 0) + elapsed);
        }
    }

    mark(name, elapsedMs) {
        if (!this._frameDriving) return;
        const elapsed = Math.max(0, finite(elapsedMs));
        const key = String(name || 'other');
        this._framePhases.set(key, (this._framePhases.get(key) || 0) + elapsed);
    }

    endFrame({ cpuMs = 0, gpuMs = null, speedMps = 0, drawCalls = 0 } = {}) {
        if (!this._frameDriving) return null;
        const phases = Object.fromEntries(this._framePhases);
        const sample = {
            cpuMs: Math.max(0, finite(cpuMs)),
            gpuMs: Number.isFinite(Number(gpuMs)) ? Math.max(0, Number(gpuMs)) : null,
            speedMps: Math.abs(finite(speedMps)),
            drawCalls: Math.max(0, finite(drawCalls)),
            phases,
        };
        this._frames.push(sample);
        if (this._frames.length > this.historyFrames) this._frames.splice(0, this._frames.length - this.historyFrames);
        for (const [name, elapsed] of this._framePhases) {
            let values = this._phaseHistory.get(name);
            if (!values) {
                values = [];
                this._phaseHistory.set(name, values);
            }
            values.push(elapsed);
            if (values.length > this.historyFrames) values.splice(0, values.length - this.historyFrames);
        }
        this._advanceBenchmark(sample);
        this._lastSnapshot = null;
        return sample;
    }

    startBenchmark({ seconds = 60, label = 'drive-route', autoDrive = false } = {}) {
        this._benchmark = {
            label: String(label || 'drive-route'),
            seconds: Math.max(5, Math.min(600, finite(seconds, 60))),
            elapsed: 0,
            samples: [],
            startedAt: performance.now(),
            complete: false,
            autoDrive: !!autoDrive,
        };
        return this.getBenchmark();
    }

    cancelBenchmark(reason = 'cancelled') {
        if (!this._benchmark || this._benchmark.complete) return this.getBenchmark();
        this._benchmark.complete = true;
        this._benchmark.reason = String(reason || 'cancelled');
        return this.getBenchmark();
    }

    _advanceBenchmark(sample) {
        const benchmark = this._benchmark;
        if (!benchmark || benchmark.complete) return;
        benchmark.samples.push(sample);
    }

    advanceBenchmarkWallTime(seconds) {
        const benchmark = this._benchmark;
        if (!benchmark || benchmark.complete) return;
        benchmark.elapsed += Math.max(0, finite(seconds));
        if (benchmark.elapsed >= benchmark.seconds) {
            benchmark.complete = true;
            benchmark.reason = 'complete';
            benchmark.completedAt = performance.now();
        }
    }

    getBenchmarkInput() {
        const benchmark = this._benchmark;
        if (!benchmark?.autoDrive || benchmark.complete) return null;
        // A fixed 60-second throttle/turn sequence is intentionally simple:
        // it is repeatable on a fresh demo spawn and exercises acceleration,
        // sustained streaming, left/right steering, and braking without
        // teleporting or bypassing the real vehicle physics/collision stack.
        const phase = benchmark.elapsed % 60.0;
        if (phase < 12) return { w: true };
        if (phase < 20) return { w: true, a: true };
        if (phase < 34) return { w: true };
        if (phase < 42) return { w: true, d: true };
        if (phase < 52) return { w: true };
        if (phase < 57) return { s: true };
        return { w: true, d: true };
    }

    _summarize(samples) {
        const cpu = samples.map((sample) => sample.cpuMs).filter(Number.isFinite);
        const gpu = samples.map((sample) => sample.gpuMs).filter(Number.isFinite);
        const phases = {};
        for (const [name, values] of this._phaseHistory) {
            phases[name] = {
                p50Ms: percentile(values, 0.5),
                p95Ms: percentile(values, 0.95),
                maxMs: values.length ? Math.max(...values) : null,
            };
        }
        const cpuP95 = percentile(cpu, 0.95);
        const gpuP95 = percentile(gpu, 0.95);
        return {
            sampleCount: samples.length,
            cpu: { p50Ms: percentile(cpu, 0.5), p95Ms: cpuP95, maxMs: cpu.length ? Math.max(...cpu) : null, budgetMs: this.cpuBudgetMs, withinBudget: cpuP95 === null ? null : cpuP95 <= this.cpuBudgetMs },
            gpu: { p50Ms: percentile(gpu, 0.5), p95Ms: gpuP95, maxMs: gpu.length ? Math.max(...gpu) : null, budgetMs: this.gpuBudgetMs, withinBudget: gpuP95 === null ? null : gpuP95 <= this.gpuBudgetMs },
            phases,
        };
    }

    getSnapshot() {
        if (this._lastSnapshot) return this._lastSnapshot;
        this._lastSnapshot = this._summarize(this._frames);
        return this._lastSnapshot;
    }

    getBenchmark() {
        const benchmark = this._benchmark;
        if (!benchmark) return null;
        return {
            label: benchmark.label,
            seconds: benchmark.seconds,
            elapsed: benchmark.elapsed,
            complete: !!benchmark.complete,
            reason: benchmark.reason || '',
            autoDrive: !!benchmark.autoDrive,
            ...this._summarize(benchmark.samples),
        };
    }
}
