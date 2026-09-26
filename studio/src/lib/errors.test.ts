// sam-ui (Apache-2.0). New file, not from SAM 2.
import {describe, expect, it} from 'vitest';
import {explainGraphQLError} from './errors';

describe('explainGraphQLError', () => {
  it('names an unknown mutation, field or argument as an out-of-date backend', () => {
    expect(explainGraphQLError("Cannot query field 'deleteVideo' on type 'Mutation'.")).toBe(
      'The backend is out of date: it has no deleteVideo (Mutation). Restart it on the latest code, then try again.',
    );
    expect(explainGraphQLError("Field 'purgeTracks' is not defined by type 'DeleteVideoInput'.")).toMatch(
      /out of date.*purgeTracks/,
    );
  });

  it('unwraps the message from Relay\'s wrapper', () => {
    const raw =
      "No data returned for operation `AppDeleteVideoMutation`, got error(s): 'uploads/a.mp4' is open in a session; " +
      'close the session first See the error `source` property for more information.';
    expect(explainGraphQLError(raw)).toBe("'uploads/a.mp4' is open in a session; close the session first");
    const stale =
      "No data returned for operation `AppDeleteVideoMutation`, got error(s): Cannot query field 'deleteVideo' on type " +
      "'Mutation'. See the error `source` property for more information.";
    expect(explainGraphQLError(stale)).toMatch(/^The backend is out of date: it has no deleteVideo/);
  });

  it('passes other errors through', () => {
    const msg = 'uploads/x.mp4 is open in a session: close the session first';
    expect(explainGraphQLError(msg)).toBe(msg);
  });
});
