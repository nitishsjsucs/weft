# Prints the value of one KEY=value line of a secrets env file (design 9.3): the first line whose name is KEY, with
# spaces around the name and the value trimmed (the CF_SETUP_TOKEN line has a space after =), and one pair of
# surrounding quotes removed. The file is parsed, never sourced. Usage: awk -v key=NAME -f env-value.awk FILE
BEGIN { found = 0 }
found == 0 {
  line = $0
  sub(/\r$/, "", line)
  if (line ~ /^[ \t]*#/ || index(line, "=") == 0) next
  name = substr(line, 1, index(line, "=") - 1)
  gsub(/^[ \t]+|[ \t]+$/, "", name)
  sub(/^export[ \t]+/, "", name)
  if (name != key) next
  value = substr(line, index(line, "=") + 1)
  gsub(/^[ \t]+|[ \t]+$/, "", value)
  if (value ~ /^".*"$/ || value ~ /^'.*'$/) value = substr(value, 2, length(value) - 2)
  printf "%s", value
  found = 1
}
