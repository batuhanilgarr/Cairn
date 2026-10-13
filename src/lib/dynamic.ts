/**
 * Built-in dynamic variables: `{{$guid}}`, `{{$timestamp}}`, ... A fresh value is generated every time one is filled in,
 * so two `{{$guid}}` in the same request differ. A variable of the same name in the environment wins.
 */
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const randomString = (n: number, alphabet = ALNUM) => {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
};

const randomInt = (max: number) => crypto.getRandomValues(new Uint32Array(1))[0] % (max + 1);

type Dynamic = { desc: string; gen: () => string };

export const DYNAMIC_VARS: Record<string, Dynamic> = {
  $guid: { desc: "a new random UUID on every send", gen: () => crypto.randomUUID() },
  $uuid: { desc: "a new random UUID on every send", gen: () => crypto.randomUUID() },
  $timestamp: { desc: "current Unix time in seconds", gen: () => String(Math.floor(Date.now() / 1000)) },
  $isoTimestamp: { desc: "current time as ISO 8601 (UTC)", gen: () => new Date().toISOString() },
  $date: { desc: "today's date as YYYY-MM-DD (UTC)", gen: () => new Date().toISOString().slice(0, 10) },
  $randomInt: { desc: "a random integer from 0 to 1000", gen: () => String(randomInt(1000)) },
  $randomString: { desc: "12 random letters and digits", gen: () => randomString(12) },
  $randomEmail: { desc: "a random address at example.com", gen: () => `${randomString(10, "abcdefghijklmnopqrstuvwxyz0123456789")}@example.com` },
  $randomBoolean: { desc: "true or false", gen: () => (randomInt(1) === 1 ? "true" : "false") },
};

/** The value for a dynamic variable name (with the leading $), or undefined when it isn't one. */
export function dynamicValue(name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(DYNAMIC_VARS, name) ? DYNAMIC_VARS[name].gen() : undefined;
}

/** Name -> description, for editor highlighting, hovers and autocomplete. */
export const DYNAMIC_DESCRIPTIONS: Record<string, string> = Object.fromEntries(Object.entries(DYNAMIC_VARS).map(([k, v]) => [k, v.desc]));
