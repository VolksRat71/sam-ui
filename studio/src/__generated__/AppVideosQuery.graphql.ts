/**
 * @generated SignedSource<<30ca5d7c5757920f092afa865c9eb954>>
 * @lightSyntaxTransform
 * @nogrep
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest, Query } from 'relay-runtime';
export type AppVideosQuery$variables = Record<PropertyKey, never>;
export type AppVideosQuery$data = {
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
export type AppVideosQuery = {
  response: AppVideosQuery$data;
  variables: AppVideosQuery$variables;
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
    "name": "AppVideosQuery",
    "selections": (v0/*: any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [],
    "kind": "Operation",
    "name": "AppVideosQuery",
    "selections": (v0/*: any*/)
  },
  "params": {
    "cacheID": "03f526855dbc834ed74bb5525d1f9c66",
    "id": null,
    "metadata": {},
    "name": "AppVideosQuery",
    "operationKind": "query",
    "text": "query AppVideosQuery {\n  videos {\n    edges {\n      node {\n        id\n        path\n        posterPath\n        width\n        height\n      }\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "59bf2904010be15c4f944086e5e99777";

export default node;
