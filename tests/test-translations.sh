#!/usr/bin/env bash
# Checks that translations/en.yaml labels every option and port.
#
# Without an entry, the Configuration tab shows the raw key (upload_max_mb)
# and no help text, and the Network tab loses the warning that 7680 is
# unauthenticated. Nothing else would notice a new option added to the schema
# without one.

# shellcheck source=tests/lib.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

CURRENT_SUITE="translations"

CONFIG="$REPO_ROOT/claude-terminal/config.yaml"
EN="$REPO_ROOT/claude-terminal/translations/en.yaml"

# Keys indented by exactly two spaces under a top-level section, sorted.
# Quotes are dropped, so "7680/tcp" and 7680/tcp compare equal.
section_keys() {
    awk -v section="$2" '
        /^[^[:space:]#]/ { in_section = ($0 ~ "^" section ":") ; next }
        in_section && /^  [^[:space:]#-]/ {
            key = $1; sub(/:$/, "", key); gsub(/"/, "", key); print key
        }
    ' "$1" | sort
}

schema=$(section_keys "$CONFIG" schema)
ports=$(section_keys "$CONFIG" ports)

assert_eq "the schema has options to translate" "1" "$([ -n "$schema" ] && echo 1 || echo 0)"
assert_eq "every option has a translation, and nothing else does" \
    "$schema" "$(section_keys "$EN" configuration)"
assert_eq "every port has a network label, and nothing else does" \
    "$ports" "$(section_keys "$EN" network)"

# Each option entry carries both a name and a description.
entries=$(printf '%s\n' "$schema" | grep -c .)
assert_eq "every option has a name" "$entries" \
    "$(grep -c -E '^    name: [^[:space:]]' "$EN")"
assert_eq "every option has a description" "$entries" \
    "$(grep -c -E '^    description: [^[:space:]]' "$EN")"

finish_suite
