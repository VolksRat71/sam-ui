/**
 * @generated SignedSource<<99c77ee8d655ed6b54e6fbf24f6a0bd9>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest, Mutation } from 'relay-runtime';
export type CloseSessionInput = {
  sessionId: string;
};
export type StudioSessionCloseMutation$variables = {
  input: CloseSessionInput;
};
export type StudioSessionCloseMutation$data = {
  readonly closeSession: {
    readonly success: boolean;
  };
};
export type StudioSessionCloseMutation = {
  response: StudioSessionCloseMutation$data;
  variables: StudioSessionCloseMutation$variables;
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
    "concreteType": "CloseSession",
    "kind": "LinkedField",
    "name": "closeSession",
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
    "name": "StudioSessionCloseMutation",
    "selections": (v1/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "StudioSessionCloseMutation",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "5a4d8ac3161c643a3819a557e17742e3",
    "id": null,
    "metadata": {},
    "name": "StudioSessionCloseMutation",
    "operationKind": "mutation",
    "text": "mutation StudioSessionCloseMutation(\n  $input: CloseSessionInput!\n) {\n  closeSession(input: $input) {\n    success\n  }\n}\n"
  }
};
})();

(node as any).hash = "6560a3d1ef6100d17f4a1b95df98605f";

export default node;
