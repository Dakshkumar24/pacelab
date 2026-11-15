/**
 * PaceLab configuration. Everything held constant across modes lives here,
 * so the threshold is the only variable between Standard and Patient.
 */

/** The one experimental variable. */
export const EOT_THRESHOLD = {
  standard: 0.7,
  patient: 0.85
} as const;

export type Mode = keyof typeof EOT_THRESHOLD;

export const MODES: Mode[] = ["standard", "patient"];

/** Flux ends a turn after this much silence regardless of confidence. SDK default, set explicitly. */
export const EOT_TIMEOUT_MS = 5000;

/** Swap is a one-line change. Verify against the Workers AI deprecations list before the batch. */
export const LLM_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const TTS_MODEL = "@cf/deepgram/aura-1";
export const TTS_SPEAKER = "asteria";

export const SYSTEM_PROMPT = `You are a friendly scheduling assistant for a fictional dental clinic.
Reply in one or two short spoken sentences. No lists, no markdown, no emoji.
If the request seems incomplete, ask the person to finish their thought.`;

/** Durable Object class names as routeAgentRequest spells them on the wire. */
export const AGENT_FOR_MODE: Record<Mode, string> = {
  standard: "standard-voice-agent",
  patient: "patient-voice-agent"
};

// --- Safeguards on Workers AI spend -----------------------------------------

/** Calls allowed per UTC day across both modes. 24 trials plus retries. */
export const DAILY_CALL_CAP = 40;

/** A call is force-ended after this long, so a forgotten tab cannot bill all day. */
export const MAX_CALL_MS = 120_000;

/** How long an access token stays valid after the passphrase is accepted. */
export const TOKEN_TTL_MS = 60 * 60 * 1000;
