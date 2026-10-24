# Downloads the original game data and the reference source code into refs/.
# See refs/README.md for what each item is.
#
# Safe to re-run: downloads are checked against pinned SHA-256 sums, extracted data is
# stamped with the sum of its source, and repositories already at their pinned commit
# are left alone.
#
# Needs curl, git and bsdtar. The tar.exe shipped with Windows 10 and later is bsdtar.
#
#   pwsh refs/fetch.ps1
#   powershell -ExecutionPolicy Bypass -File refs\fetch.ps1

$ErrorActionPreference = 'Stop'
$Refs = $PSScriptRoot

$Downloads = @(
  @{ File = 'gdi95.iso'; Url = 'https://archive.org/download/gdi-95/GDI95.ISO'
     Sha256 = 'c90b284d30ae48f7a2f5a92e7d70915f3c5562d9e8a149db920a6a6378c98462' }
  @{ File = 'nod95.iso'; Url = 'https://archive.org/download/gdi-95/NOD95.ISO'
     Sha256 = '721df01b8d5bb11f39223232589b6d992d4d8a34539849d026030cc31c959b2a' }
  @{ File = 'cnc-packages.zip'; Url = 'https://openra.ppmsite.com/cnc-packages.zip'
     Sha256 = 'a55b2c160b534f6d1b865ad6120e1f4fde8c418d47bb2fb1a9c72c586a5e1603' }
)

$Repos = @(
  @{ Dir = 'cnc-tiberian-dawn'; Url = 'https://github.com/electronicarts/CnC_Tiberian_Dawn.git'
     Commit = 'e0d372dc582c053a699114942b984dad0457f9b3' }
  @{ Dir = 'cnc-remastered-collection'; Url = 'https://github.com/electronicarts/CnC_Remastered_Collection.git'
     Commit = 'f1f0d42bc2dcd06d5d1df943c6150ab34bf307ae' }
  @{ Dir = 'nyerguds-tiberian-dawn'; Url = 'https://github.com/Nyerguds/CnC_Tiberian_Dawn.git'
     Commit = '3c9449ee14932f04d6e24eca2412dd063686676e' }
  @{ Dir = 'openra'; Url = 'https://github.com/OpenRA/OpenRA.git'
     Commit = 'b4f3d8ae02b6bd6f4a3a5441e6d0daf7c5073787' }  # release-20250330
  @{ Dir = 'vanilla-conquer'; Url = 'https://github.com/TheAssemblyArmada/Vanilla-Conquer.git'
     Commit = 'ce83b59edd99cccac6cebaae054ca04962c744b7' }
)

# Directories on the C&C Gold discs that hold no game data.
$DiscExcludes = @('ACROREAD', 'DXSETUP', 'PLANETWW', 'THEMES')

function Invoke-Native([scriptblock] $Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "command failed with exit code ${LASTEXITCODE}: $Command" }
}

function Get-Sha256([string] $Path) {
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-Stamp([string] $Dir, [string] $Sum) {
  $stamp = Join-Path $Dir '.done'
  (Test-Path -LiteralPath $stamp) -and ((Get-Content -LiteralPath $stamp -Raw).Trim() -eq $Sum)
}

function Write-Stamp([string] $Dir, [string] $Sum) {
  [IO.File]::WriteAllText((Join-Path $Dir '.done'), "$Sum`n")
}

function Reset-Directory([string] $Dir) {
  if (Test-Path -LiteralPath $Dir) { Remove-Item -LiteralPath $Dir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
}

function Get-Download($Item) {
  $path = Join-Path $Refs "downloads/$($Item.File)"
  if ((Test-Path -LiteralPath $path) -and (Get-Sha256 $path) -eq $Item.Sha256) {
    Write-Host "ok        downloads/$($Item.File)"
    return
  }
  Write-Host "download  downloads/$($Item.File) <- $($Item.Url)"
  New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
  Invoke-Native { curl.exe -L --fail --retry 3 -o "$path.part" $Item.Url }
  $sum = Get-Sha256 "$path.part"
  if ($sum -ne $Item.Sha256) {
    Remove-Item -LiteralPath "$path.part"
    throw "checksum mismatch for $($Item.File): expected $($Item.Sha256), got $sum"
  }
  Move-Item -Force -LiteralPath "$path.part" -Destination $path
}

# Copies the game data on one disc into cnc-gold/<Name>/ with lower-case names: the MIX,
# VQA and VQP files in the root and INSTALL/CCLOCAL.MIX.
function Expand-Disc([string] $Iso, [string] $Name) {
  $item = $Downloads | Where-Object { $_.File -eq $Iso }
  $out = Join-Path $Refs "cnc-gold/$Name"
  if (Test-Stamp $out $item.Sha256) {
    Write-Host "ok        cnc-gold/$Name"
    return
  }
  Write-Host "extract   cnc-gold/$Name <- downloads/$Iso"
  $tmp = Join-Path $Refs "cnc-gold/.tmp-$Name"
  Reset-Directory $tmp
  $excludes = $DiscExcludes | ForEach-Object { '--exclude', $_ }
  Invoke-Native { tar -xf (Join-Path $Refs "downloads/$Iso") -C $tmp @excludes }
  Reset-Directory $out
  Get-ChildItem -LiteralPath $tmp -File |
    Where-Object { $_.Extension -in '.mix', '.vqa', '.vqp' } |
    ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination (Join-Path $out $_.Name.ToLowerInvariant()) }
  Move-Item -LiteralPath (Join-Path $tmp 'INSTALL/CCLOCAL.MIX') -Destination (Join-Path $out 'cclocal.mix')
  Remove-Item -LiteralPath $tmp -Recurse -Force
  Write-Stamp $out $item.Sha256
}

function Expand-Zip([string] $Zip, [string] $Name) {
  $item = $Downloads | Where-Object { $_.File -eq $Zip }
  $out = Join-Path $Refs "cnc-gold/$Name"
  if (Test-Stamp $out $item.Sha256) {
    Write-Host "ok        cnc-gold/$Name"
    return
  }
  Write-Host "extract   cnc-gold/$Name <- downloads/$Zip"
  Reset-Directory $out
  Invoke-Native { tar -xf (Join-Path $Refs "downloads/$Zip") -C $out }
  Write-Stamp $out $item.Sha256
}

# Fetches exactly one commit, without history, into source/<Dir>/.
function Sync-Repo($Repo) {
  $dir = Join-Path $Refs "source/$($Repo.Dir)"
  if (Test-Path -LiteralPath (Join-Path $dir '.git')) {
    $head = git -C $dir rev-parse HEAD 2>$null
    if ($head -eq $Repo.Commit) {
      Write-Host "ok        source/$($Repo.Dir)"
      return
    }
  } else {
    Invoke-Native { git init -q $dir }
    Invoke-Native { git -C $dir remote add origin $Repo.Url }
    # Keep the files byte for byte as the repository stores them.
    Invoke-Native { git -C $dir config core.autocrlf false }
  }
  Write-Host "fetch     source/$($Repo.Dir) @ $($Repo.Commit.Substring(0, 7))"
  Invoke-Native { git -C $dir fetch -q --depth 1 origin $Repo.Commit }
  Invoke-Native { git -C $dir checkout -q --force FETCH_HEAD }
}

$Downloads | ForEach-Object { Get-Download $_ }
Expand-Disc 'gdi95.iso' 'gdi'
Expand-Disc 'nod95.iso' 'nod'
Expand-Zip 'cnc-packages.zip' 'openra'
$Repos | ForEach-Object { Sync-Repo $_ }
Write-Host 'done'
