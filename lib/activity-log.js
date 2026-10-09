const OUTPUT_CHANNEL_NAME = 'YAML DSL';

function clockTimeOf(moment) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const time = `${pad(moment.getHours())}:${pad(moment.getMinutes())}:${pad(moment.getSeconds())}`;
  return `${time}.${pad(moment.getMilliseconds(), 3)}`;
}

function failureTextOf(error) {
  return error && error.message ? error.message : String(error);
}

function createActivityLog(outputChannel, now = () => new Date()) {
  function info(message) {
    outputChannel.appendLine(`[${clockTimeOf(now())}] ${message}`);
  }

  function failure(step, error) {
    info(`error: ${step} failed: ${failureTextOf(error)}`);
  }

  async function step(name, run, fallback) {
    try {
      return await run();
    } catch (error) {
      failure(name, error);
      return fallback;
    }
  }

  return { info, failure, step };
}

module.exports = { OUTPUT_CHANNEL_NAME, clockTimeOf, createActivityLog };
