/** AI is optional everywhere: callers catch these and fall back to non-AI behaviour. */
export class AiError extends Error {
  constructor(
    message: string,
    /** Safe to show to the user. */
    readonly userMessage: string = message,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AiDisabledError extends AiError {
  constructor() {
    super(
      "AI features are turned off for this organization",
      "AI features are turned off. An admin can enable them in Settings.",
    );
  }
}

export class AiNotConfiguredError extends AiError {
  constructor() {
    super(
      "No AI provider key or model is set up for this organization",
      "Add an AI provider API key in Settings → AI to use AI features.",
    );
  }
}

export class AiBudgetExceededError extends AiError {
  constructor(
    readonly used: number,
    readonly budget: number,
  ) {
    super(
      `Daily AI token budget used up (${used}/${budget})`,
      "Today's AI budget for this organization is used up. It resets at 00:00 UTC.",
    );
  }
}

export class AiRateLimitedError extends AiError {
  constructor(readonly retryAfterSeconds: number) {
    super(
      `AI request rate limit reached; retry in ${retryAfterSeconds}s`,
      "AI is busy right now. Try again in a moment.",
    );
  }
}

export interface Attempt {
  provider: string;
  model: string;
  reason: string;
}

export class AiUnavailableError extends AiError {
  constructor(readonly attempts: Attempt[]) {
    super(
      attempts.length === 0
        ? "No AI provider is configured"
        : `All AI providers failed: ${attempts.map((a) => `${a.provider}/${a.model}: ${a.reason}`).join("; ")}`,
      // The reasons are status codes and the provider's own error text (already redacted): they say what to fix.
      `AI is unavailable right now. Everything else keeps working.${
        attempts.length
          ? ` (${attempts.map((a) => `${a.provider}/${a.model}: ${a.reason}`).join("; ")})`
          : ""
      }`,
    );
  }
}
