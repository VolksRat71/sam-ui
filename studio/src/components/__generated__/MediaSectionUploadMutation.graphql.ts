/**
 * @generated SignedSource<<7e7b2e674c4d8044d05717f8f92794f4>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest, Mutation } from 'relay-runtime';
export type MediaSectionUploadMutation$variables = {
  file: any;
};
export type MediaSectionUploadMutation$data = {
  readonly uploadVideo: {
    readonly height: number;
    readonly id: any;
    readonly path: string;
    readonly posterPath: string | null | undefined;
    readonly width: number;
  };
};
export type MediaSectionUploadMutation = {
  response: MediaSectionUploadMutation$data;
  variables: MediaSectionUploadMutation$variables;
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
    "name": "MediaSectionUploadMutation",
    "selections": (v1/*: any*/),
    "type": "Mutation",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": (v0/*: any*/),
    "kind": "Operation",
    "name": "MediaSectionUploadMutation",
    "selections": (v1/*: any*/)
  },
  "params": {
    "cacheID": "0e4883ebf7bc5e128acc872b623497a4",
    "id": null,
    "metadata": {},
    "name": "MediaSectionUploadMutation",
    "operationKind": "mutation",
    "text": "mutation MediaSectionUploadMutation(\n  $file: Upload!\n) {\n  uploadVideo(file: $file) {\n    id\n    path\n    posterPath\n    width\n    height\n  }\n}\n"
  }
};
})();

(node as any).hash = "285a7abf6609b414b7ff470607a37d28";

export default node;
