param(
  [Parameter(Mandatory = $true)]
  [string]$Name
)

Write-Host "Prisma: db push"
npx prisma db push
if ($LASTEXITCODE -ne 0) {
  Write-Host "db push failed"
  exit $LASTEXITCODE
}

Write-Host "Prisma: migrate resolve --applied $Name"
npx prisma migrate resolve --applied $Name
if ($LASTEXITCODE -ne 0) {
  Write-Host "migrate resolve failed"
  exit $LASTEXITCODE
}

Write-Host "Done"
