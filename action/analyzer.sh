#!/usr/bin/env bash
# Provides the analyzer: built from this action's checkout, downloaded from npm, or a given binary.
set -eo pipefail
case "$INPUT_ANALYZER" in
  source)
    cargo build --locked --release --manifest-path "$GITHUB_ACTION_PATH/Cargo.toml" --target-dir "$RUNNER_TEMP/coldpath-target"
    bin="$RUNNER_TEMP/coldpath-target/release/coldpath"
    ;;
  npm)
    # The platform package lib/analyzer.ts resolves, at this action's version unless one is given.
    version="${INPUT_ANALYZER_VERSION:-$(node -p 'require(process.argv[1]).version' "$GITHUB_ACTION_PATH/package.json")}"
    package="@yceffort/coldpath-$(node -p 'process.platform + "-" + process.arch')@$version"
    dir="$RUNNER_TEMP/coldpath-npm"
    mkdir -p "$dir"
    tarball=$(cd "$dir" && npm pack --loglevel=error "$package" | tail -n 1)
    tar -xzf "$dir/$tarball" -C "$dir"
    bin="$dir/package/bin/coldpath"
    ;;
  *)
    # analyze.sh changes directory, so a relative path is resolved here.
    bin="$INPUT_ANALYZER"
    [[ "$bin" = /* ]] || bin="$PWD/$bin"
    ;;
esac
if [ ! -x "$bin" ]; then
  echo "::error::analyzer is not an executable file: $bin"
  exit 1
fi
"$bin" --version
echo "path=$bin" >> "$GITHUB_OUTPUT"
