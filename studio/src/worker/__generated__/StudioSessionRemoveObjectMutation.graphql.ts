/**
 * @generated SignedSource<<f47d08e0a87cc4762d95c798658b74e4>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest, Mutation } from 'relay-runtime';
export type RemoveObjectInput = {
  objectId: number;
  sessionId: string;
};
export type StudioSessionRemoveObjectMutation$variables = {
  input: RemoveObjectInput;
};
export type StudioSessionRemoveObjectMutation$data = {
  readonly removeObject: ReadonlyArray<{
    readonly frameIndex: number;
  }>;
};
export type StudioSessionRemoveObjectMutation = {
  response: StudioSessionRemoveObjectMutation$data;
  variables: StudioSessionRemoveObjectMutation$variables;
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
    "name": "removeObject",
    "plural": true,
    "selections": [
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "frameIndex",
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
    "name": "StudioSessionRemoveObjectMutation",
    "selections": (v1/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "StudioSessionRemoveObjectMutation",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "a831f1cfd82b59ba28ea732a55fa9717",
    "id": null,
    "metadata": {},
    "name": "StudioSessionRemoveObjectMutation",
    "operationKind": "mutation",
    "text": "mutation StudioSessionRemoveObjectMutation(\n  $input: RemoveObjectInput!\n) {\n  removeObject(input: $input) {\n    frameIndex\n  }\n}\n"
  }
};
})();

(node as any).hash = "4c64e9609ac52fe14571b5cd1dbe92d3";

export default node;
