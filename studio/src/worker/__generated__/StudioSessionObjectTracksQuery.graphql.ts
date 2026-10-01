/**
 * @generated SignedSource<<de4b18f69411423851911452db43331d>>
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
    readonly history: {
      readonly canRedo: boolean;
      readonly canUndo: boolean;
      readonly versions: ReadonlyArray<{
        readonly bounded: boolean;
        readonly clicks: number;
        readonly created: string | null | undefined;
        readonly current: boolean;
        readonly elapsedS: number | null | undefined;
        readonly engine: string;
        readonly key: string;
        readonly model: string;
        readonly nFrames: number | null | undefined;
        readonly seedFrames: number;
      }>;
    };
    readonly nFrames: number;
    readonly objectId: number;
    readonly ranges: ReadonlyArray<{
      readonly end: number;
      readonly score: number | null | undefined;
      readonly source: string | null | undefined;
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
v4 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "engine",
  "storageKey": null
},
v5 = [
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
          (v4/*: any*/),
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
          (v1/*: any*/),
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "source",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "score",
            "storageKey": null
          }
        ],
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "concreteType": "SeedHistory",
        "kind": "LinkedField",
        "name": "history",
        "plural": false,
        "selections": [
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "canUndo",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "canRedo",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "concreteType": "TrackVersion",
            "kind": "LinkedField",
            "name": "versions",
            "plural": true,
            "selections": [
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "key",
                "storageKey": null
              },
              (v4/*: any*/),
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "model",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "created",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "elapsedS",
                "storageKey": null
              },
              (v3/*: any*/),
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "clicks",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "seedFrames",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "bounded",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "current",
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
    "name": "StudioSessionObjectTracksQuery",
    "selections": (v5/*: any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "StudioSessionObjectTracksQuery",
    "selections": (v5/*: any*/)
  },
  "params": {
    "cacheID": "c8f71bdddb8605ddc76b13d754ca9e59",
    "id": null,
    "metadata": {},
    "name": "StudioSessionObjectTracksQuery",
    "operationKind": "query",
    "text": "query StudioSessionObjectTracksQuery(\n  $sessionId: String!\n) {\n  objectTracks(sessionId: $sessionId) {\n    objectId\n    state\n    frames\n    nFrames\n    seeds {\n      frameIndex\n      points\n      labels\n      mask {\n        size\n        counts\n      }\n    }\n    tracks {\n      engine\n      state\n      frames\n      nFrames\n    }\n    ranges {\n      start\n      end\n      state\n      source\n      score\n    }\n    history {\n      canUndo\n      canRedo\n      versions {\n        key\n        engine\n        model\n        created\n        elapsedS\n        nFrames\n        clicks\n        seedFrames\n        bounded\n        current\n      }\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "2be8ec7ed4f0e8d4ddb30130a301c9ff";

export default node;
