function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/** Opt-in fixed-step telemetry recorder for physics parity work. */
export class VehicleDiagnostics {
    constructor({ maxSamples = 36000 } = {}) {
        this.maxSamples = Math.max(60, Number(maxSamples) || 36000);
        this.recording = false;
        this.elapsedSeconds = 0;
        this.label = '';
        this.metadata = null;
        this.samples = [];
        this.events = [];
    }

    start(metadata = {}) {
        this.recording = true;
        this.elapsedSeconds = 0;
        this.label = String(metadata.label || 'manual');
        this.metadata = { ...metadata, startedAt: new Date().toISOString() };
        this.samples = [];
        this.events = [];
        return this.snapshot({ includeSamples: false });
    }

    stop() {
        this.recording = false;
        return this.snapshot({ includeSamples: false });
    }

    clear() {
        this.elapsedSeconds = 0;
        this.samples = [];
        this.events = [];
    }

    event(type, detail = {}) {
        if (!this.recording) return;
        this.events.push({ t: finite(this.elapsedSeconds), type: String(type || 'event'), detail: { ...detail } });
        if (this.events.length > 1024) this.events.splice(0, this.events.length - 1024);
    }

    capture(dt, sample) {
        if (!this.recording) return;
        this.elapsedSeconds += Math.max(0, finite(dt));
        this.samples.push({ t: finite(this.elapsedSeconds), ...sample });
        if (this.samples.length > this.maxSamples) this.samples.splice(0, this.samples.length - this.maxSamples);
    }

    snapshot({ includeSamples = true } = {}) {
        return {
            schema: 'webglgta-vehicle-telemetry-v1',
            recording: this.recording,
            durationSeconds: finite(this.elapsedSeconds),
            sampleCount: this.samples.length,
            sampleRateHz: this.elapsedSeconds > 0 ? this.samples.length / this.elapsedSeconds : 0,
            label: this.label,
            metadata: this.metadata ? { ...this.metadata } : null,
            events: this.events.slice(),
            ...(includeSamples ? { samples: this.samples.slice() } : {}),
        };
    }
}
