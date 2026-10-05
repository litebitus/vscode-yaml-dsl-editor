const path = require('path');

function discoverStack(filePath, environments) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const parent = path.basename(dir);
  const inEnv = environments.includes(parent);
  const commonDir = inEnv ? path.dirname(dir) : dir;
  const common = path.join(commonDir, base);
  const overlays = {};
  for (const env of environments) overlays[env] = path.join(commonDir, env, base);
  return {
    id: common,
    common,
    overlays,
    environments: environments.slice(),
    activeEnv: inEnv ? parent : null,
  };
}

function environmentOf(filePath, stack) {
  for (const [env, overlay] of Object.entries(stack.overlays)) {
    if (overlay === filePath) return env;
  }
  return null;
}

module.exports = { discoverStack, environmentOf };
