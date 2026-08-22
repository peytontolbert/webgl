class GtaVehicleGranularProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.clips = new Map();
        this.grains = [];
        this.port.onmessage = (event) => this._handleMessage(event.data || {});
    }

    _handleMessage(message) {
        if (message.type === 'clips' && Array.isArray(message.clips)) {
            this.clips.clear();
            for (const clip of message.clips) {
                const channels = Array.isArray(clip?.channels)
                    ? clip.channels.map((buffer) => new Float32Array(buffer))
                    : [];
                if (clip?.name && channels.length) this.clips.set(String(clip.name), channels);
            }
            return;
        }
        if (message.type === 'clear') {
            this.grains.length = 0;
            return;
        }
        if (message.type !== 'grain' || !message.clip || this.grains.length >= 128) return;
        const durationFrames = Math.max(1, Number(message.durationFrames) | 0);
        this.grains.push({
            clip: String(message.clip),
            startFrame: Math.max(currentFrame, Number(message.startFrame) | 0),
            offsetFrames: Math.max(0, Number(message.offsetFrames) || 0),
            durationFrames,
            rate: Math.max(0.05, Math.min(4.0, Number(message.rate) || 1.0)),
            gain: Math.max(0, Math.min(1.0, Number(message.gain) || 0)),
            fadeFrames: Math.max(1, Math.min(Math.floor(durationFrames * 0.22), Number(message.fadeFrames) | 0 || 1)),
        });
    }

    _sample(channel, position) {
        const last = channel.length - 1;
        if (last < 0 || position < 0 || position >= last) return 0;
        const index = position | 0;
        const fraction = position - index;
        return channel[index] + (channel[index + 1] - channel[index]) * fraction;
    }

    process(_inputs, outputs) {
        const out = outputs[0];
        const left = out?.[0];
        const right = out?.[1] || left;
        if (!left || !right) return true;
        left.fill(0);
        if (right !== left) right.fill(0);
        const frameEnd = currentFrame + left.length;
        const keep = [];
        for (const grain of this.grains) {
            const channels = this.clips.get(grain.clip);
            if (!channels) continue;
            const grainEnd = grain.startFrame + grain.durationFrames;
            if (grainEnd <= currentFrame) continue;
            if (grain.startFrame >= frameEnd) {
                keep.push(grain);
                continue;
            }
            const begin = Math.max(0, grain.startFrame - currentFrame);
            const end = Math.min(left.length, grainEnd - currentFrame);
            const sourceLeft = channels[0];
            const sourceRight = channels[1] || sourceLeft;
            for (let index = begin; index < end; index++) {
                const fadeIn = Math.min(1, (currentFrame + index - grain.startFrame) / grain.fadeFrames);
                const fadeOut = Math.min(1, (grainEnd - (currentFrame + index)) / grain.fadeFrames);
                const envelope = Math.max(0, Math.min(1, fadeIn, fadeOut));
                const sourcePosition = grain.offsetFrames + (currentFrame + index - grain.startFrame) * grain.rate;
                const gain = grain.gain * envelope;
                left[index] += this._sample(sourceLeft, sourcePosition) * gain;
                right[index] += this._sample(sourceRight, sourcePosition) * gain;
            }
            if (grainEnd > frameEnd) keep.push(grain);
        }
        this.grains = keep;
        return true;
    }
}

registerProcessor('webglgta-gta-vehicle-granular-v1', GtaVehicleGranularProcessor);
