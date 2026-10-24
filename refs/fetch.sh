#!/usr/bin/env bash
# Downloads the original game data and the reference source code into refs/.
# See refs/README.md for what each item is.
#
# Safe to re-run: downloads are checked against pinned SHA-256 sums, extracted data is
# stamped with the sum of its source, and repositories already at their pinned commit
# are left alone.
#
# Needs curl, git and bsdtar. macOS ships bsdtar as tar. GNU tar cannot read ISO images;
# on Debian and Ubuntu install libarchive-tools. Set TAR to use a specific bsdtar.
#
#   bash refs/fetch.sh

set -euo pipefail

refs="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# file|url|sha256
downloads=(
  "gdi95.iso|https://archive.org/download/gdi-95/GDI95.ISO|c90b284d30ae48f7a2f5a92e7d70915f3c5562d9e8a149db920a6a6378c98462"
  "nod95.iso|https://archive.org/download/gdi-95/NOD95.ISO|721df01b8d5bb11f39223232589b6d992d4d8a34539849d026030cc31c959b2a"
  "cnc-packages.zip|https://openra.ppmsite.com/cnc-packages.zip|a55b2c160b534f6d1b865ad6120e1f4fde8c418d47bb2fb1a9c72c586a5e1603"
)

# dir|url|commit
repos=(
  "cnc-tiberian-dawn|https://github.com/electronicarts/CnC_Tiberian_Dawn.git|e0d372dc582c053a699114942b984dad0457f9b3"
  "cnc-remastered-collection|https://github.com/electronicarts/CnC_Remastered_Collection.git|f1f0d42bc2dcd06d5d1df943c6150ab34bf307ae"
  "nyerguds-tiberian-dawn|https://github.com/Nyerguds/CnC_Tiberian_Dawn.git|3c9449ee14932f04d6e24eca2412dd063686676e"
  # release-20250330
  "openra|https://github.com/OpenRA/OpenRA.git|b4f3d8ae02b6bd6f4a3a5441e6d0daf7c5073787"
  "vanilla-conquer|https://github.com/TheAssemblyArmada/Vanilla-Conquer.git|ce83b59edd99cccac6cebaae054ca04962c744b7"
)

# Directories on the C&C Gold discs that hold no game data.
disc_excludes=(ACROREAD DXSETUP PLANETWW THEMES)

fail() { echo "error: $*" >&2; exit 1; }

for tool in curl git; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"
done

if [ -z "${TAR:-}" ]; then
  if command -v bsdtar >/dev/null 2>&1; then
    TAR=bsdtar
  elif tar --version 2>/dev/null | grep -q bsdtar; then
    TAR=tar
  else
    fail "bsdtar is required to read ISO images (Debian/Ubuntu: libarchive-tools)"
  fi
fi

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

sum_of() {
  local entry f s
  for entry in "${downloads[@]}"; do
    IFS='|' read -r f _ s <<<"$entry"
    if [ "$f" = "$1" ]; then printf '%s' "$s"; return; fi
  done
  fail "unknown download: $1"
}

stamped() { [ -f "$1/.done" ] && [ "$(tr -d '[:space:]' <"$1/.done")" = "$2" ]; }

get_download() {
  local file=$1 url=$2 sum=$3 path="$refs/downloads/$1"
  if [ -f "$path" ] && [ "$(sha256 "$path")" = "$sum" ]; then
    echo "ok        downloads/$file"
    return
  fi
  echo "download  downloads/$file <- $url"
  mkdir -p "$refs/downloads"
  curl -L --fail --retry 3 -o "$path.part" "$url"
  local actual
  actual="$(sha256 "$path.part")"
  if [ "$actual" != "$sum" ]; then
    rm -f "$path.part"
    fail "checksum mismatch for $file: expected $sum, got $actual"
  fi
  mv -f "$path.part" "$path"
}

# Copies the game data on one disc into cnc-gold/<name>/ with lower-case names: the MIX,
# VQA and VQP files in the root and INSTALL/CCLOCAL.MIX.
expand_disc() {
  local iso=$1 name=$2 sum out tmp f base
  sum="$(sum_of "$iso")"
  out="$refs/cnc-gold/$name"
  if stamped "$out" "$sum"; then
    echo "ok        cnc-gold/$name"
    return
  fi
  echo "extract   cnc-gold/$name <- downloads/$iso"
  tmp="$refs/cnc-gold/.tmp-$name"
  rm -rf "$tmp" "$out"
  mkdir -p "$tmp" "$out"
  local excludes=()
  for f in "${disc_excludes[@]}"; do excludes+=(--exclude "$f"); done
  "$TAR" -xf "$refs/downloads/$iso" -C "$tmp" "${excludes[@]}"
  # Files come out of an ISO image read-only.
  chmod -R u+w "$tmp"
  for f in "$tmp"/*; do
    [ -f "$f" ] || continue
    base="$(lower "$(basename "$f")")"
    case "$base" in
      *.mix | *.vqa | *.vqp) mv "$f" "$out/$base" ;;
    esac
  done
  mv "$tmp/INSTALL/CCLOCAL.MIX" "$out/cclocal.mix"
  rm -rf "$tmp"
  printf '%s\n' "$sum" >"$out/.done"
}

expand_zip() {
  local zip=$1 name=$2 sum out
  sum="$(sum_of "$zip")"
  out="$refs/cnc-gold/$name"
  if stamped "$out" "$sum"; then
    echo "ok        cnc-gold/$name"
    return
  fi
  echo "extract   cnc-gold/$name <- downloads/$zip"
  rm -rf "$out"
  mkdir -p "$out"
  "$TAR" -xf "$refs/downloads/$zip" -C "$out"
  printf '%s\n' "$sum" >"$out/.done"
}

# Fetches exactly one commit, without history, into source/<dir>/.
sync_repo() {
  local name=$1 url=$2 commit=$3 dir="$refs/source/$1"
  if [ -d "$dir/.git" ]; then
    if [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)" = "$commit" ]; then
      echo "ok        source/$name"
      return
    fi
  else
    git init -q "$dir"
    git -C "$dir" remote add origin "$url"
    # Keep the files byte for byte as the repository stores them.
    git -C "$dir" config core.autocrlf false
  fi
  echo "fetch     source/$name @ ${commit:0:7}"
  git -C "$dir" fetch -q --depth 1 origin "$commit"
  git -C "$dir" checkout -q --force FETCH_HEAD
}

for entry in "${downloads[@]}"; do
  IFS='|' read -r file url sum <<<"$entry"
  get_download "$file" "$url" "$sum"
done
expand_disc gdi95.iso gdi
expand_disc nod95.iso nod
expand_zip cnc-packages.zip openra
for entry in "${repos[@]}"; do
  IFS='|' read -r dir url commit <<<"$entry"
  sync_repo "$dir" "$url" "$commit"
done
echo done
