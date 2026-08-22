import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
let active = 0;
let started = 0;
const pending = [];

globalThis.fetch = () => {
  active++;
  started++;
  return new Promise((resolve) => {
    pending.push(() => {
      active--;
      resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
  });
};

try {
  const { clearAssetMemoryCaches, fetchJSON, setAssetFetchConcurrency } = await import('../js/asset_fetcher.js');
  setAssetFetchConcurrency(4);
  const requests = Array.from({ length: 6 }, (_, i) => fetchJSON(`runtime-scheduler-${i}`, {
    usePersistentCache: false,
    useMemoryCache: false,
  }));

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(active, 4, 'initial cap must limit active fetches');
  assert.equal(started, 4, 'two requests must remain queued');

  setAssetFetchConcurrency(1);
  pending.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(active, 3, 'lowering the cap must not refill an already-over-budget queue');
  assert.equal(started, 4, 'no queued request may start until active work reaches the new cap');

  setAssetFetchConcurrency(4);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(active, 4, 'raising the cap must wake one queued request immediately');
  assert.equal(started, 5, 'one queued request should be released after raising the cap');

  // A completion can wake the final queued request asynchronously, so drain
  // until every request has been handed to fetch before awaiting callers.
  while (started < requests.length || pending.length) {
    while (pending.length) pending.shift()();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await Promise.all(requests);

  // Clearing residency while an old request is finishing must not let its
  // cleanup erase a replacement request for the same URL.
  const first = fetchJSON('runtime-inflight-replacement', { usePersistentCache: false, useMemoryCache: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearAssetMemoryCaches();
  const replacement = fetchJSON('runtime-inflight-replacement', { usePersistentCache: false, useMemoryCache: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started, 8, 'cache clear must permit exactly one replacement request');
  pending.shift()();
  await first;
  const deduped = fetchJSON('runtime-inflight-replacement', { usePersistentCache: false, useMemoryCache: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started, 8, 'old request cleanup must not erase the replacement in-flight entry');
  pending.shift()();
  await Promise.all([replacement, deduped]);
  console.log('asset fetch concurrency contraction and expansion passed');
} finally {
  globalThis.fetch = originalFetch;
}
