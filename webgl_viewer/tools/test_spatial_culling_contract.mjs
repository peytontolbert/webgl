import assert from 'node:assert/strict';
import {
  isProjectedCullSafe,
  isSafeFarDrawBudgetCandidate,
  isSpatialCullSafe,
  shouldDeferSpatialMesh,
} from '../js/instanced_model_renderer.js';

const bakedCell = {
  supermesh: {
    cell: '0_-4',
    sourcePartCount: 27,
    sourceInstanceCount: 19,
  },
};

assert.equal(isSpatialCullSafe(bakedCell, 1), true, 'baked cell should permit command culling');
assert.equal(isSpatialCullSafe(bakedCell, 5), false, 'unexpected aggregate duplication must fail open');
assert.equal(isSpatialCullSafe({ lodDistances: { Med: 220 } }, 1), false, 'source archetype must fail open');
assert.equal(isSpatialCullSafe({ supermesh: { cell: '0_-4' } }, 1), false, 'incomplete metadata must fail open');
assert.equal(isSpatialCullSafe(null, 1), false, 'missing metadata must fail open');
assert.equal(shouldDeferSpatialMesh(bakedCell, 1, false, 500), true, 'far hidden baked cell should defer');
assert.equal(shouldDeferSpatialMesh(bakedCell, 1, false, 200), false, 'near baked cell should warm behind camera');
assert.equal(shouldDeferSpatialMesh(bakedCell, 1, true, 500), false, 'visible baked cell should load');
assert.equal(shouldDeferSpatialMesh({ lodDistances: { Med: 220 } }, 1, false, 500), false, 'source mesh must load');
assert.equal(isProjectedCullSafe({ radius: 2.5 }, 1), true, 'compact single mesh may use sub-pixel culling');
assert.equal(isProjectedCullSafe({ radius: 40 }, 1), false, 'large structure must remain visible');
assert.equal(isProjectedCullSafe({ radius: 2.5 }, 12), false, 'large aggregate must fail open');
assert.equal(isSafeFarDrawBudgetCandidate({ radius: 2.5 }, 1, 300, 3.5), true, 'far screen-small prop may be budgeted');
assert.equal(isSafeFarDrawBudgetCandidate({ radius: 2.5 }, 1, 80, 3.5), false, 'near compact prop must remain');
assert.equal(isSafeFarDrawBudgetCandidate({ radius: 2.5 }, 1, 300, 12), false, 'screen-visible prop must remain');
assert.equal(isSafeFarDrawBudgetCandidate({ radius: 40 }, 1, 300, 3.5), false, 'large structure must remain');

console.log('spatial culling: baked cells cull safely and source aggregates fail open');
