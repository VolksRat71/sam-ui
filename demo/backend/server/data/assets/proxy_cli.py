"""Build an explicitly opted-in auxiliary proxy without starting the server.

Example from demo/backend/server:
  SAM_UI_GENERATE_FRAME_ACCURATE_PROXIES=1 python -m data.assets.proxy_cli \
    --asset-dir /canonical/data/assets/SOURCE_SHA256 \
    --proxy-root /canonical/data/proxies --max-frames 7200

This does not switch playback, inference, export or legacy working-copy paths.
"""
import argparse
import json
from pathlib import Path
import sys

from .proxy import build_proxy
from .proxy_contract import ProxyRecipe


def main(argv=None) -> int:
    parser=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--asset-dir',type=Path,required=True)
    parser.add_argument('--proxy-root',type=Path,required=True)
    parser.add_argument('--max-frames',type=int,required=True)
    parser.add_argument('--max-width',type=int,default=1280)
    parser.add_argument('--max-height',type=int,default=720)
    args=parser.parse_args(argv)
    try:
        result=build_proxy(args.asset_dir,args.proxy_root,
                           ProxyRecipe(args.max_width,args.max_height),args.max_frames)
    except ValueError as exc:
        print(json.dumps({'error':str(exc)}),file=sys.stderr)
        return 1
    print(json.dumps(result,sort_keys=True))
    return 0


if __name__=='__main__':
    raise SystemExit(main())
