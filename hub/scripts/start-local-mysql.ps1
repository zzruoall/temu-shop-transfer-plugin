param([string]$MysqlHome = 'D:\mysql-8.0.46-winx64')
$ErrorActionPreference = 'Stop'
$hub = Split-Path -Parent $PSScriptRoot
$storage = Join-Path (Split-Path -Parent $hub) '.local-mysql'
if (-not (Test-Path -LiteralPath (Join-Path $storage 'app.json'))) { throw '本地 MySQL 尚未配置，不能回退到旧 JSON。' }

# 专用回环端口与测试实例分开，不修改机器上的既有数据库服务。
if (-not (Get-NetTCPConnection -State Listen -LocalPort 33918 -ErrorAction SilentlyContinue)) {
    $arguments = @('--no-defaults', "--basedir=`"$MysqlHome`"", "--datadir=`"$(Join-Path $storage 'data')`"", '--port=33918', '--bind-address=127.0.0.1', '--mysqlx=OFF', '--innodb-buffer-pool-size=134217728', '--console')
    Start-Process -FilePath (Join-Path $MysqlHome 'bin\mysqld.exe') -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput (Join-Path $storage 'mysql.stdout.log') -RedirectStandardError (Join-Path $storage 'mysql.stderr.log') | Out-Null
    for ($n = 0; $n -lt 30; $n++) {
        if (Get-NetTCPConnection -State Listen -LocalPort 33918 -ErrorAction SilentlyContinue) { break }
        Start-Sleep -Seconds 1
    }
}
if (Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue) { throw '8787 已占用，不会自动停止其他服务。' }
$env:TEMU_MYSQL_CONFIG = Join-Path $storage 'app.json'
$env:ZINIAO_DATA_ROOT = $hub
$env:ZINIAO_BIND = '127.0.0.1'
$env:ZINIAO_PORT = '8787'
$env:ZINIAO_SEED = '0'
Start-Process -FilePath (Get-Command node).Source -ArgumentList 'server.mjs' -WorkingDirectory $hub -WindowStyle Hidden -RedirectStandardOutput (Join-Path $hub 'local-server.stdout.log') -RedirectStandardError (Join-Path $hub 'local-server.stderr.log') -PassThru | Select-Object Id
