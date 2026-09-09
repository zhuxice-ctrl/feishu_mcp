// install-desktop-bats.mjs — 在桌面生成「启动服务.bat」「关闭服务.bat」（feishu-mcp 生产）
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const desktop = execSync('powershell -NoProfile -Command "[Environment]::GetFolderPath(\'Desktop\')"', { encoding: 'utf8' }).trim();
if (!desktop) throw new Error('Desktop path not resolved');
console.log('Desktop = ' + desktop);

const START = `@echo off
chcp 65001 >nul
title feishu-mcp 生产服务 - 启动

rem 检查守护是否已在运行
powershell -NoProfile -Command "$s = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'prod-supervisor' }; if ($s) { exit 0 } else { exit 1 }"
if %errorlevel%==0 (
    echo [提示] 生产守护已在运行，无需重复启动。
    echo 如需重启请先双击「关闭服务.bat」。
    pause
    exit /b 0
)

echo 正在启动 feishu-mcp 生产服务（守护 + node + 隧道）...
"C:\Program Files\nodejs\node.exe" "F:\feishu_mcp\aily-local-file-mcp\scripts\sup-launch.mjs"

timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'prod-supervisor' }; if ($p) { Write-Host ('[成功] 生产守护已启动 PID ' + $p.ProcessId) } else { Write-Host '[警告] 未检测到守护进程，请查看日志 F:\feishu_mcp\aily-local-file-mcp\logs\prod-supervisor.log' }"
echo.
pause
`;

const STOP = `@echo off
chcp 65001 >nul
title feishu-mcp 生产服务 - 关闭

echo 正在关闭 feishu-mcp 生产服务...

rem 1) 停掉守护进程（连同其 node 子进程一起）
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'prod-supervisor' } | ForEach-Object { Write-Host ('停止守护 PID ' + $_.ProcessId); taskkill /F /T /PID $_.ProcessId }"

rem 2) 兜底：杀掉仍在监听 :3000 的进程
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo 停止残留进程 PID %%p
    taskkill /F /PID %%p
)

rem 3) 停掉生产隧道（只杀生产 UUID 的 cloudflared，不影响测试通道）
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cloudflared.exe' -and $_.CommandLine -match '6eb42d01' } | ForEach-Object { Write-Host ('停止隧道 PID ' + $_.ProcessId); taskkill /F /PID $_.ProcessId }"

echo.
echo 已关闭。重新启动请双击「启动服务.bat」。
pause
`;

writeFileSync(join(desktop, '启动服务.bat'), START, 'utf8');
writeFileSync(join(desktop, '关闭服务.bat'), STOP, 'utf8');
console.log('OK: 启动服务.bat / 关闭服务.bat written');
