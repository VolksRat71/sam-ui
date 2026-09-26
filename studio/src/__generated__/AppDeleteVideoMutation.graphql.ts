/**
 * @generated SignedSource<<245a05badec22cf4f404be93e1708377>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest, Mutation } from 'relay-runtime';
export type DeleteVideoInput = {
  closeIdleSessions?: boolean;
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
    readonly sessionsClosed: number;
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
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "sessionsClosed",
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
    "cacheID": "b4f978ed3b920a8b90b9e75f45839643",
    "id": null,
    "metadata": {},
    "name": "AppDeleteVideoMutation",
    "operationKind": "mutation",
    "text": "mutation AppDeleteVideoMutation(\n  $input: DeleteVideoInput!\n) {\n  deleteVideo(input: $input) {\n    path\n    purged\n    sessionsClosed\n  }\n}\n"
  }
};
})();

(node as any).hash = "e1474b075fbee1ec7e5d39c8cefd9c1e";

export default node;
