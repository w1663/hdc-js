#!/system/bin/sh
# Sanitizes the whole release tree (sources + docs) before publishing.
# Replaces machine-specific absolute paths with portable placeholders. Idempotent.
set -e
FILES="oss-hdc-js/hdc.mjs oss-hdc-js/server.mjs oss-hdc-js/README.md oss-hdc-js/docs/PROTOCOL.md"
for f in $FILES; do
  [ -f "$f" ] || continue
  sed -i \
    -e 's#/data/user/[0-9]*/[a-zA-Z0-9._-]*/files/home#__HOME__#g' \
    -e 's#/data/data/[a-zA-Z0-9._-]*/files/home#__HOME__#g' \
    -e 's#~/harmony/publish/##g' \
    -e 's#~/harmony/hdc-js/##g' \
    -e 's#~/harmony/tools/#tools/#g' \
    -e 's#/sdcard/Download/dshx#__RUNTIME__#g' \
    -e 's#io[.]github[.][a-zA-Z0-9._-]*#__PKG__#g' \
    -e 's#/data/user/[0-9]*/[a-zA-Z0-9._-]*#__APP_DATA__#g' \
    "$f"
done
echo "sanitized: $FILES"
if grep -qE '__HOME__|__RUNTIME__|__PKG__|__APP_DATA__' $FILES 2>/dev/null; then
  echo "WARNING: placeholder left in output — review manually"
else
  echo "no machine-specific paths found"
fi
grep -rnE '/data/user/[0-9]|/data/data/[a-z]|~/harmony' $FILES 2>/dev/null && echo "STILL DIRTY" || echo "clean: 0 absolute home paths"
