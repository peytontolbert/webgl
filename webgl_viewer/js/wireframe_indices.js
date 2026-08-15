export function createWireframeIndices(triangleIndices, IndexArrayCtor = Uint32Array) {
    if (!triangleIndices || triangleIndices.length < 3) return new IndexArrayCtor(0);

    const triCount = Math.floor(triangleIndices.length / 3);
    const lineIndices = new IndexArrayCtor(triCount * 6);
    let o = 0;
    for (let i = 0; i + 2 < triangleIndices.length; i += 3) {
        const a = triangleIndices[i + 0];
        const b = triangleIndices[i + 1];
        const c = triangleIndices[i + 2];
        lineIndices[o++] = a; lineIndices[o++] = b;
        lineIndices[o++] = b; lineIndices[o++] = c;
        lineIndices[o++] = c; lineIndices[o++] = a;
    }
    return lineIndices;
}
