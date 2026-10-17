#!/usr/bin/env bash
# Creates or updates the single bot comment that starts with the marker.
set -eo pipefail
marker='<!-- coldpath-report -->'
body="$RUNNER_TEMP/coldpath/comment.md"
summary="$RUNNER_TEMP/coldpath/out/summary.md"
if [ ! -f "$summary" ]; then
  echo "::error::$summary is missing; the analysis step wrote no summary"
  exit 1
fi
{
  echo "$marker"
  [ "$EXIT_CODE" = 0 ] || printf '> [!CAUTION]\n> Budget exceeded. See the failures at the end of this summary.\n\n'
  # GitHub rejects comment bodies over 65,536 characters.
  if [ "$(wc -c < "$summary")" -gt 60000 ]; then
    head -c 60000 "$summary"
    printf '\n\n_Summary truncated. The full Markdown is in the artifact._\n'
  else
    cat "$summary"
  fi
  [ -z "$ARTIFACT_URL" ] || printf '\n[Download the HTML treemap and JSON report](%s)\n' "$ARTIFACT_URL"
} > "$body"

id=$(gh api "repos/$REPOSITORY/issues/$PULL_REQUEST/comments" --paginate \
  --jq ".[] | select(.user.type == \"Bot\" and (.body | startswith(\"$marker\"))) | .id" | head -n 1)
# Fork pull requests get a read-only token; the report still exists as an artifact.
if [ -n "$id" ]; then
  gh api -X PATCH "repos/$REPOSITORY/issues/comments/$id" -F body=@"$body" > /dev/null \
    || echo "::warning::could not update the coldpath comment"
else
  gh api "repos/$REPOSITORY/issues/$PULL_REQUEST/comments" -F body=@"$body" > /dev/null \
    || echo "::warning::could not create the coldpath comment"
fi
