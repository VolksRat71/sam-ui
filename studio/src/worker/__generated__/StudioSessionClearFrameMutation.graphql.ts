/**
 * @generated SignedSource<<f1f1788305305f1a086953a3ae640624>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest, Mutation } from 'relay-runtime';
export type ClearPointsInFrameInput = {
  frameIndex: number;
  objectId: number;
  sessionId: string;
};
export type StudioSessionClearFrameMutation$variables = {
  input: ClearPointsInFrameInput;
};
export type StudioSessionClearFrameMutation$data = {
  readonly clearPointsInFrame: {
    readonly frameIndex: number;
    readonly rleMaskList: ReadonlyArray<{
      readonly objectId: number;
      readonly rleMask: {
        readonly counts: string;
        readonly size: ReadonlyArray<number>;
      };
    }>;
  };
};
export type StudioSessionClearFrameMutation = {
  response: StudioSessionClearFrameMutation$data;
  variables: StudioSessionClearFrameMutation$variables;
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
    "concreteType": "RLEMaskListOnFrame",
    "kind": "LinkedField",
    "name": "clearPointsInFrame",
    "plural": false,
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
        "concreteType": "RLEMaskForObject",
        "kind": "LinkedField",
        "name": "rleMaskList",
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
            "concreteType": "RLEMask",
            "kind": "LinkedField",
            "name": "rleMask",
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
    "name": "StudioSessionClearFrameMutation",
    "selections": (v1/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "StudioSessionClearFrameMutation",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "dc492139221000a01cd50392fd815bc1",
    "id": null,
    "metadata": {},
    "name": "StudioSessionClearFrameMutation",
    "operationKind": "mutation",
    "text": "mutation StudioSessionClearFrameMutation(\n  $input: ClearPointsInFrameInput!\n) {\n  clearPointsInFrame(input: $input) {\n    frameIndex\n    rleMaskList {\n      objectId\n      rleMask {\n        size\n        counts\n      }\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "97f3935abbfd8afff04138de31647aa6";

export default node;
