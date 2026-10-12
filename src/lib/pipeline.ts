import { sendRaw } from "./net";
import type { Environment, KV, OAuthConfig, RequestTab, ResponseData, RunOutput, TestResult } from "./types";
import { buildRequest, emptyKV } from "./util";
import { runAssertions, runCaptures } from "./assert";
import { runScript, type ScriptRequest } from "./script";
import { getToken, type TokenCache } from "./oauth";
import { applyDefaults, type Layer } from "./inherit";
import { interpolate } from "./util";

/** Session variables: set by scripts and captures, held in memory only, never written to disk. */
export type Session = Record<string, string>;

export const withSession = (env: Environment | undefined, session: Session): Environment => ({
  id: env?.id ?? "session",
  name: env?.name ?? "session",
  vars: [
    ...(env?.vars ?? []),
    ...Object.entries(session).map(([key, value]): KV => ({ ...emptyKV(), key, value })), // later entries win
  ],
});

export const varsOf = (env: Environment): Record<string, string> =>
  Object.fromEntries(env.vars.filter((v) => v.enabled && v.key).map((v) => [v.key, v.value]));

/** OAuth config with {{variables}} filled in from the environment and session. */
export function resolveOAuth(o: OAuthConfig, env: Environment): OAuthConfig {
  const sub = (s: string) => interpolate(s, env);
  return {
    ...o,
    authUrl: sub(o.authUrl), tokenUrl: sub(o.tokenUrl), clientId: sub(o.clientId), clientSecret: sub(o.clientSecret),
    scope: sub(o.scope), username: sub(o.username), password: sub(o.password),
    extra: o.extra.map((e) => ({ ...e, key: sub(e.key), value: sub(e.value) })),
  };
}

export type Outcome = {
  response?: ResponseData;
  /** Transport/OAuth/script-abort error: the request was not (successfully) sent. */
  error?: string;
  run: RunOutput;
  sent?: ReturnType<typeof buildRequest>;
};

function applyScriptEdits(spec: ReturnType<typeof buildRequest>, before: ScriptRequest, after: ScriptRequest) {
  if (after.url !== before.url) spec.url = after.url;
  if (after.method !== before.method) spec.method = after.method;
  if (after.body !== before.body) spec.body = after.body;
  const had = new Map(before.headers.map(([k, v]) => [k.toLowerCase(), v]));
  const now = new Map(after.headers.map(([k, v]) => [k.toLowerCase(), [k, v] as [string, string]]));
  spec.headers = spec.headers.filter(([k]) => !(had.has(k.toLowerCase()) && !now.has(k.toLowerCase())));
  for (const [lk, [k, v]] of now) {
    if (had.get(lk) === v) continue;
    const i = spec.headers.findIndex(([x]) => x.toLowerCase() === lk);
    if (i >= 0) spec.headers[i] = [k, v];
    else spec.headers.push([k, v]);
  }
}

export async function executeRequest(
  rawTab: RequestTab,
  deps: {
    env: Environment | undefined;
    session: Session;
    tokens: TokenCache;
    onSession: () => void;
    /** Defaults of the request's folders, outermost first. */
    layers?: Layer[];
  },
): Promise<Outcome> {
  const { tab, pre, post } = applyDefaults(rawTab, deps.layers ?? []);
  const run: RunOutput = { tests: [], logs: [], captured: {} };
  const setVars = (vars: Record<string, string>) => {
    if (!Object.keys(vars).length) return;
    Object.assign(deps.session, vars);
    Object.assign(run.captured, vars);
    deps.onSession();
  };
  const fail = (error: string): Outcome => ({ error, run });
  const eff = () => withSession(deps.env, deps.session);

  // 1. pre-request scripts (collection, folders, request): env.set() feeds {{variables}},
  //    req.* edits accumulate and apply on top of the built request.
  let edits: { before: ScriptRequest; after: ScriptRequest } | null = null;
  if (pre.length) {
    const before = buildRequest(tab, eff());
    const base: ScriptRequest = { method: before.method, url: before.url, headers: before.headers.map(([k, v]) => [k, v]), body: before.body };
    let cur = base;
    for (const code of pre) {
      const r = await runScript(code, { req: structuredClone(cur), vars: varsOf(eff()) });
      run.logs.push(...r.logs);
      run.tests.push(...r.tests);
      setVars(r.set);
      if (r.error) {
        run.scriptError = `Pre-request script: ${r.error}`;
        return fail(run.scriptError);
      }
      cur = r.req;
    }
    edits = { before: base, after: cur };
  }

  // 2. OAuth2
  const extra: [string, string][] = [];
  if (tab.authMode === "oauth2") {
    try {
      const t = await getToken(resolveOAuth(tab.oauth, eff()), deps.tokens);
      extra.push(["Authorization", `${tab.oauth.prefix || "Bearer"} ${t.accessToken}`]);
    } catch (e) {
      return fail(String((e as Error).message ?? e));
    }
  }

  // 3. send
  const spec = buildRequest(tab, eff(), extra);
  if (edits) applyScriptEdits(spec, edits.before, edits.after);
  let response: ResponseData;
  try {
    response = await sendRaw(spec);
  } catch (e) {
    return { error: String(e), run, sent: spec };
  }

  // 4. captures, assertions, post-response scripts
  const cap = runCaptures(tab.captures, response);
  setVars(cap.values);
  for (const v of cap.missed) run.logs.push(`capture: nothing found for "${v}"`);
  run.tests.push(...runAssertions(tab.assertions, response));

  for (const code of post) {
    const r = await runScript(code, {
      req: { method: spec.method, url: spec.url, headers: spec.headers, body: spec.body },
      res: response,
      vars: varsOf(eff()),
    });
    run.logs.push(...r.logs);
    run.tests.push(...r.tests);
    setVars(r.set);
    if (r.error) {
      run.scriptError = `Post-response script: ${r.error}`;
      run.tests.push({ name: "Post-response script ran without errors", passed: false, error: r.error } as TestResult);
    }
  }
  return { response, run, sent: spec };
}
