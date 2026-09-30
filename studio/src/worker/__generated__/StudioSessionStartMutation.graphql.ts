/**
 * @generated SignedSource<<4623b9cefb5dc3f063509733437e13d6>>
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
    "selections": (v4/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "StudioSessionStartMutation",
    "selections": (v4/*: any*/)
  },
  "params": {
    "cacheID": "fdb7501fa8240b8f67245852e4a060c7",
    "id": null,
    "metadata": {},
    "name": "StudioSessionStartMutation",
    "operationKind": "mutation",
    "text": "mutation StudioSessionStartMutation(\n  $input: StartSessionInput!\n) {\n  startSession(input: $input) {\n    sessionId\n    objects {\n      objectId\n      state\n      frames\n      nFrames\n      seeds {\n        frameIndex\n        points\n        labels\n        text\n        mask {\n          size\n          counts\n        }\n      }\n      tracks {\n        engine\n        state\n        frames\n        nFrames\n      }\n      ranges {\n        start\n        end\n        state\n      }\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "7975b9c029c798c87d3d03d8200cdb1a";

export default node;
