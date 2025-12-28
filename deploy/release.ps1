param(
  [Parameter(Mandatory=$true)][string]$ServerHost,
  [Parameter(Mandatory=$true)][string]$ServerUser,
  [Parameter(Mandatory=$false)][int]$ServerPort = 22,
  [Parameter(Mandatory=$true)][string]$ServerDir, # e.g. /opt/panel
  [Parameter(Mandatory=$false)][string]$Tag = ""
)

$ErrorActionPreference = "Stop"

function Require-Cmd($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $name"
  }
}

Require-Cmd docker
Require-Cmd gzip
Require-Cmd scp
Require-Cmd ssh

if ([string]::IsNullOrWhiteSpace($Tag)) {
  $Tag = (Get-Date).ToString("yyyy-MM-dd_HHmmss")
}

$ImageLatest = "panel-app:latest"
$ImageVersion = "panel-app:$Tag"

Write-Host "[release] building image $ImageLatest ..."
docker build -t $ImageLatest .

Write-Host "[release] tagging $ImageVersion ..."
docker tag $ImageLatest $ImageVersion

$OutDir = Join-Path -Path (Get-Location) -ChildPath "releases"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$ArchiveName = "panel-app_$Tag.tar.gz"
$ArchivePath = Join-Path $OutDir $ArchiveName

Write-Host "[release] exporting to $ArchivePath ..."
docker save $ImageLatest $ImageVersion | gzip > $ArchivePath

$RemoteReleases = "$ServerDir/releases"
$RemoteArchive = "$RemoteReleases/$ArchiveName"

Write-Host "[release] uploading archive to $ServerUser@$ServerHost:$RemoteArchive ..."
ssh -p $ServerPort "$ServerUser@$ServerHost" "mkdir -p '$RemoteReleases'"
scp -P $ServerPort $ArchivePath "$ServerUser@$ServerHost:$RemoteArchive"

Write-Host "[release] running server update script..."
ssh -p $ServerPort "$ServerUser@$ServerHost" "cd '$ServerDir' && sh ./deploy/server-update.sh '$RemoteArchive'"

Write-Host "[release] done."





