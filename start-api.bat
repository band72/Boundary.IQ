@echo off
REM Start Boundary.IQ API in Development mode (loads appsettings.Development.json)
set ASPNETCORE_ENVIRONMENT=Development
dotnet run --project api\BoundaryIQ.Api\BoundaryIQ.Api.csproj --urls http://localhost:5050
