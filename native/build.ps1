$ErrorActionPreference = 'Stop'
$taskCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$taskGac = Join-Path $env:WINDIR 'Microsoft.NET\assembly\GAC_MSIL'
$taskReferences = foreach ($taskAssembly in @('UIAutomationClient', 'UIAutomationTypes', 'WindowsBase')) {
    $taskDll = Get-ChildItem -LiteralPath (Join-Path $taskGac $taskAssembly) -Recurse -Filter ($taskAssembly + '.dll') | Select-Object -First 1
    if (-not $taskDll) { throw "Missing .NET assembly: $taskAssembly" }
    '/reference:' + $taskDll.FullName
}
& $taskCompiler /nologo /target:exe ('/out:' + (Join-Path $PSScriptRoot 'A11yProbe.exe')) @taskReferences /reference:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'A11yProbe.cs')
if ($LASTEXITCODE -ne 0) { throw 'A11yProbe build failed.' }

# DragonNative.exe：龙爪自立原生层（窗口/截图/输入），独立进程，不依赖 dsh-orb。
$taskNative = foreach ($taskAssembly in @('System.Drawing', 'System.Web.Extensions')) {
    $taskDll = Get-ChildItem -LiteralPath (Join-Path $taskGac $taskAssembly) -Recurse -Filter ($taskAssembly + '.dll') | Select-Object -First 1
    if (-not $taskDll) { throw "Missing .NET assembly: $taskAssembly" }
    '/reference:' + $taskDll.FullName
}
$taskNative += '/reference:' + (Join-Path (Split-Path $taskCompiler) 'System.dll')
& $taskCompiler /nologo /noconfig /target:exe ('/out:' + (Join-Path $PSScriptRoot 'DragonNative.exe')) @taskNative (Join-Path $PSScriptRoot 'DragonNative.cs')
if ($LASTEXITCODE -ne 0) { throw 'DragonNative build failed.' }
