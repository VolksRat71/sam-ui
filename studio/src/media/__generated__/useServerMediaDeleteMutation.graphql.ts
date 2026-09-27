/**
 * @generated SignedSource<<6fba6569ba95bad6a8c91155d7ca388b>>
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
export type useServerMediaDeleteMutation$variables = {
  input: DeleteVideoInput;
};
export type useServerMediaDeleteMutation$data = {
  readonly deleteVideo: {
    readonly path: string;
    readonly purged: boolean;
    readonly sessionsClosed: number;
  };
};
export type useServerMediaDeleteMutation = {
  response: useServerMediaDeleteMutation$data;
  variables: useServerMediaDeleteMutation$variables;
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
    "name": "useServerMediaDeleteMutation",
    "selections": (v1/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "useServerMediaDeleteMutation",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "58bc9c596d0fe2f378f44fa174c90406",
    "id": null,
    "metadata": {},
    "name": "useServerMediaDeleteMutation",
    "operationKind": "mutation",
    "text": "mutation useServerMediaDeleteMutation(\n  $input: DeleteVideoInput!\n) {\n  deleteVideo(input: $input) {\n    path\n    purged\n    sessionsClosed\n  }\n}\n"
  }
};
})();

(node as any).hash = "1611099d79a462e310ceb81f445a1dfd";

export default node;
