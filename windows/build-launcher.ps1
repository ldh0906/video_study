$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compilerPath)) {
    throw 'Windows의 .NET Framework C# 컴파일러를 찾을 수 없습니다.'
}
$sourcePath = Join-Path $PSScriptRoot 'Launcher.cs'
$outputPath = Join-Path $repositoryRoot 'LectureLens.exe'
& $compilerPath /nologo /target:winexe /reference:System.Windows.Forms.dll "/out:$outputPath" $sourcePath
if ($LASTEXITCODE -ne 0) { throw 'LectureLens.exe 빌드에 실패했습니다.' }
Write-Output "생성 완료: $outputPath"
