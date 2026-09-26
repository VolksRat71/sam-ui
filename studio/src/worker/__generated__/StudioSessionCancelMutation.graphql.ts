/**
 * @generated SignedSource<<014d19665ee3d321633da6b26042ba1b>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest, Mutation } from 'relay-runtime';
export type CancelPropagateInVideoInput = {
  sessionId: string;
};
export type StudioSessionCancelMutation$variables = {
  input: CancelPropagateInVideoInput;
};
export type StudioSessionCancelMutation$data = {
  readonly cancelPropagateInVideo: {
    readonly success: boolean;
  };
};
export type StudioSessionCancelMutation = {
  response: StudioSessionCancelMutation$data;
  variables: StudioSessionCancelMutation$variables;
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
    "concreteType": "CancelPropagateInVideo",
    "kind": "LinkedField",
    "name": "cancelPropagateInVideo",
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
    "name": "StudioSessionCancelMutation",
    "selections": (v1/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "StudioSessionCancelMutation",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "0ddf0dabe5d4af105aa8377303bb6db9",
    "id": null,
    "metadata": {},
    "name": "StudioSessionCancelMutation",
    "operationKind": "mutation",
    "text": "mutation StudioSessionCancelMutation(\n  $input: CancelPropagateInVideoInput!\n) {\n  cancelPropagateInVideo(input: $input) {\n    success\n  }\n}\n"
  }
};
})();

(node as any).hash = "6abe143bec0d92b40e470cf6679f9755";

export default node;
