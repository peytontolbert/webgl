const nativeSetInterval = window.setInterval.bind(window);
const nativeClearInterval = window.clearInterval.bind(window);
const nativeSetTimeout = window.setTimeout.bind(window);
const nativeClearTimeout = window.clearTimeout.bind(window);
const pending = new Map();
let nextId = 1000000;
let wakeTimer = 0;

const schedule = () => {
    if (wakeTimer) nativeClearTimeout(wakeTimer);
    wakeTimer = 0;
    if (!pending.size) return;

    const now = performance.now();
    let nextAt = Infinity;
    for (const task of pending.values()) nextAt = Math.min(nextAt, task.nextAt);
    wakeTimer = nativeSetTimeout(tick, Math.max(0, nextAt - now));
};

const tick = () => {
    wakeTimer = 0;
    const now = performance.now();
    for (const [id, task] of pending) {
        if (now < task.nextAt) continue;
        task.nextAt = now + task.delay;
        try {
            task.callback(...task.args);
        } catch (error) {
            console.warn('Nexus bootstrap task failed:', error);
            pending.delete(id);
        }
    }
    schedule();
};

window.setInterval = (callback, delay, ...args) => {
    const source = typeof callback === 'function' ? Function.prototype.toString.call(callback) : '';
    const isReadinessPoll = Number(delay) <= 300 && /__nx(?:Target|RadialMenu)/.test(source);
    if (!isReadinessPoll) return nativeSetInterval(callback, delay, ...args);
    const id = nextId++;
    const cadence = Math.max(1, Number(delay) || 1);
    pending.set(id, { callback, args, delay: cadence, nextAt: performance.now() + cadence });
    schedule();
    return id;
};
window.clearInterval = (id) => {
    if (pending.delete(id)) {
        schedule();
        return;
    }
    nativeClearInterval(id);
};
window.__nxBootstrap = {
    pending: () => pending.size,
    runNow: () => {
        const now = performance.now();
        for (const task of pending.values()) task.nextAt = now;
        tick();
    },
};
