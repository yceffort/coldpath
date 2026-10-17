#!/usr/bin/env bash
# Runs the analyzer on the base checkout (optional) and the pull request build.
set -eo pipefail
bin="$ANALYZER"
out="$RUNNER_TEMP/coldpath/out"
mkdir -p "$out"
rm -f "$out/report.json"

args=()
while IFS= read -r line; do
  # YAML block scalars keep trailing spaces, which would become part of the argument.
  line="${line%"${line##*[![:space:]]}"}"
  [[ "$line" =~ ^[[:space:]]*$ ]] || args+=("$line")
done <<< "$INPUT_ARGS"

baseline="$INPUT_BASELINE"
if [ -n "$INPUT_BASE_DIRECTORY" ]; then
  baseline="$RUNNER_TEMP/coldpath/base.json"
  # Budgets in args may fail the base build; its report is written first.
  (cd "$INPUT_BASE_DIRECTORY" && "$bin" "${args[@]}" --json "$baseline") || [ $? -eq 2 ]
fi

compare=()
if [ -n "$baseline" ]; then
  compare+=(--baseline "$(cd "$(dirname "$baseline")" && pwd)/$(basename "$baseline")")
  [ -z "$INPUT_MAX_ADDED_BYTES" ] || compare+=(--max-added-bytes "$INPUT_MAX_ADDED_BYTES")
  [ -z "$INPUT_MAX_ADDED_UNOBSERVED_BYTES" ] || compare+=(--max-added-unobserved-bytes "$INPUT_MAX_ADDED_UNOBSERVED_BYTES")
elif [ -n "$INPUT_MAX_ADDED_BYTES$INPUT_MAX_ADDED_UNOBSERVED_BYTES" ]; then
  echo "::error::max-added-* budgets need base-directory or baseline"
  exit 1
fi

cd "$INPUT_WORKING_DIRECTORY"
code=0
"$bin" "${args[@]}" ${compare[@]+"${compare[@]}"} \
  --json "$out/report.json" --markdown "$out/summary.md" --treemap "$out/treemap.html" || code=$?
if [ "$code" -ne 0 ] && [ "$code" -ne 2 ]; then
  echo "::error::coldpath analysis failed with exit code $code"
  exit "$code"
fi
# Budget failures write the report first; argument errors also exit 2 but before writing anything.
if [ "$code" -eq 2 ] && [ ! -f "$out/report.json" ]; then
  echo "::error::coldpath failed with exit code 2 (usage error)"
  exit 2
fi
[ "$code" -eq 0 ] || echo "::error::coldpath budget exceeded"
echo "exit-code=$code" >> "$GITHUB_OUTPUT"
echo "report=$out/report.json" >> "$GITHUB_OUTPUT"
