#!/usr/bin/env bash
set -euo pipefail
source_dir="$1"
cd "$source_dir"
cargo vendor --locked vendor > lampaua-vendor-config.toml
mkdir -p .cargo
cat lampaua-vendor-config.toml >> .cargo/config.toml
archive="$LAMPAUA_MPV_SOURCES/subrandr-crates.tar.gz"
tar -czf "$archive" Cargo.lock vendor lampaua-vendor-config.toml .cargo/config.toml
python3 - "$archive" <<'PY'
import hashlib, json, pathlib, sys
p = pathlib.Path(sys.argv[1])
with p.open('rb') as f:
    sha = hashlib.file_digest(f, 'sha256').hexdigest()
p.with_suffix('.json').write_text(json.dumps({'name': 'subrandr-crates', 'archive': p.name, 'sha256': sha, 'size': p.stat().st_size}, indent=2) + '\n')
PY
