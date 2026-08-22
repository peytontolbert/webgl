function distance2d(a, b) {
    return Math.hypot(Number(a?.[0]) - Number(b?.[0]), Number(a?.[1]) - Number(b?.[1]));
}

export class PedNavigationGraph {
    constructor(url = 'assets/navigation/demo_navmesh.json') {
        this.url = url;
        this.ready = false;
        this.nodes = [];
        this.byId = new Map();
        this.loadPromise = null;
    }

    load() {
        if (this.ready) return Promise.resolve(true);
        if (this.loadPromise) return this.loadPromise;
        this.loadPromise = (async () => {
            const response = await fetch(this.url, { cache: 'force-cache' });
            if (!response.ok) throw new Error(`Navigation graph HTTP ${response.status}`);
            const payload = await response.json();
            if (payload?.schema !== 'webglgta-ynv-navigation-v1' || !Array.isArray(payload.nodes)) {
                throw new Error('Unsupported navigation graph');
            }
            this.nodes = payload.nodes.filter((node) => Array.isArray(node?.center) && node.center.length >= 3);
            this.byId = new Map(this.nodes.map((node) => [String(node.id), node]));
            this.ready = this.nodes.length > 0;
            return this.ready;
        })().catch((error) => {
            console.warn('GTA pedestrian navigation failed to load:', error);
            this.ready = false;
            return false;
        });
        return this.loadPromise;
    }

    nearest(x, y, z = 0.0, maxDistance = 35.0) {
        if (!this.ready) return null;
        let best = null;
        let bestScore = maxDistance * maxDistance;
        for (const node of this.nodes) {
            const dx = Number(node.center[0]) - x;
            const dy = Number(node.center[1]) - y;
            const dz = Math.abs(Number(node.center[2]) - z);
            if (dz > 5.0) continue;
            const score = dx * dx + dy * dy + dz * dz * 2.0;
            if (score >= bestScore) continue;
            bestScore = score;
            best = node;
        }
        return best;
    }

    randomDestination(x, y, z, random = Math.random, minRadius = 8.0, maxRadius = 32.0) {
        if (!this.ready) return null;
        const candidates = [];
        for (const node of this.nodes) {
            const distance = Math.hypot(Number(node.center[0]) - x, Number(node.center[1]) - y);
            if (distance < minRadius || distance > maxRadius || Math.abs(Number(node.center[2]) - z) > 3.5) continue;
            if (node.walkClass === 'footpath') candidates.push(node);
            else if (random() < 0.18) candidates.push(node);
        }
        return candidates.length ? candidates[Math.floor(random() * candidates.length)] : null;
    }

    findPath(start, goal, maxVisited = 5000) {
        if (!start || !goal) return [];
        if (start.id === goal.id) return [start.center, goal.center];
        const open = [{ id: String(start.id), score: distance2d(start.center, goal.center) }];
        const cameFrom = new Map();
        const cost = new Map([[String(start.id), 0.0]]);
        const closed = new Set();
        let visited = 0;

        while (open.length && visited++ < maxVisited) {
            let bestIndex = 0;
            for (let i = 1; i < open.length; i++) if (open[i].score < open[bestIndex].score) bestIndex = i;
            const currentId = open.splice(bestIndex, 1)[0].id;
            if (closed.has(currentId)) continue;
            if (currentId === String(goal.id)) {
                const route = [];
                let cursor = currentId;
                while (cursor) {
                    const node = this.byId.get(cursor);
                    if (node) route.push(node.center);
                    cursor = cameFrom.get(cursor) || '';
                }
                return route.reverse();
            }
            closed.add(currentId);
            const current = this.byId.get(currentId);
            if (!current) continue;
            for (const linkRaw of current.links || []) {
                const link = String(linkRaw);
                const next = this.byId.get(link);
                if (!next || closed.has(link)) continue;
                const nextCost = (cost.get(currentId) || 0.0) + distance2d(current.center, next.center);
                if (nextCost >= (cost.get(link) ?? Number.POSITIVE_INFINITY)) continue;
                cost.set(link, nextCost);
                cameFrom.set(link, currentId);
                open.push({ id: link, score: nextCost + distance2d(next.center, goal.center) });
            }
        }
        return [];
    }

    route(x, y, z, random = Math.random) {
        const start = this.nearest(x, y, z);
        const goal = this.randomDestination(x, y, z, random);
        return start && goal ? this.findPath(start, goal) : [];
    }
}
