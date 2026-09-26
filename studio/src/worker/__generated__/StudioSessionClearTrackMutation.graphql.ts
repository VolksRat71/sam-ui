/**
 * @generated SignedSource<<e508f8b483378a260f24d384f1d430ce>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest, Mutation } from 'relay-runtime';
export type ClearTrackInput = {
  objectId: number;
  sessionId: string;
};
export type StudioSessionClearTrackMutation$variables = {
  input: ClearTrackInput;
};
export type StudioSessionClearTrackMutation$data = {
  readonly clearTrack: {
    readonly frames: ReadonlyArray<number> | null | undefined;
    readonly nFrames: number;
    readonly objectId: number;
    readonly seeds: ReadonlyArray<{
      readonly frameIndex: number;
      readonly labels: ReadonlyArray<number>;
      readonly points: ReadonlyArray<ReadonlyArray<number>>;
    }>;
    readonly state: string;
  };
};
export type StudioSessionClearTrackMutation = {
  response: StudioSessionClearTrackMutation$data;
  variables: StudioSessionClearTrackMutation$variables;
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
    "concreteType": "ObjectTrack",
    "kind": "LinkedField",
    "name": "clearTrack",
    "plural": false,
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
];
return {
  "fragment": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Fragment",
    "metadata": null,
    "name": "StudioSessionClearTrackMutation",
    "selections": (v1/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "StudioSessionClearTrackMutation",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "675a7e7439441954931d787fe34e1a41",
    "id": null,
    "metadata": {},
    "name": "StudioSessionClearTrackMutation",
    "operationKind": "mutation",
    "text": "mutation StudioSessionClearTrackMutation(\n  $input: ClearTrackInput!\n) {\n  clearTrack(input: $input) {\n    objectId\n    state\n    frames\n    nFrames\n    seeds {\n      frameIndex\n      points\n      labels\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "038589e32e8a93a25dca156212d19cec";

export default node;
