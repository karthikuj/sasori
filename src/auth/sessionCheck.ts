/**
 * Session check (SCAN-236): pick a request that only works while logged in,
 * and tell from its answer whether the crawl is still logged in.
 *
 * Everything here is pure, so the rules can be tested without a browser. The
 * crawler supplies the observed requests and runs the probes.
 */

/** A request the app made by itself, seen while logging in. */
export interface ObservedRequest {
    url: string;
    method: string;
    /** Puppeteer resource type: `fetch`, `xhr`, `document`, ... */
    resourceType: string;
    status: number;
    /** Request headers, lower-case names. */
    headers: Record<string, string>;
}

/** What a probe saw. */
export interface ProbeResult {
    status: number;
    /** Content type without parameters, lower case; empty when absent. */
    contentType: string;
    /** URL after redirects, or the redirect target when redirects are not followed. */
    finalUrl: string;
    /** The response body, cut at {@link MAX_PROBE_BODY_CHARS}. */
    body: string;
}

/**
 * How a check tells a logout apart:
 * - `status`: without the login the request gets another status — a 401/403,
 *   another status class, or a redirect somewhere else (the login page).
 * - `body`: the status stays, the body changes. Markers found in the logged-in
 *   body and absent from the logged-out one must still be there.
 * - `regex`: the operator's `loggedInRegex` must still match the body.
 */
export type CheckKind = 'status' | 'body' | 'regex';

/** The request the crawl repeats to check it is still logged in. */
export interface SessionCheckRequest {
    url: string;
    /** Headers sent with the check: the app's own, minus anything the browser sets itself. */
    headers: Record<string, string>;
    /** The answer while logged in. */
    baseline: ProbeResult;
    kind: CheckKind;
    /** `body` checks: text only a logged-in answer contains. */
    markers?: string[];
    /** `regex` checks: the pattern source, from `sessionCheck.loggedInRegex`. */
    loggedInRegex?: string;
}

/** Longest body kept from a probe; markers and patterns are matched against it. */
export const MAX_PROBE_BODY_CHARS = 256 * 1024;

/** Most markers a `body` check keeps. */
export const MAX_MARKERS = 5;

export type CheckVerdict = 'ok' | 'loggedOut' | 'inconclusive';

/** Default time between checks: two minutes. */
export const DEFAULT_SESSION_CHECK_INTERVAL_MS = 120_000;

/** How many candidates are tried against the target at most. Each costs one request. */
export const MAX_VERIFIED_CANDIDATES = 5;

/** Paths that usually describe the logged-in user, preferred as the check. */
const SESSION_PATH_HINT = /\/(me|user|users\/me|session|sessions|profile|account|whoami|auth\/(me|user|session|status)|current[-_]?user)(\/|$|\?)/i;

/**
 * Headers worth repeating in a check. The browser adds cookies and the
 * forbidden headers (Origin, Referer, Sec-Fetch-*) itself; what the app adds
 * on its own is the token header and its custom `X-` headers.
 */
const REPLAYED_HEADER = /^(authorization|accept|x-[a-z0-9-]+)$/i;

/** Header names that carry credentials, removed for the credential-less request. */
const CREDENTIAL_HEADER = /^(cookie|authorization|proxy-authorization|x-csrf-token|x-xsrf-token)$/i;

/**
 * Whether a request can serve as the check: a fetch/XHR `GET`, in scope,
 * answered with 2xx. Only `GET`: the check repeats the request every few
 * minutes, and repeating a `POST` could change data.
 */
export function isCheckCandidate(request: ObservedRequest, inScope: (url: string) => boolean): boolean {
    if (request.method.toUpperCase() !== 'GET') {
        return false;
    }
    if (request.resourceType !== 'fetch' && request.resourceType !== 'xhr') {
        return false;
    }
    if (request.status < 200 || request.status >= 300) {
        return false;
    }
    return inScope(request.url);
}

/**
 * Scores a candidate: obvious session endpoints and token-bearing requests first.
 */
