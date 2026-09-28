# Initialize only the child shell used for packaging; never change system settings.
function Initialize-ReleaseEnvironment {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
        throw '找不到 Visual Studio C++ Build Tools，请先安装 Windows C++ 编译工具。'
    }
    $installations = & $vswhere -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json -utf8 | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw '无法查询 Visual Studio C++ 编译工具。' }
    foreach ($installation in $installations) {
        $toolsRoot = Join-Path $installation.installationPath 'VC/Tools/MSVC'
        $module = Join-Path $installation.installationPath 'Common7/Tools/Microsoft.VisualStudio.DevShell.dll'
        if (-not (Test-Path -LiteralPath $module -PathType Leaf)) { continue }
        $versions = Get-ChildItem -LiteralPath $toolsRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
        foreach ($version in $versions) {
            $required = @('include/stdarg.h', 'include/vcruntime.h', 'lib/x64/libcmt.lib', 'bin/Hostx64/x64/cl.exe', 'bin/Hostx64/x64/link.exe')
            $missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $version.FullName $_) -PathType Leaf) })
            if ($missing.Count) { continue }
            Import-Module $module
            Enter-VsDevShell -VsInstallPath $installation.installationPath -SkipAutomaticLocation -DevCmdArguments "-arch=x64 -host_arch=x64 -vcvars_ver=$($version.Name)" | Out-Null
            if (-not $env:VCToolsInstallDir -or -not $env:WindowsSdkDir) {
                throw 'Visual Studio 环境初始化失败，缺少 MSVC 或 Windows SDK。'
            }
            $bin = Join-Path $version.FullName 'bin/Hostx64/x64'
            $env:CC = Join-Path $bin 'cl.exe'
            $env:CXX = $env:CC
            $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = Join-Path $bin 'link.exe'
            Write-Host "Windows C++ 编译环境已准备：MSVC $($version.Name)"
            return
        }
    }
    throw '未找到完整的 Windows x64 C++ 工具链，请检查 MSVC 头文件、库和 Windows SDK。'
}
