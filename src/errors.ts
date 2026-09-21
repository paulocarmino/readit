/** Why a {@link UserFacingError} happened; used to classify calls in the dashboard. */
export type UserFacingKind = 'blocked' | 'login' | 'invalid' | 'user';

/**
 * Error whose message is meant to be shown to the agent/user as-is,
 * usually because a human has to do something (solve a captcha, log in, close another instance).
 */
export class UserFacingError extends Error {
  override readonly name = 'UserFacingError';

  constructor(
    message: string,
    readonly kind: UserFacingKind = 'user'
  ) {
    super(message);
  }
}

/**
 * Converts any thrown value into a readable message.
 *
 * @param error - Anything that was thrown
 * @returns A message string
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
