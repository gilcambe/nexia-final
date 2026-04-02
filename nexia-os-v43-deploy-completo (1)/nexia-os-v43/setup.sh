#!/usr/bin/env bash
# NEXIA OS v43 — Setup Automatico de Deploy
set -euo pipefail
REPO_DIR="${1:-}"
if [ -z "$REPO_DIR" ]; then
  echo "Informe o caminho do repositorio:"
  read -r REPO_DIR
fi
REPO_DIR="$(realpath "$REPO_DIR")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FUNCTIONS_DIR="$REPO_DIR/netlify/functions"
mkdir -p "$FUNCTIONS_DIR"
copy_file() {
  local src="$1" dst="$2"
  [ -f "$dst" ] && cp "$dst" "${dst}.bak.$(date +%Y%m%d_%H%M%S)"
  cp "$src" "$dst"
  echo "  OK $(basename "$dst")"
}
copy_file "$SCRIPT_DIR/netlify.toml" "$REPO_DIR/netlify.toml"
copy_file "$SCRIPT_DIR/config.js"    "$REPO_DIR/config.js"
for f in cortex-agent cortex-chat cortex-learn cortex-logs cortex-memory middleware rag-engine action-engine tenant-admin; do
  copy_file "$SCRIPT_DIR/${f}.js" "$FUNCTIONS_DIR/${f}.js"
done
copy_file "$SCRIPT_DIR/index.html"        "$REPO_DIR/index.html"
copy_file "$SCRIPT_DIR/cortex-app.html"   "$REPO_DIR/nexia/cortex-app.html"
copy_file "$SCRIPT_DIR/architect.html"    "$REPO_DIR/nexia/architect.html"
copy_file "$SCRIPT_DIR/test-endpoints.js" "$REPO_DIR/test-endpoints.js"
echo "Setup concluido! node test-endpoints.js https://seu-site.netlify.app nexia"