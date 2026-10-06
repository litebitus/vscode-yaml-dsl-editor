function yieldToMessages() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function createWorkQueue() {
  const waiting = [];
  let sequence = 0;
  let running = null;
  let pumping = false;

  function nextJob() {
    let chosenIndex = 0;
    for (let index = 1; index < waiting.length; index += 1) {
      const candidate = waiting[index];
      const chosen = waiting[chosenIndex];
      if (candidate.priority < chosen.priority
        || (candidate.priority === chosen.priority && candidate.order < chosen.order)) {
        chosenIndex = index;
      }
    }
    return waiting.splice(chosenIndex, 1)[0];
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (waiting.length > 0) {
      await yieldToMessages();
      const job = nextJob();
      running = job;
      try {
        job.resolve(await job.work());
      } catch (error) {
        job.reject(error);
      }
      running = null;
    }
    pumping = false;
  }

  function schedule(priority, key, work) {
    const job = { priority, key, work, order: sequence += 1 };
    job.done = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    waiting.push(job);
    pump();
    return job.done;
  }

  function promote(key, priority) {
    for (const job of waiting) {
      if (job.key === key && job.priority > priority) job.priority = priority;
    }
  }

  function hasWork(key) {
    return (running !== null && running.key === key) || waiting.some((job) => job.key === key);
  }

  function settledFor(key) {
    const pending = waiting.filter((job) => job.key === key).map((job) => job.done);
    if (running !== null && running.key === key) pending.push(running.done);
    return Promise.allSettled(pending);
  }

  return { schedule, promote, hasWork, settledFor };
}

module.exports = { createWorkQueue };
