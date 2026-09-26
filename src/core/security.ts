import { isAbsolute, relative, resolve, sep } from "node:path";

const SENSITIVE_ENV_PATTERN = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY)(?:$|_)/i;
const EXPLICIT_SENSITIVE = new Set([
  "OPENROUTER_API_KEY",
  "JEV_API_TOKEN",
  "TYPESAFE_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
]);

export function isSensitiveEnvironmentName(name: string): boolean {
  return EXPLICIT_SENSITIVE.has(name.toUpperCase()) || SENSITIVE_ENV_PATTERN.test(name);
}

/**
 * Child commands inherit ordinary process configuration (PATH, HOME, locale, proxies)
 * but not credentials. A graph can still receive an explicit value through its own
 * env binding; Jive never copies ambient secrets into that binding automatically.
 */
export function safeChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([name, value]) => value !== undefined && !isSensitiveEnvironmentName(name)),
  );
}

/**
 * Resolve a declarative cwd without allowing an explicit path to select a directory
 * outside the session workspace. This is a path-integrity guard, not a shell sandbox:
 * a bash script can still navigate unless a stronger host sandbox/policy is supplied.
 */
export function resolveWithinWorkspace(workspace: string, requested = "."): string {
  const root = resolve(workspace);
  const target = resolve(root, requested);
  const rel = relative(root, target);
  if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))) return target;
  throw new Error(`Working directory escapes the session workspace: ${requested}`);
}
