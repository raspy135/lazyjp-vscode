#!/usr/bin/env bash
# Build a .vsix for this extension WITHOUT vsce.
#
# A .vsix is just an OPC ZIP: a "[Content_Types].xml" + "extension.vsixmanifest"
# at the root, and the actual extension files under an "extension/" folder. vsce
# needs Node >=16/20; this box has Node 12, so we assemble the package by hand.
# Everything here runs on Node 12 (only used to read package.json + escape XML)
# plus the system `zip`.
#
# Usage:  ./build-vsix.sh
# Output: lazyjp-<version>.vsix in the project root.
set -euo pipefail

cd "$(dirname "$0")"

# --- pick a node: prefer nvm's if present, else system ---
NODE="$(command -v node)"

# --- 1. compile TypeScript (.bin/tsc shim has noexec perms here, so call the
#        compiler entrypoint through node directly) ---
echo "==> compiling TypeScript"
"$NODE" ./node_modules/typescript/lib/tsc.js -p ./

# --- 2. read manifest fields from package.json (via node, with XML escaping) ---
read -r NAME VERSION PUBLISHER ENGINE < <("$NODE" -e '
  const p = require("./package.json");
  const eng = (p.engines && p.engines.vscode) || "^1.75.0";
  process.stdout.write([p.name, p.version, p.publisher, eng].join(" ") + "\n");
')
VSIX="${NAME}-${VERSION}.vsix"
echo "==> packaging ${VSIX}  (publisher=${PUBLISHER} engine=${ENGINE})"

# --- 3. stage files into a clean tree: <stage>/extension/... ---
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
EXTDIR="$STAGE/extension"
mkdir -p "$EXTDIR/out"

cp package.json "$EXTDIR/"
cp out/*.js "$EXTDIR/out/"          # ship code only, no .map / .ts
[ -f README.md ] && cp README.md "$EXTDIR/"
[ -f LICENSE ]   && cp LICENSE   "$EXTDIR/"

# --- 4. generate the two OPC root files (node handles XML escaping + kind list) ---
"$NODE" -e '
  const fs = require("fs");
  const p = require("./package.json");
  const stage = process.argv[1];
  const esc = s => String(s||"").replace(/[<>&"]/g, c =>
    ({ "<":"&lt;", ">":"&gt;", "&":"&amp;", "\"":"&quot;" }[c]));
  const cats = (p.categories && p.categories.length ? p.categories : ["Other"]).join(",");
  const kinds = (p.extensionKind && p.extensionKind.length ? p.extensionKind : ["workspace"]).join(",");
  const eng = (p.engines && p.engines.vscode) || "^1.75.0";

  fs.writeFileSync(stage + "/[Content_Types].xml",
`<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="png" ContentType="image/png" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>
`);

  fs.writeFileSync(stage + "/extension.vsixmanifest",
`<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(p.name)}" Version="${esc(p.version)}" Publisher="${esc(p.publisher)}" />
    <DisplayName>${esc(p.displayName || p.name)}</DisplayName>
    <Description xml:space="preserve">${esc(p.description)}</Description>
    <Tags></Tags>
    <Categories>${esc(cats)}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(eng)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${esc(kinds)}" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`);
' "$STAGE"

# --- 5. zip it up (paths must be relative to the stage root) ---
rm -f "$VSIX"
( cd "$STAGE" && zip -q -r -X "$OLDPWD/$VSIX" "[Content_Types].xml" extension.vsixmanifest extension )

echo "==> done: $VSIX"
unzip -l "$VSIX"
