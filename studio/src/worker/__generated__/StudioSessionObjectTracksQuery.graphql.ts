/**
 * @generated SignedSource<<3ad306ebceb5460918cfc9261fa6688b>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest, Query } from 'relay-runtime';
export type StudioSessionObjectTracksQuery$variables = {
  sessionId: string;
};
export type StudioSessionObjectTracksQuery$data = {
  readonly objectTracks: ReadonlyArray<{
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
};
export type StudioSessionObjectTracksQuery = {
  response: StudioSessionObjectTracksQuery$data;
  variables: StudioSessionObjectTracksQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "defaultValue": null,
    "kind": "LocalArgument",
    "name": "sessionId"
  }
],
v1 = [
  {
    "alias": null,
    "args": [
      {
        "kind": "Variable",
        "name": "sessionId",
        "variableName": "sessionId"
      }
    ],
    "concreteType": "ObjectTrack",
    "kind": "LinkedField",
    "name": "objectTracks",
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
];
return {
  "fragment": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Fragment",
    "metadata": null,
    "name": "StudioSessionObjectTracksQuery",
    "selections": (v1/*: any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "StudioSessionObjectTracksQuery",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "a29425e5f0de7a77ed0bef655a63c474",
    "id": null,
    "metadata": {},
    "name": "StudioSessionObjectTracksQuery",
    "operationKind": "query",
    "text": "query StudioSessionObjectTracksQuery(\n  $sessionId: String!\n) {\n  objectTracks(sessionId: $sessionId) {\n    objectId\n    state\n    frames\n    nFrames\n    seeds {\n      frameIndex\n      points\n      labels\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "918a48ce571e5d2d90ab686c90a6cd42";

export default node;
