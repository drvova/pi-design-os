/**
 * Control-plane wire contract.
 *
 * Every command prints exactly one JSON envelope on stdout. Human-readable
 * progress goes to stderr so stdout stays machine-parseable. MCP tool results
 * carry the same envelope verbatim.
 */

export const SCHEMA_VERSION = 1;

/** Process exit codes. `WAIT_TIMEOUT` is not a failure. */
export const EXIT = {
  OK: 0,
  OPERATION_FAILED: 1,
  USAGE_ERROR: 2,
  AUTH_REQUIRED: 3,
  SERVER_UNAVAILABLE: 4,
  WAIT_TIMEOUT: 5,
};

/** Maps an error code to the exit code a caller should see. */
const EXIT_FOR_CODE = {
  USAGE_ERROR: EXIT.USAGE_ERROR,
  AUTH_REQUIRED: EXIT.AUTH_REQUIRED,
  SERVER_UNAVAILABLE: EXIT.SERVER_UNAVAILABLE,
  WAIT_TIMEOUT: EXIT.WAIT_TIMEOUT,
  OPERATION_FAILED: EXIT.OPERATION_FAILED,
};

export function ok(command, data) {
  return { schemaVersion: SCHEMA_VERSION, ok: true, command, data };
}

export function fail(command, code, message) {
  return { schemaVersion: SCHEMA_VERSION, ok: false, command, error: { code, message } };
}

/** Exit code implied by an envelope. */
export function exitCode(envelope) {
  if (envelope.ok) return EXIT.OK;
  return EXIT_FOR_CODE[envelope.error.code] ?? EXIT.OPERATION_FAILED;
}

/** An operational failure that carries a wire error code. */
export class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

export function usage(message) {
  return new CommandError('USAGE_ERROR', message);
}

/** Writes the envelope to stdout and returns the exit code. */
export function emit(envelope, stdout = process.stdout) {
  stdout.write(`${JSON.stringify(envelope)}\n`);
  return exitCode(envelope);
}

/** Writes progress to stderr, never stdout. */
export function progress(message, stderr = process.stderr) {
  stderr.write(`${message}\n`);
}