function candidateScore(request: ObservedRequest): number {
    let score = 0;
    let path = request.url;
    try {
        path = new URL(request.url).pathname;
    } catch {
        // keep the raw URL
    }
    if (SESSION_PATH_HINT.test(path)) {
        score += 2;
    }
    if (request.headers['authorization']) {
        score += 1;
    }
    return score;
}

/**
 * Filters the observed requests to check candidates, one per URL, best first.
 * Ties keep the order the app made them in.
 */
export function rankCandidates(
    requests: ObservedRequest[],
    inScope: (url: string) => boolean,
    limit: number = MAX_VERIFIED_CANDIDATES,
): ObservedRequest[] {
    const seen = new Set<string>();
    const candidates: Array<{ request: ObservedRequest; score: number; order: number }> = [];
    for (const request of requests) {
        if (seen.has(request.url) || !isCheckCandidate(request, inScope)) {
            continue;
        }
        seen.add(request.url);
        candidates.push({ request, score: candidateScore(request), order: candidates.length });
    }
    candidates.sort((a, b) => b.score - a.score || a.order - b.order);
    return candidates.slice(0, limit).map((c) => c.request);
}

/** The headers a check repeats. */
export function replayableHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (REPLAYED_HEADER.test(name)) {
            out[name.toLowerCase()] = value;
        }
    }
    return out;
}

/** The headers with every credential removed. */
export function stripCredentials(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (!CREDENTIAL_HEADER.test(name)) {
            out[name.toLowerCase()] = value;
        }
    }
    return out;
}

function statusClass(status: number): number {
    return Math.floor(status / 100);
}

function pathOf(url: string): string {
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch {
        return url;
    }
}

/**
 * Whether the status tells the two answers apart: a 401/403, another status
 * class, or an answer that ended up somewhere else (a redirect, usually to the
 * login page). The query string is ignored.
 */
export function statusDiffers(loggedIn: ProbeResult, other: ProbeResult): boolean {
    if (other.status === 401 || other.status === 403) {
        return true;
    }
    if (statusClass(other.status) !== statusClass(loggedIn.status)) {
        return true;
    }
    return pathOf(other.finalUrl) !== pathOf(loggedIn.finalUrl);
}

/**
 * Words worth using as markers: 4–64 characters. Markup is not stripped: what
 * every answer shares is excluded by the logged-out answer anyway, and markup
 * only a logged-in page has (a user menu) is as good a marker as its text.
 */
const TOKEN = /[A-Za-z0-9@._+-]{4,64}/g;

function tokens(body: string): Set<string> {
    return new Set(body.match(TOKEN) ?? []);
}

function markerScore(token: string): number {
    let score = token.length;
    if (token.includes('@')) {
        score += 100; // an email is the best sign of whose session this is
    }
    if (/[0-9]/.test(token) && /[A-Za-z]/.test(token)) {
        score += 10;
    }
    return score;
}

/**
 * Text only a logged-in answer contains: present in two logged-in answers and
 * absent from the logged-out one, best first.
 *
 * Two logged-in answers, not one, so that anything that changes per request
 * (a timestamp, a nonce, a per-request CSRF token) is never a marker. What is
 * left is what belongs to the session: typically the user's email, handle or
 * display name.
 */
export function deriveMarkers(loggedIn: ProbeResult, loggedInAgain: ProbeResult, loggedOut: ProbeResult): string[] {
    const again = tokens(loggedInAgain.body);
    const out = tokens(loggedOut.body);
    const markers = [...tokens(loggedIn.body)].filter((t) => again.has(t) && !out.has(t));
    markers.sort((a, b) => markerScore(b) - markerScore(a) || a.localeCompare(b));
    return markers.slice(0, MAX_MARKERS);
}

/** One candidate's three answers: twice logged in, once without credentials. */
export interface CandidateEvidence {
    url: string;
    headers: Record<string, string>;
    loggedIn: ProbeResult;
    loggedInAgain: ProbeResult;
    loggedOut: ProbeResult;
}

