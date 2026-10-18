$ErrorActionPreference = 'Stop'
$taskCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $taskCompiler /nologo /platform:x64 /target:exe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll ('/out:' + (Join-Path $PSScriptRoot 'Fixture.exe')) (Join-Path $PSScriptRoot 'Fixture.cs')
if ($LASTEXITCODE -ne 0) { throw 'Fixture build failed.' }
