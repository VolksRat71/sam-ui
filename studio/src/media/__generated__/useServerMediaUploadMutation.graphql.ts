/**
 * @generated SignedSource<<f6990ceaebe9252605be420fa42c30a1>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest, Mutation } from 'relay-runtime';
export type useServerMediaUploadMutation$variables = {
  file: any;
};
export type useServerMediaUploadMutation$data = {
  readonly uploadVideo: {
    readonly height: number;
    readonly id: any;
    readonly path: string;
    readonly posterPath: string | null | undefined;
    readonly width: number;
  };
};
export type useServerMediaUploadMutation = {
  response: useServerMediaUploadMutation$data;
  variables: useServerMediaUploadMutation$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "defaultValue": null,
    "kind": "LocalArgument",
    "name": "file"
  }
],
v1 = [
  {
    "alias": null,
    "args": [
      {
        "kind": "Variable",
        "name": "file",
        "variableName": "file"
      }
    ],
    "concreteType": "Video",
    "kind": "LinkedField",
    "name": "uploadVideo",
    "plural": false,
    "selections": [
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "id",
        "storageKey": null
      },
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
        "name": "posterPath",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "width",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "height",
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
    "name": "useServerMediaUploadMutation",
    "selections": (v1/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "useServerMediaUploadMutation",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "4858bcbce246ca87817c6e6f1fe7c5e2",
    "id": null,
    "metadata": {},
    "name": "useServerMediaUploadMutation",
    "operationKind": "mutation",
    "text": "mutation useServerMediaUploadMutation(\n  $file: Upload!\n) {\n  uploadVideo(file: $file) {\n    id\n    path\n    posterPath\n    width\n    height\n  }\n}\n"
  }
};
})();

(node as any).hash = "36a0368d5b5cbe7fd923ae5bb09580db";

export default node;
