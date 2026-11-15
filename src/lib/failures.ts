/**
 * Turning raw failures into something a person can act on. Two sources:
 * what Workers AI answered when speech recognition would not start, and what
 * the browser said when the microphone would not open.
 */

export type FailureCode =
  | "provider_quota"
  | "provider_auth"
  | "provider_unavailable"
  | "provider_error"
  | "stt_startup_failed"
  | "stt_connection_lost"
  | "startup_timeout"
  | "mic_denied"
  | "mic_missing"
  | "mic_busy"
  | "mic_unsupported"
  | "session_expired"
  | "daily_cap"
  | "attempt_cap"
  | "call_in_progress"
  | "call_finished"
  | "network"
  | "unknown";

export interface Failure {
  code: FailureCode;
  /** One or two plain sentences for the person at the screen. */
  message: string;
  /** What to do next. */
  action: string;
  /** Trying again right away could work. */
  retryable: boolean;
}

const TABLE: Record<FailureCode, Omit<Failure, "code">> = {
  provider_quota: {
    message:
      "Workers AI refused to start speech recognition because this account's free daily allocation is used up.",
    action: "Calls will work again after 00:00 UTC. No call slot was used.",
    retryable: false
  },
  provider_auth: {
    message: "Workers AI rejected the request as unauthorized.",
    action: "Check the Worker's AI binding in the Cloudflare dashboard.",
    retryable: false
  },
  provider_unavailable: {
    message: "Workers AI could not start speech recognition right now.",
    action: "Wait a moment and try again. No call slot was used.",
    retryable: true
  },
  provider_error: {
    message: "Workers AI returned an unexpected answer instead of a speech-recognition session.",
    action: "Try again. If it repeats, check the Worker logs for the provider's response.",
    retryable: true
  },
  stt_startup_failed: {
    message: "Speech recognition did not start.",
    action: "Try again. No call slot was used.",
    retryable: true
  },
  stt_connection_lost: {
    message: "The speech-recognition connection dropped during the call.",
    action: "End this call and start a new one. Exclude this trial if the drop affected it.",
    retryable: true
  },
  startup_timeout: {
    message: "The call did not start within 15 seconds.",
    action: "Check your connection and try again.",
    retryable: true
  },
  mic_denied: {
    message: "The browser blocked the microphone.",
    action: "Allow microphone access for this site in the address bar, then try again. No call slot was used.",
    retryable: true
  },
  mic_missing: {
    message: "No microphone was found.",
    action: "Connect a microphone or pick one in the browser's site settings, then try again.",
    retryable: true
  },
  mic_busy: {
    message: "The microphone is in use by another app or could not be opened.",
    action: "Close other apps using the microphone and try again.",
    retryable: true
  },
  mic_unsupported: {
    message: "This browser cannot open a microphone on this page.",
    action: "Use a current version of Chrome, Edge, Firefox or Safari over HTTPS.",
    retryable: false
  },
  session_expired: {
    message: "Your session has expired.",
    action: "Enter the passphrase again.",
    retryable: false
  },
  daily_cap: {
    message: "Today's call cap is used up.",
    action: "It resets at 00:00 UTC.",
    retryable: false
  },
  attempt_cap: {
    message: "Too many start attempts today.",
    action: "It resets at 00:00 UTC.",
    retryable: false
  },
  call_in_progress: {
    message: "Another call is still open or closing.",
    action: "Wait a few seconds and try again.",
    retryable: true
  },
  call_finished: {
    message: "This call has already finished.",
    action: "Start a new call.",
    retryable: true
  },
  network: {
    message: "The connection to PaceLab failed.",
    action: "Check your network and try again.",
    retryable: true
  },
  unknown: {
    message: "The call failed for a reason PaceLab could not identify.",
    action: "Try again. If it repeats, check the Worker logs.",
    retryable: true
  }
};

const CODES = Object.keys(TABLE) as FailureCode[];

export function describeFailure(code: string): Failure {
  const known = CODES.includes(code as FailureCode) ? (code as FailureCode) : "unknown";
  return { code: known, ...TABLE[known] };
}

/**
 * Classify what Workers AI returned instead of a WebSocket. Workers AI answers
 * a request it will not serve with an HTTP status and a JSON error body; the
 * exact wording is not documented, so this matches on status and on a few
 * stable words.
 */
export function classifyProviderResponse(status: number | undefined, body: string): FailureCode {
  const t = body.toLowerCase();
  if (status === 429 || /neuron|daily free allocation|quota|rate limit|capacity/.test(t)) {
    return "provider_quota";
  }
  if (status === 401 || status === 403 || /unauthor|authenticat|forbidden/.test(t)) {
    return "provider_auth";
  }
  if (status !== undefined && status >= 500) return "provider_unavailable";
  return "provider_error";
}

/** Map the error name from getUserMedia to a failure code. */
export function classifyMicError(name: string): FailureCode {
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return "mic_denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "mic_missing";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "mic_busy";
    default:
      return "unknown";
  }
}

/**
 * Keep a provider's error text short and free of anything that looks like a
 * credential before it is logged or sent to the browser.
 */
export function sanitizeProviderText(text: string): string {
  return text
    .replace(/(bearer\s+)[\w.~+/=-]+/gi, "$1[redacted]")
    .replace(/\b[\w-]{32,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
