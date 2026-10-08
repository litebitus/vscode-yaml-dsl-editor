const LANES = { interactive: 'interactive', background: 'background' };

function yieldToMessages() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function createWorkQueue({ interactivePriorityLimit }) {
  const waiting = [];
  const running = { [LANES.interactive]: null, [LANES.background]: null };
  const pumping = { [LANES.interactive]: false, [LANES.background]: false };
  let sequence = 0;

  function laneOf(job) {
    return job.priority <= interactivePriorityLimit ? LANES.interactive : LANES.background;
  }

  function otherLane(lane) {
    return lane === LANES.interactive ? LANES.background : LANES.interactive;
  }

  function runningKeyIn(lane) {
    return running[lane] === null ? null : running[lane].key;
  }

  function nextJob(lane) {
    const blockedKey = runningKeyIn(otherLane(lane));
    let chosenIndex = -1;
    waiting.forEach((candidate, index) => {
      if (laneOf(candidate) !== lane || candidate.key === blockedKey) return;
      const chosen = chosenIndex < 0 ? null : waiting[chosenIndex];
      if (!chosen || candidate.priority < chosen.priority
        || (candidate.priority === chosen.priority && candidate.order < chosen.order)) {
        chosenIndex = index;
      }
    });
    return chosenIndex < 0 ? null : waiting.splice(chosenIndex, 1)[0];
  }

  function interactiveWorkPending() {
    return running[LANES.interactive] !== null || waiting.some((job) => laneOf(job) === LANES.interactive);
  }

  function settledRun(job) {
    return job.done.then(() => {}, () => {});
  }

  async function pump(lane) {
    if (pumping[lane]) return;
    pumping[lane] = true;
    while (waiting.some((job) => laneOf(job) === lane)) {
      await yieldToMessages();
      if (lane === LANES.background && interactiveWorkPending()) {
        if (running[LANES.interactive]) await settledRun(running[LANES.interactive]);
        continue;
      }
      const job = nextJob(lane);
      if (!job) {
        const blocking = running[otherLane(lane)];
        if (blocking) await settledRun(blocking);
        continue;
      }
      running[lane] = job;
      try {
        job.resolve(await job.work());
      } catch (error) {
        job.reject(error);
      }
      running[lane] = null;
    }
    pumping[lane] = false;
    if (lane === LANES.interactive) pump(LANES.background);
  }

  function pumpBothLanes() {
    pump(LANES.interactive);
    pump(LANES.background);
  }

  function schedule(priority, key, work) {
    const job = { priority, key, work, order: sequence += 1 };
    job.done = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    waiting.push(job);
    pumpBothLanes();
    return job.done;
  }

  function promote(key, priority) {
    for (const job of waiting) {
      if (job.key === key && job.priority > priority) job.priority = priority;
    }
    pumpBothLanes();
  }

  function runningJobs() {
    return Object.values(running).filter((job) => job !== null);
  }

  function hasWork(key) {
    return runningJobs().some((job) => job.key === key) || waiting.some((job) => job.key === key);
  }

  function settledFor(key) {
    const pending = waiting.filter((job) => job.key === key).map((job) => job.done);
    for (const job of runningJobs()) if (job.key === key) pending.push(job.done);
    return Promise.allSettled(pending);
  }

  return { schedule, promote, hasWork, settledFor };
}

module.exports = { createWorkQueue };
