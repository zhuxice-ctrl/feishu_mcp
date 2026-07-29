/** OS runtime variables safe to pass to detached workers and tool children. */
const SAFE_RUNTIME_KEYS = new Set([
  "systemroot",
  "windir",
  "comspec",
  "pathext",
  "temp",
  "tmp",
  "tmpdir",
  "home",
  "userprofile",
  "localappdata",
  "appdata",
  "programdata",
  "programfiles",
  "programfiles(x86)",
  "commonprogramfiles",
  "commonprogramfiles(x86)",
  "processor_architecture",
  "number_of_processors",
  "os",
]);

/**
 * Excludes credentials, Node injection variables, task tokens, and PATH.
 * Adapters must provide a reviewed PATH/toolchain environment explicitly.
 */
export function safeRuntimeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && SAFE_RUNTIME_KEYS.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}
