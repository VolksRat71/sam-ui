/**
 * @generated SignedSource<<b4ac26630c41da57f45f6f307bdb177c>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest, Mutation } from 'relay-runtime';
export type DeleteVideoInput = {
  path: string;
  purgeTracks?: boolean;
};
export type AppDeleteVideoMutation$variables = {
  input: DeleteVideoInput;
};
export type AppDeleteVideoMutation$data = {
  readonly deleteVideo: {
    readonly path: string;
    readonly purged: boolean;
  };
};
export type AppDeleteVideoMutation = {
  response: AppDeleteVideoMutation$data;
  variables: AppDeleteVideoMutation$variables;
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
    "concreteType": "DeleteVideo",
    "kind": "LinkedField",
    "name": "deleteVideo",
    "plural": false,
    "selections": [
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "path",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "purged",
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
    "name": "AppDeleteVideoMutation",
    "selections": (v1/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "AppDeleteVideoMutation",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "f7b2fe1dc41c437f28a9c3a246d3110f",
    "id": null,
    "metadata": {},
    "name": "AppDeleteVideoMutation",
    "operationKind": "mutation",
    "text": "mutation AppDeleteVideoMutation(\n  $input: DeleteVideoInput!\n) {\n  deleteVideo(input: $input) {\n    path\n    purged\n  }\n}\n"
  }
};
})();

(node as any).hash = "99228cbbba933a4024fe4336d6180079";

export default node;
