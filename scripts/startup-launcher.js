// feishu-mcp 生产守护开机自启（WSH 隐藏窗口拉起 sup-launch.mjs）
var sh = new ActiveXObject("WScript.Shell");
sh.Run('"C:\\Program Files\\nodejs\\node.exe" "F:\\feishu_mcp\\aily-local-file-mcp\\scripts\\sup-launch.mjs"', 0, false);
