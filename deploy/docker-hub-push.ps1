# скрипт для пуша образа в приватный Docker Hub registry
# использование: .\deploy\docker-hub-push.ps1 -DockerHubUser "твой_юзер" -ImageTag "v1.0.0"

param(
  [Parameter(Mandatory=$true)][string]$DockerHubUser,
  [Parameter(Mandatory=$false)][string]$ImageTag = "latest",
  [Parameter(Mandatory=$false)][string]$Registry = "docker.io"
)

$ErrorActionPreference = "Stop"

function Require-Cmd($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $name"
  }
}

Require-Cmd docker

$ImageName = "panel-app"
$FullImageName = "$DockerHubUser/$ImageName"
$TaggedImage = "$FullImageName:$ImageTag"
$LatestImage = "$FullImageName:latest"

Write-Host "[build] building image $LatestImage ..."
docker build -t $LatestImage .

if ($ImageTag -ne "latest") {
  Write-Host "[tag] tagging $TaggedImage ..."
  docker tag $LatestImage $TaggedImage
}

Write-Host "[login] logging into Docker Hub..."
docker login $Registry

Write-Host "[push] pushing $LatestImage ..."
docker push $LatestImage

if ($ImageTag -ne "latest") {
  Write-Host "[push] pushing $TaggedImage ..."
  docker push $TaggedImage
}

Write-Host "[done] image available at: https://hub.docker.com/r/$DockerHubUser/$ImageName"
Write-Host "[done] заказчик может использовать: docker pull $FullImageName:latest"
