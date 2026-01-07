export function extractFrustumPlanes(m /* Float32Array(16) */, outPlanes = null) {
    // m is column-major (gl-matrix style). We treat it as OpenGL clip matrix.
    // Planes in form ax+by+cz+d >= 0 inside.
    const planes = Array.isArray(outPlanes) ? outPlanes : [];
    if (planes.length < 6) {
        for (let i = planes.length; i < 6; i++) planes.push([0, 0, 0, 0]);
    }
    const me = m;
    const row = (r, c) => me[c * 4 + r];

    // Left:  row3 + row0
    planes[0][0] = row(3, 0) + row(0, 0); planes[0][1] = row(3, 1) + row(0, 1); planes[0][2] = row(3, 2) + row(0, 2); planes[0][3] = row(3, 3) + row(0, 3);
    // Right: row3 - row0
    planes[1][0] = row(3, 0) - row(0, 0); planes[1][1] = row(3, 1) - row(0, 1); planes[1][2] = row(3, 2) - row(0, 2); planes[1][3] = row(3, 3) - row(0, 3);
    // Bottom: row3 + row1
    planes[2][0] = row(3, 0) + row(1, 0); planes[2][1] = row(3, 1) + row(1, 1); planes[2][2] = row(3, 2) + row(1, 2); planes[2][3] = row(3, 3) + row(1, 3);
    // Top: row3 - row1
    planes[3][0] = row(3, 0) - row(1, 0); planes[3][1] = row(3, 1) - row(1, 1); planes[3][2] = row(3, 2) - row(1, 2); planes[3][3] = row(3, 3) - row(1, 3);
    // Near: row3 + row2
    planes[4][0] = row(3, 0) + row(2, 0); planes[4][1] = row(3, 1) + row(2, 1); planes[4][2] = row(3, 2) + row(2, 2); planes[4][3] = row(3, 3) + row(2, 3);
    // Far: row3 - row2
    planes[5][0] = row(3, 0) - row(2, 0); planes[5][1] = row(3, 1) - row(2, 1); planes[5][2] = row(3, 2) - row(2, 2); planes[5][3] = row(3, 3) - row(2, 3);

    // Normalize planes
    for (let i = 0; i < planes.length; i++) {
        const p = planes[i];
        const len = Math.hypot(p[0], p[1], p[2]) || 1.0;
        p[0] = p[0] / len;
        p[1] = p[1] / len;
        p[2] = p[2] / len;
        p[3] = p[3] / len;
    }
    return planes;
}

export function aabbIntersectsFrustum(planes, min, max) {
    // For each plane, compute the vertex most in direction of normal (p-vertex)
    // If that vertex is outside, the whole box is outside.
    for (const p of planes) {
        const nx = p[0], ny = p[1], nz = p[2], d = p[3];
        const px = nx >= 0 ? max[0] : min[0];
        const py = ny >= 0 ? max[1] : min[1];
        const pz = nz >= 0 ? max[2] : min[2];
        if (nx * px + ny * py + nz * pz + d < 0) return false;
    }
    return true;
}


