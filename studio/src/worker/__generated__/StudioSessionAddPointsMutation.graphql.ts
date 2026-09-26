/**
 * @generated SignedSource<<9d9b83d0877f8174e91bfd3cf0915d72>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest, Mutation } from 'relay-runtime';
export type AddPointsInput = {
  clearOldPoints: boolean;
  frameIndex: number;
  labels: ReadonlyArray<number>;
  objectId: number;
  points: ReadonlyArray<ReadonlyArray<number>>;
  sessionId: string;
};
export type StudioSessionAddPointsMutation$variables = {
  input: AddPointsInput;
};
export type StudioSessionAddPointsMutation$data = {
  readonly addPoints: {
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
export type StudioSessionAddPointsMutation = {
  response: StudioSessionAddPointsMutation$data;
  variables: StudioSessionAddPointsMutation$variables;
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
    "name": "addPoints",
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
    "name": "StudioSessionAddPointsMutation",
    "selections": (v1/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "StudioSessionAddPointsMutation",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "0bd7ce97b559a3a9bba48d3bf996c310",
    "id": null,
    "metadata": {},
    "name": "StudioSessionAddPointsMutation",
    "operationKind": "mutation",
    "text": "mutation StudioSessionAddPointsMutation(\n  $input: AddPointsInput!\n) {\n  addPoints(input: $input) {\n    frameIndex\n    rleMaskList {\n      objectId\n      rleMask {\n        size\n        counts\n      }\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "f78abdc5d1b558845fd84a14d8337050";

export default node;
