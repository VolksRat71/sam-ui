/**
 * @generated SignedSource<<b75e071627c35b1d7c2c74fb8c1e4f16>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest, Mutation } from 'relay-runtime';
export type ClearPointsInVideoInput = {
  sessionId: string;
};
export type StudioSessionClearVideoMutation$variables = {
  input: ClearPointsInVideoInput;
};
export type StudioSessionClearVideoMutation$data = {
  readonly clearPointsInVideo: {
    readonly success: boolean;
  };
};
export type StudioSessionClearVideoMutation = {
  response: StudioSessionClearVideoMutation$data;
  variables: StudioSessionClearVideoMutation$variables;
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
    "concreteType": "ClearPointsInVideo",
    "kind": "LinkedField",
    "name": "clearPointsInVideo",
    "plural": false,
    "selections": [
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "success",
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
    "name": "StudioSessionClearVideoMutation",
    "selections": (v1/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "StudioSessionClearVideoMutation",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "2b36785553799d08fff9738cc1982eac",
    "id": null,
    "metadata": {},
    "name": "StudioSessionClearVideoMutation",
    "operationKind": "mutation",
    "text": "mutation StudioSessionClearVideoMutation(\n  $input: ClearPointsInVideoInput!\n) {\n  clearPointsInVideo(input: $input) {\n    success\n  }\n}\n"
  }
};
})();

(node as any).hash = "9493cdcbd831d402582571b760ea22ae";

export default node;
