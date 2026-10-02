/**
 * @generated SignedSource<<a8abdebe3e9729e8ac347fc8b61dca48>>
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
    readonly ranges: ReadonlyArray<{
      readonly end: number;
      readonly start: number;
      readonly state: string;
    }>;
    readonly seeds: ReadonlyArray<{
      readonly frameIndex: number;
      readonly labels: ReadonlyArray<number>;
      readonly mask: {
        readonly counts: string;
        readonly size: ReadonlyArray<number>;
      } | null | undefined;
      readonly points: ReadonlyArray<ReadonlyArray<number>>;
      readonly text: string | null | undefined;
    }>;
    readonly state: string;
    readonly tracks: ReadonlyArray<{
      readonly engine: string;
      readonly frames: ReadonlyArray<number> | null | undefined;
      readonly nFrames: number;
      readonly state: string;
    }>;
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
v1 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "state",
  "storageKey": null
},
v2 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "frames",
  "storageKey": null
},
v3 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "nFrames",
  "storageKey": null
},
v4 = [
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
      (v1/*: any*/),
      (v2/*: any*/),
      (v3/*: any*/),
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
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "text",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "concreteType": "RLEMask",
            "kind": "LinkedField",
            "name": "mask",
            "plural": false,
            "selections": [
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "size",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "counts",
                "storageKey": null
              }
            ],
            "storageKey": null
          }
        ],
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "concreteType": "EngineTrack",
        "kind": "LinkedField",
        "name": "tracks",
        "plural": true,
        "selections": [
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "engine",
            "storageKey": null
          },
          (v1/*: any*/),
          (v2/*: any*/),
          (v3/*: any*/)
        ],
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "concreteType": "ObjectRange",
        "kind": "LinkedField",
        "name": "ranges",
        "plural": true,
        "selections": [
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "start",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "end",
            "storageKey": null
          },
          (v1/*: any*/)
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
    "selections": (v4/*: any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "StudioSessionObjectTracksQuery",
    "selections": (v4/*: any*/)
  },
  "params": {
    "cacheID": "c1f5addf04ca6665ec82a7a4e8575c4f",
    "id": null,
    "metadata": {},
    "name": "StudioSessionObjectTracksQuery",
    "operationKind": "query",
    "text": "query StudioSessionObjectTracksQuery(\n  $sessionId: String!\n) {\n  objectTracks(sessionId: $sessionId) {\n    objectId\n    state\n    frames\n    nFrames\n    seeds {\n      frameIndex\n      points\n      labels\n      text\n      mask {\n        size\n        counts\n      }\n    }\n    tracks {\n      engine\n      state\n      frames\n      nFrames\n    }\n    ranges {\n      start\n      end\n      state\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "868a1df54aa2b20cae78326dac590041";

export default node;
