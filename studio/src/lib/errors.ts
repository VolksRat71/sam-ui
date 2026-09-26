// sam-ui (Apache-2.0). New file, not from SAM 2.

/**
 * A GraphQL error for a mutation, field or argument the backend does not
 * have means the backend runs older code than studio: say so, instead of
 * showing the raw text.
 */
export function explainGraphQLError(raw: string): string {
  // Relay wraps the server's message: "No data returned for operation `X`,
  // got error(s): <message> See the error `source` property ..."
  const wrapped = /got error\(s\):\s*([\s\S]*?)\s*See the error `source` property/.exec(raw);
  const message = wrapped != null ? wrapped[1] : raw;
  const field = /Cannot query field ['"]?(\w+)['"]? on type ['"]?(\w+)['"]?/.exec(message);
  if (field != null) {
    return `The backend is out of date: it has no ${field[1]} (${field[2]}). Restart it on the latest code, then try again.`;
  }
  const arg = /Unknown argument ['"]?(\w+)['"]?|Field ['"]?(\w+)['"]? is not defined by type/.exec(message);
  if (arg != null) {
    return `The backend is out of date: it does not know "${arg[1] ?? arg[2]}". Restart it on the latest code, then try again.`;
  }
  return message;
}
