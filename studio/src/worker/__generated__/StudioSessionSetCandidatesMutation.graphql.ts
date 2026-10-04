/**
 * @generated SignedSource<<0d236763dfb6d3248c4b48b4a238e0fc>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest, Mutation } from 'relay-runtime';
export type SetObjectCandidatesInput = {
  candidates: ReadonlyArray<CandidateRangeInput>;
  objectId: number;
  replace?: boolean;
  sessionId: string;
};
export type CandidateRangeInput = {
  end: number;
  score?: number | null | undefined;
  source: string;
  start: number;
};
export type StudioSessionSetCandidatesMutation$variables = {
  input: SetObjectCandidatesInput;
};
export type StudioSessionSetCandidatesMutation$data = {
  readonly setObjectCandidates: {
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
  };
};
export type StudioSessionSetCandidatesMutation = {
  response: StudioSessionSetCandidatesMutation$data;
  variables: StudioSessionSetCandidatesMutation$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "defaultValue": null,
    "kind": "LocalArgument",
    "name": "input"
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
        "name": "input",
        "variableName": "input"
      }
    ],
    "concreteType": "ObjectTrack",
    "kind": "LinkedField",
    "name": "setObjectCandidates",
    "plural": false,
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
    "name": "StudioSessionSetCandidatesMutation",
    "selections": (v5/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "StudioSessionSetCandidatesMutation",
    "selections": (v5/*: any*/)
  },
  "params": {
    "cacheID": "86752804e0974a7a3fa3d3db2b0d9829",
    "id": null,
    "metadata": {},
    "name": "StudioSessionSetCandidatesMutation",
    "operationKind": "mutation",
    "text": "mutation StudioSessionSetCandidatesMutation(\n  $input: SetObjectCandidatesInput!\n) {\n  setObjectCandidates(input: $input) {\n    objectId\n    state\n    frames\n    nFrames\n    seeds {\n      frameIndex\n      points\n      labels\n      mask {\n        size\n        counts\n      }\n    }\n    tracks {\n      engine\n      state\n      frames\n      nFrames\n    }\n    ranges {\n      start\n      end\n      state\n      source\n      score\n    }\n    history {\n      canUndo\n      canRedo\n      versions {\n        key\n        engine\n        model\n        created\n        elapsedS\n        nFrames\n        clicks\n        seedFrames\n        bounded\n        current\n      }\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "c8e7b6c1afa57ff71a05232322c32686";

export default node;
