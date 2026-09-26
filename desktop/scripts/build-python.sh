#!/usr/bin/env bash
# sam-ui (Apache-2.0). New file, not from SAM 2.
#
# Build the Python the desktop app ships: a relocatable CPython from
# python-build-standalone, with the backend's locked dependencies and the sam2
# package installed into it. Output: desktop/build/python (electron-builder
# copies it into the app as Resources/python). macOS arm64.
#
#   PBS_TAG=20260924 bash scripts/build-python.sh     # pin the CPython build (default: this one)
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(cd .. && pwd)
PBS_TAG=${PBS_TAG:-20260924}
PY_VERSION=${PY_VERSION:-3.11.16}
ASSET="cpython-${PY_VERSION}+${PBS_TAG}-aarch64-apple-darwin-install_only.tar.gz"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${ASSET}"

rm -rf build/python build/cpython.tar.gz
mkdir -p build
echo "== CPython ${PY_VERSION} (${PBS_TAG})"
curl -fL --retry 3 -o build/cpython.tar.gz "$URL"
tar -xzf build/cpython.tar.gz -C build   # unpacks to build/python
rm build/cpython.tar.gz
PY=build/python/bin/python3
"$PY" --version

echo "== locked dependencies"
"$PY" -m pip install --no-cache-dir --upgrade pip
"$PY" -m pip install --no-cache-dir -r requirements.lock
echo "== sam2 (this repo, no CUDA extension)"
SAM2_BUILD_CUDA=0 "$PY" -m pip install --no-cache-dir --no-deps --no-build-isolation "$REPO"

echo "== trim"
find build/python -name "__pycache__" -type d -prune -exec rm -rf {} +
rm -rf build/python/lib/python3.11/site-packages/torch/include \
       build/python/lib/python3.11/test build/python/lib/python3.11/idlelib build/python/lib/python3.11/tkinter
"$PY" -c "import torch, sam2, flask, av, decord, pycocotools, transformers; print('imports ok; torch', torch.__version__, 'mps', torch.backends.mps.is_available())"
du -sh build/python
