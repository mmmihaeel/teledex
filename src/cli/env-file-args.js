export function parseEnvFileArg(argv = []) {
  const rest = [];
  let envFilePath = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env-file") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--env-file requires a path");
      }
      envFilePath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--env-file=")) {
      const value = arg.slice("--env-file=".length);
      if (!value) {
        throw new Error("--env-file requires a path");
      }
      envFilePath = value;
      continue;
    }
    rest.push(arg);
  }

  return { envFilePath, rest };
}

export function applyEnvFileArg(argv = [], env = process.env) {
  const parsed = parseEnvFileArg(argv);
  if (parsed.envFilePath) {
    env.ENV_FILE = parsed.envFilePath;
  }
  return parsed;
}
