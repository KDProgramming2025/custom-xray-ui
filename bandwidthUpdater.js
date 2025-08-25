// Deprecated heavy synchronous updater removed.
// Usage aggregation now handled asynchronously in users.js (accumulateUsageAsync) to avoid event loop blocking.
// Keeping a tiny noop interval to allow easy re-enable if needed.
setInterval(()=>{}, 3600_000).unref();