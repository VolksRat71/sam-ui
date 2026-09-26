/**
 * @generated SignedSource<<73ee0eacfc04b25a960a6680dd4a6e2f>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest, Mutation } from 'relay-runtime';
export type StartSessionInput = {
  path: string;
};
export type StudioSessionStartMutation$variables = {
  input: StartSessionInput;
};
export type StudioSessionStartMutation$data = {
  readonly startSession: {
    readonly objects: ReadonlyArray<{
      readonly frames: ReadonlyArray<number> | null | undefined;
      readonly nFrames: number;
      readonly objectId: number;
      readonly seeds: ReadonlyArray<{
        readonly frameIndex: number;
        readonly labels: ReadonlyArray<number>;
        readonly points: ReadonlyArray<ReadonlyArray<number>>;
      }>;
      readonly state: string;
    }>;
    readonly sessionId: string;
  };
};
export type StudioSessionStartMutation = {
  response: StudioSessionStartMutation$data;
  variables: StudioSessionStartMutation$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "defaultValue": null,
    "kind": "LocalArgument",
    "name": "input"
  }
],
v1 = [
  {
    "alias": null,
    "args": [
      {
        "kind": "Variable",
        "name": "input",
        "variableName": "input"
      }
    ],
    "concreteType": "StartSession",
    "kind": "LinkedField",
    "name": "startSession",
    "plural": false,
    "selections": [
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "sessionId",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "concreteType": "ObjectTrack",
        "kind": "LinkedField",
        "name": "objects",
        "plural": true,
        "selections": [
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "objectId",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "state",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "frames",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "nFrames",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "concreteType": "SeedFrame",
            "kind": "LinkedField",
            "name": "seeds",
            "plural": true,
            "selections": [
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "frameIndex",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "points",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "labels",
                "storageKey": null
              }
            ],
            "storageKey": null
          }
        ],
        "storageKey": null
      }
    ],
    "storageKey": null
  }
];
return {
  "fragment": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Fragment",
    "metadata": null,
    "name": "StudioSessionStartMutation",
    "selections": (v1/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "StudioSessionStartMutation",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "511bba78fa57683f7f1bfd4fc9b6b9d6",
    "id": null,
    "metadata": {},
    "name": "StudioSessionStartMutation",
    "operationKind": "mutation",
    "text": "mutation StudioSessionStartMutation(\n  $input: StartSessionInput!\n) {\n  startSession(input: $input) {\n    sessionId\n    objects {\n      objectId\n      state\n      frames\n      nFrames\n      seeds {\n        frameIndex\n        points\n        labels\n      }\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "0f8a32c999941ba582f618752962ddcc";

export default node;