/**
 * Turns a candidate's answers into a check, or null when nothing tells a
 * logout apart. A status difference is preferred to a body difference: it is
 * the clearer signal.
 */
export function classifyCandidate(evidence: CandidateEvidence): SessionCheckRequest | null {
    const { url, headers, loggedIn, loggedInAgain, loggedOut } = evidence;
    if (statusClass(loggedIn.status) !== 2 || loggedOut.status === 0) {
        return null;
    }
    if (statusDiffers(loggedIn, loggedOut)) {
        return { url, headers, baseline: loggedIn, kind: 'status' };
    }
    const markers = deriveMarkers(loggedIn, loggedInAgain, loggedOut);
    if (markers.length > 0) {
        return { url, headers, baseline: loggedIn, kind: 'body', markers };
    }
    return null;
}

/**
 * Picks the check among classified candidates, which arrive best-ranked first:
 * the first `status` check, else the first `body` check.
 */
export function pickCheck(checks: Array<SessionCheckRequest | null>): SessionCheckRequest | null {
    const found = checks.filter((c): c is SessionCheckRequest => c !== null);
    return found.find((c) => c.kind === 'status') ?? found[0] ?? null;
}

/**
 * Reads a check's answer.
 *
 * A server error or a failed request is `inconclusive`, never a logout: a
 * target having a bad moment must not cost a re-login.
 */
export function judgeProbe(check: SessionCheckRequest, observed: ProbeResult): CheckVerdict {
    if (observed.status === 0 || observed.status >= 500) {
        return 'inconclusive';
    }
    if (check.kind === 'regex') {
        if (observed.status === 401 || observed.status === 403) {
            return 'loggedOut';
        }
        return new RegExp(check.loggedInRegex ?? '').test(observed.body) ? 'ok' : 'loggedOut';
    }
    if (statusDiffers(check.baseline, observed)) {
        return 'loggedOut';
    }
    if (check.kind === 'body') {
        const present = tokens(observed.body);
        return (check.markers ?? []).some((m) => present.has(m)) ? 'ok' : 'loggedOut';
    }
    return 'ok';
}

/**
 * Takes the app's latest token for the check's origin.
 *
 * An app that refreshes its token on its own sends the new one on its next
 * request. A check still sending the token seen at login would get a 401 and
 * report a logout that never happened, so the check follows the app.
 * @param check - The check to update.
 * @param requestUrl - URL of a request the app just made.
 * @param headers - That request's headers.
 * @return True when the check's token changed.
 */
export function refreshCheckToken(check: SessionCheckRequest, requestUrl: string, headers: Record<string, string>): boolean {
    const token = headers['authorization'];
    if (!token || check.headers['authorization'] === undefined || check.headers['authorization'] === token) {
        return false;
    }
    try {
        if (new URL(requestUrl).origin !== new URL(check.url).origin) {
            return false;
        }
    } catch {
        return false;
    }
    check.headers['authorization'] = token;
    return true;
}

const SESSION_STORAGE_KEY_HINT = /token|auth|session|jwt|msal|credential|bearer|access|id_token|refresh/i;
const JWT_LIKE = /^(Bearer\s+)?[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;

/**
 * Lists the `sessionStorage` keys that look like they hold the login.
 *
 * `sessionStorage` is the one place a login is not shared between windows of a
 * browser, so an app keeping its token there logs in only the window that ran
 * the recording. A key named like a token, or a value shaped like a JWT, is the
 * sign of it.
 * @param entries - The control window's `sessionStorage` after login.
 * @return Keys that look like a login, in the order given.
 */
export function sessionStorageLoginKeys(entries: Array<[string, string]>): string[] {
    const keys: string[] = [];
    for (const [key, value] of entries) {
        if (SESSION_STORAGE_KEY_HINT.test(key) || JWT_LIKE.test(value.trim()) || /"(access_?token|id_?token|secret)"/i.test(value)) {
            keys.push(key);
        }
    }
    return keys;
}
