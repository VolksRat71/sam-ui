/**
 * @generated SignedSource<<a0293e5ea8bc5d7e8baaa5048d9da7d8>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest, Query } from 'relay-runtime';
export type useServerMediaVideosQuery$variables = Record<PropertyKey, never>;
export type useServerMediaVideosQuery$data = {
  readonly videos: {
    readonly edges: ReadonlyArray<{
      readonly node: {
        readonly height: number;
        readonly id: any;
        readonly path: string;
        readonly posterPath: string | null | undefined;
        readonly width: number;
      };
    }>;
  };
};
export type useServerMediaVideosQuery = {
  response: useServerMediaVideosQuery$data;
  variables: useServerMediaVideosQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = [
  {
    "alias": null,
    "args": null,
    "concreteType": "VideoConnection",
    "kind": "LinkedField",
    "name": "videos",
    "plural": false,
    "selections": [
      {
        "alias": null,
        "args": null,
        "concreteType": "VideoEdge",
        "kind": "LinkedField",
        "name": "edges",
        "plural": true,
        "selections": [
          {
            "alias": null,
            "args": null,
            "concreteType": "Video",
            "kind": "LinkedField",
            "name": "node",
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
        ],
        "storageKey": null
      }
    ],
    "storageKey": null
  }
];
return {
  "fragment": {
    "argumentDefinitions": [],
    "kind": "Fragment",
    "metadata": null,
    "name": "useServerMediaVideosQuery",
    "selections": (v0/*: any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [],
    "kind": "Operation",
    "name": "useServerMediaVideosQuery",
    "selections": (v0/*: any*/)
  },
  "params": {
    "cacheID": "e342dfddc8209c7a5edddad62ff7504d",
    "id": null,
    "metadata": {},
    "name": "useServerMediaVideosQuery",
    "operationKind": "query",
    "text": "query useServerMediaVideosQuery {\n  videos {\n    edges {\n      node {\n        id\n        path\n        posterPath\n        width\n        height\n      }\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "7be8fb3ebc750dbb30fe9d3fd0587f87";

export default node;
