const IDLE_WAIT_MILLISECONDS = 10000;

function createWorkTracker({
  logFailure = (error) => console.error(error),
  timerFunctions = { setTimeout, clearTimeout },
  idleWaitMilliseconds = IDLE_WAIT_MILLISECONDS,
} = {}) {
  const inflight = new Set();

  function track(job) {
    const pending = Promise.resolve(job).catch(logFailure);
    inflight.add(pending);
    pending.finally(() => inflight.delete(pending));
    return pending;
  }

  function untilWorkFinishes() {
    if (inflight.size === 0) return Promise.resolve();
    return Promise.all([...inflight]).then(untilWorkFinishes);
  }

  function whenIdle() {
    let boundTimer = null;
    const bound = new Promise((resolve, reject) => {
      boundTimer = timerFunctions.setTimeout(() => {
        reject(new Error(`tracked work did not finish within ${idleWaitMilliseconds} ms`));
      }, idleWaitMilliseconds);
    });
    return Promise.race([untilWorkFinishes(), bound])
      .finally(() => timerFunctions.clearTimeout(boundTimer));
  }

  return { track, whenIdle };
}

module.exports = { IDLE_WAIT_MILLISECONDS, createWorkTracker };
