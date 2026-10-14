/**
 * Postman script compatibility, as plain JavaScript that is pasted into the script worker (see HARNESS in script.ts).
 * It covers what real collections use: pm.test / pm.expect (Chai-style), pm.environment & friends, pm.request,
 * pm.response and the legacy `tests[...]` / `postman.*` globals. Anything else fails loudly instead of silently doing nothing.
 *
 * It is a string, so it must not contain backticks, ${ or backslashes.
 */
export const PM_SHIM = `
function chaiExpect(actual, msg) {
  const st = { neg: false, deep: false };
  const show = (v) => { try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (e) { return String(v); } };
  const typeOf = (v) => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const same = (a, b) => st.deep ? deepEq(a, b) : Object.is(a, b);
  const check = (ok, what) => {
    if (st.neg ? ok : !ok) throw new Error((msg ? msg + ': ' : '') + 'expected ' + show(actual) + (st.neg ? ' not ' : ' ') + what);
  };
  const o = {};
  const getter = (name, fn) => Object.defineProperty(o, name, { get() { fn(); return o; } });
  ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'but', 'does', 'still', 'also', 'any', 'all'].forEach((n) => getter(n, () => {}));
  getter('not', () => { st.neg = !st.neg; });
  getter('deep', () => { st.deep = true; });
  getter('ok', () => check(!!actual, 'to be truthy'));
  getter('true', () => check(actual === true, 'to be true'));
  getter('false', () => check(actual === false, 'to be false'));
  getter('null', () => check(actual === null, 'to be null'));
  getter('undefined', () => check(actual === undefined, 'to be undefined'));
  getter('NaN', () => check(Number.isNaN(actual), 'to be NaN'));
  getter('exist', () => check(actual !== undefined && actual !== null, 'to exist'));
  getter('empty', () => check(typeof actual === 'string' || Array.isArray(actual) ? actual.length === 0 : (actual && typeof actual === 'object' ? Object.keys(actual).length === 0 : false), 'to be empty'));
  const method = (names, fn) => names.forEach((n) => { o[n] = (...a) => { const r = fn(...a); return r === undefined ? o : r; }; });
  method(['equal', 'equals', 'eq'], (e) => check(same(actual, e), 'to equal ' + show(e)));
  method(['eql', 'eqls'], (e) => check(deepEq(actual, e), 'to deeply equal ' + show(e)));
  method(['a', 'an'], (t) => check(typeOf(actual) === String(t).toLowerCase(), 'to be a ' + t));
  method(['include', 'includes', 'contain', 'contains'], (v) => {
    let ok;
    if (typeof actual === 'string') ok = actual.includes(v);
    else if (Array.isArray(actual)) ok = actual.some((x) => Object.is(x, v) || deepEq(x, v));
    else if (actual && typeof actual === 'object' && v && typeof v === 'object') ok = Object.keys(v).every((k) => deepEq(actual[k], v[k]));
    else ok = false;
    check(ok, 'to include ' + show(v));
  });
  method(['above', 'gt', 'greaterThan'], (n) => check(actual > n, 'to be above ' + n));
  method(['below', 'lt', 'lessThan'], (n) => check(actual < n, 'to be below ' + n));
  method(['least', 'gte'], (n) => check(actual >= n, 'to be at least ' + n));
  method(['most', 'lte'], (n) => check(actual <= n, 'to be at most ' + n));
  method(['within'], (a, b) => check(actual >= a && actual <= b, 'to be within ' + a + '..' + b));
  method(['closeTo', 'approximately'], (n, d) => check(Math.abs(actual - n) <= d, 'to be close to ' + n + ' (+/- ' + d + ')'));
  method(['match', 'matches'], (re) => check(new RegExp(re).test(String(actual)), 'to match ' + re));
  method(['string'], (s) => check(typeof actual === 'string' && actual.includes(s), 'to contain string ' + show(s)));
  method(['oneOf'], (list) => check(Array.isArray(list) && list.some((x) => Object.is(x, actual) || deepEq(x, actual)), 'to be one of ' + show(list)));
  method(['satisfy'], (fn) => check(!!fn(actual), 'to satisfy the function'));
  method(['lengthOf', 'length'], (n) => check(actual != null && actual.length === n, 'to have length ' + n));
  method(['keys', 'key'], (...ks) => { const list = Array.isArray(ks[0]) ? ks[0] : ks; check(actual != null && list.every((k) => Object.prototype.hasOwnProperty.call(actual, k)), 'to have keys ' + show(list)); });
  o.property = (name, ...rest) => {
    const has = actual != null && name in Object(actual);
    check(has && (rest.length === 0 || same(actual[name], rest[0])), 'to have property ' + name + (rest.length === 0 ? '' : ' of ' + show(rest[0])));
    return chaiExpect(has ? actual[name] : undefined, msg);
  };
  o.ownProperty = (name) => check(actual != null && Object.prototype.hasOwnProperty.call(actual, name), 'to have own property ' + name);
  return o;
}

function buildPm(a) {
  const { req, res, vars, env, test } = a;
  const varApi = {
    get: (k) => vars[k],
    set: (k, v) => env.set(k, v),
    has: (k) => Object.prototype.hasOwnProperty.call(vars, k),
    unset: (k) => env.set(k, ''),
    clear: () => {},
    toObject: () => ({ ...vars }),
    replaceIn: (s) => String(s).split('{{').map((part, i) => {
      if (i === 0) return part;
      const j = part.indexOf('}}');
      if (j < 0) return '{{' + part;
      const k = part.slice(0, j).trim();
      return (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : '{{' + part.slice(0, j) + '}}') + part.slice(j + 2);
    }).join(''),
  };
  const headerList = (list) => ({
    get: (k) => { const h = list().find(([x]) => x.toLowerCase() === String(k).toLowerCase()); return h ? h[1] : undefined; },
    has: (k) => list().some(([x]) => x.toLowerCase() === String(k).toLowerCase()),
    toObject: () => Object.fromEntries(list()),
  });
  const kv = (h, v) => (typeof h === 'string' ? (h.indexOf(':') > 0 ? [h.slice(0, h.indexOf(':')).trim(), h.slice(h.indexOf(':') + 1).trim()] : [h, v]) : [h.key, h.value]);
  const reqHeaders = Object.assign(headerList(() => req.headers), {
    add: (h, v) => { const [k, val] = kv(h, v); req.setHeader(k, val); },
    upsert: (h, v) => { const [k, val] = kv(h, v); req.setHeader(k, val); },
    remove: (k) => req.removeHeader(k),
  });
  const urlApi = {
    toString: () => req.url,
    getHost: () => { try { return new URL(req.url).hostname; } catch (e) { return ''; } },
    getPath: () => { try { return new URL(req.url).pathname; } catch (e) { return ''; } },
    getQueryString: () => { try { return new URL(req.url).search.replace('?', ''); } catch (e) { return ''; } },
  };
  const pmRequest = {
    url: urlApi,
    headers: reqHeaders,
    body: { mode: 'raw', toString: () => req.body || '' },
  };
  Object.defineProperty(pmRequest, 'method', { get: () => req.method, set: (v) => { req.method = String(v); } });
  Object.defineProperty(pmRequest.body, 'raw', { get: () => req.body, set: (v) => { req.body = String(v); } });

  let pmResponse;
  if (res) {
    const status = (n) => {
      const ok = typeof n === 'number' ? res.status === n : String(res.statusText).toLowerCase() === String(n).toLowerCase();
      if (!ok) throw new Error('expected response to have status ' + n + ' but got ' + res.status + ' ' + res.statusText);
    };
    const rangeCheck = (name, lo, hi) => ({ get() { if (!(res.status >= lo && res.status <= hi)) throw new Error('expected response to be ' + name + ' but got ' + res.status); return true; } });
    const be = {};
    Object.defineProperty(be, 'ok', rangeCheck('ok (2xx)', 200, 299));
    Object.defineProperty(be, 'success', rangeCheck('successful (2xx)', 200, 299));
    Object.defineProperty(be, 'redirection', rangeCheck('a redirection (3xx)', 300, 399));
    Object.defineProperty(be, 'clientError', rangeCheck('a client error (4xx)', 400, 499));
    Object.defineProperty(be, 'serverError', rangeCheck('a server error (5xx)', 500, 599));
    Object.defineProperty(be, 'error', rangeCheck('an error (4xx/5xx)', 400, 599));
    const have = {
      status,
      header: (k, v) => {
        const got = res.header(k);
        if (got === undefined) throw new Error('expected response to have header ' + k);
        if (v !== undefined && got !== v) throw new Error('expected header ' + k + ' to be ' + v + ' but got ' + got);
      },
      body: (x) => {
        const ok = x instanceof RegExp ? x.test(res.body) : res.body === x || res.body.includes(String(x));
        if (!ok) throw new Error('expected response body to match ' + x);
      },
      jsonBody: (path) => { const j = res.json(); if (path !== undefined && (j == null || !(path in j))) throw new Error('expected JSON body to have ' + path); },
    };
    pmResponse = {
      code: res.status,
      status: res.statusText,
      responseTime: res.time,
      responseSize: res.size,
      headers: headerList(() => res.headers),
      json: () => res.json(),
      text: () => res.body,
      to: { be, have },
    };
  }

  const pm = {
    info: { eventName: res ? 'test' : 'prerequest', requestName: '' },
    environment: varApi,
    variables: varApi,
    collectionVariables: varApi,
    globals: varApi,
    iterationData: varApi,
    request: pmRequest,
    response: pmResponse,
    test,
    expect: chaiExpect,
    sendRequest: () => { throw new Error('pm.sendRequest is not supported in Cairn scripts yet'); },
  };
  const postman = {
    setEnvironmentVariable: (k, v) => env.set(k, v),
    getEnvironmentVariable: (k) => vars[k],
    clearEnvironmentVariable: (k) => env.set(k, ''),
    setGlobalVariable: (k, v) => env.set(k, v),
    getGlobalVariable: (k) => vars[k],
    setNextRequest: () => {},
  };
  const legacyTests = {};
  const responseCode = res ? { code: res.status, name: res.statusText } : undefined;
  const requireStub = (name) => { throw new Error("require('" + name + "') is not available: scripts run in a sandbox without modules"); };
  return { pm, postman, legacyTests, responseBody: res ? res.body : undefined, responseCode, requireStub };
}
`;
