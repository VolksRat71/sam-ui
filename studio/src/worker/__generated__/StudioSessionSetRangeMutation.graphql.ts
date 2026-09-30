/**
 * @generated SignedSource<<e3e052c4bd202ab55e26430d7b8ad835>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest, Mutation } from 'relay-runtime';
export type SetObjectRangeInput = {
  end: number;
  objectId: number;
  sessionId: string;
  start: number;
  state?: string | null | undefined;
};
export type StudioSessionSetRangeMutation$variables = {
  input: SetObjectRangeInput;
};
export type StudioSessionSetRangeMutation$data = {
  readonly setObjectRange: {
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
  };
};
export type StudioSessionSetRangeMutation = {
  response: StudioSessionSetRangeMutation$data;
  variables: StudioSessionSetRangeMutation$variables;
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
v4 = [
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
    "name": "setObjectRange",
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
    "name": "StudioSessionSetRangeMutation",
    "selections": (v4/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "StudioSessionSetRangeMutation",
    "selections": (v4/*: any*/)
  },
  "params": {
    "cacheID": "ece344a479a95d240b3fb8ff87ab88fd",
    "id": null,
    "metadata": {},
    "name": "StudioSessionSetRangeMutation",
    "operationKind": "mutation",
    "text": "mutation StudioSessionSetRangeMutation(\n  $input: SetObjectRangeInput!\n) {\n  setObjectRange(input: $input) {\n    objectId\n    state\n    frames\n    nFrames\n    seeds {\n      frameIndex\n      points\n      labels\n      text\n      mask {\n        size\n        counts\n      }\n    }\n    tracks {\n      engine\n      state\n      frames\n      nFrames\n    }\n    ranges {\n      start\n      end\n      state\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "33e11983b3e423c592e80903e2e13a3b";

export default node;
