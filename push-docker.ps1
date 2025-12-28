$DockerHubUser = "roxxxy1"

docker build -t "$DockerHubUser/panel-app:latest" .
docker login
docker push "$DockerHubUser/panel-app:latest"

Write-Host "РіРѕС‚РѕРІРѕ! РѕР±СЂР°Р· Р·Р°Р»РёС‚: $DockerHubUser/panel-app:latest"
