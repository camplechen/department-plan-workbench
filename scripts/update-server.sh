#!/usr/bin/env bash
# Linux/systemd 单实例更新；以服务用户执行 Git、npm，数据仅在停服后备份。
set -Eeuo pipefail
umask 077

fail() { printf '错误：%s\n' "$*" >&2; exit 1; }
project=${WORKBENCH_PROJECT_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)}
service=${WORKBENCH_SERVICE:-department-plan-workbench}
backup_root=${WORKBENCH_BACKUP_DIR:-/var/backups/department-plan-workbench}
command_path=${WORKBENCH_COMMAND_PATH:-/usr/local/bin/workbench-update}
bundle= force=0 install_command=0
for arg in "$@"; do
    case "$arg" in
        --install) install_command=1 ;;
        --restart) force=1 ;;
        --help|-h)
            printf '用法：workbench-update [更新包.bundle] [--restart]\n首次安装快捷命令：bash scripts/update-server.sh --install\n'
            exit 0 ;;
        -*) fail '不支持此选项，请使用 --help 查看用法。' ;;
        *) [[ -z "$bundle" ]] || fail '只能指定一个 bundle 更新包。'; bundle=$arg ;;
    esac
done
[[ $(uname -s) == Linux ]] || fail '此命令仅用于 Linux 云服务器，不会操作本机开发服务。'
[[ $(id -u) == 0 ]] || fail '请在服务器 root 终端运行，或使用 sudo。'
[[ -f "$project/server.js" && -d "$project/.git" ]] || fail '找不到服务器项目 Git 目录。'
project=$(cd -- "$project" && pwd -P)
if (( install_command )); then
    [[ -z "$bundle" ]] || fail '安装快捷命令时不能指定更新包。'
    mkdir -p -- "$(dirname -- "$command_path")"
    printf '#!/usr/bin/env bash\nexec bash %q "$@"\n' "$project/scripts/update-server.sh" > "$command_path"
    chmod 755 "$command_path"
    printf '已安装快捷命令，以后在 root 终端运行：workbench-update\n'
    exit 0
fi

# 脚本自身也可能被本次更新替换，因此先执行一份本机临时副本。
if [[ -z ${WORKBENCH_UPDATE_SNAPSHOT:-} ]]; then
    snapshot=$(mktemp /tmp/workbench-updater.XXXXXX)
    cp -- "${BASH_SOURCE[0]}" "$snapshot"
    exec env WORKBENCH_PROJECT_DIR="$project" WORKBENCH_UPDATE_SNAPSHOT="$snapshot" bash "$snapshot" "$@"
fi
stage= backup= stopped=0 changed=0 start_attempted=0
cleanup() {
    status=$?
    trap - EXIT INT TERM
    if (( status != 0 )); then
        if (( stopped && ! changed )); then
            if systemctl start "$service"; then
                printf '更新未切换代码，已请求恢复原服务。\n' >&2
            else
                printf '原服务未恢复，请检查服务器服务状态。\n' >&2
            fi
        elif (( changed )); then
            if (( start_attempted )); then systemctl stop "$service" || true; fi
            printf '更新未完成，服务保持停止。备份保留在：%s\n' "$backup" >&2
            printf '新版可能已迁移数据库，请勿直接用旧代码启动；应核对本次备份后恢复。\n' >&2
        else
            printf '尚未停止或切换原服务。\n' >&2
        fi
    fi
    if (( status != 0 )) && [[ -n "$stage" && -d "$stage" ]]; then
        diagnostics=$(mktemp -d "$backup_root/failed-$(date +%Y%m%d-%H%M%S)-XXXXXX" 2>/dev/null) || diagnostics=
        if [[ -n "$diagnostics" ]]; then
            for log in "$stage"/*.log; do [[ ! -f "$log" ]] || cp -- "$log" "$diagnostics/" || true; done
            printf '本机诊断日志：%s（不含数据备份）\n' "$diagnostics" >&2
        fi
    fi
    [[ -z "$stage" ]] || rm -rf -- "$stage"
    case ${WORKBENCH_UPDATE_SNAPSHOT:-} in /tmp/workbench-updater.*) rm -f -- "$WORKBENCH_UPDATE_SNAPSHOT" ;; esac
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for tool in systemctl sudo git tar curl flock python3 timeout; do
    command -v "$tool" >/dev/null || fail "缺少服务器工具：$tool"
done
exec 9>"${WORKBENCH_LOCK_FILE:-/run/department-plan-workbench-update.lock}"
flock -n 9 || fail '另一次更新正在执行，请稍后再试。'
systemctl is-active --quiet "$service" || fail '项目服务当前未运行，请先检查服务状态。'
run_user=$(systemctl show "$service" -p User --value)
[[ -n "$run_user" && "$run_user" != root ]] || fail '项目服务必须使用普通用户运行。'
working_dir=$(systemctl show "$service" -p WorkingDirectory --value)
[[ -d "$working_dir" && $(cd -- "$working_dir" && pwd -P) == "$project" ]] || fail '服务目录与本项目不一致，已停止更新。'
# 本脚本自动读取直接写入 systemd 的 DATA_DIR / PORT，不输出完整环境或凭据。
unit_env=$(systemctl show "$service" -p Environment --value)
env_value() {
    printf '%s' "$unit_env" | python3 -c 'import shlex,sys; values=dict(x.split("=",1) for x in shlex.split(sys.stdin.read()) if "=" in x); print(values.get(sys.argv[1],""))' "$1"
}
env_files=$(systemctl show "$service" -p EnvironmentFiles --value)
[[ -z "$env_files" ]] || fail '服务使用了 EnvironmentFile，需人工核对数据目录后更新。'
data_dir=$(env_value DATA_DIR)
[[ "$data_dir" == /* && -f "$data_dir/workbench.sqlite" ]] || fail '服务须配置绝对 DATA_DIR，且其中应有现有 SQLite 数据库。'
data_dir=$(cd -- "$data_dir" && pwd -P)
port=$(env_value PORT); port=${port:-3210}
[[ "$port" =~ ^[0-9]+$ ]] && (( 10#$port > 0 && 10#$port < 65536 )) || fail '服务端口配置无效。'
mkdir -p -- "$backup_root"
backup_root=$(cd -- "$backup_root" && pwd -P)
[[ "$backup_root" != "$data_dir" && "$backup_root" != "$data_dir/"* ]] || fail '备份目录不能位于运行数据目录内。'

as_user() {
    sudo -H -u "$run_user" bash -c '
        set -e
        if [[ -s "$HOME/.nvm/nvm.sh" ]]; then . "$HOME/.nvm/nvm.sh"; fi
        exec "$@"
    ' bash "$@"
}
as_user node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<13))process.exit(1)' || fail '服务用户需要 Node.js 22.13 或以上版本。'
[[ $(as_user git -C "$project" symbolic-ref --short HEAD) == main ]] || fail '当前部署分支不是 main。'
[[ -z $(as_user git -C "$project" status --porcelain) ]] || fail '服务器源码存在未提交修改，请先处理，脚本不会覆盖。'
old_commit=$(as_user git -C "$project" rev-parse HEAD)
stage=$(mktemp -d /tmp/workbench-update.XXXXXX)
chown "$run_user" "$stage"
if [[ -n "$bundle" ]]; then
    [[ -f "$bundle" ]] || fail '指定的 bundle 文件不存在。'
    cp -- "$bundle" "$stage/update.bundle"
    chown "$run_user" "$stage/update.bundle"
    as_user git -C "$project" bundle verify "$stage/update.bundle" >"$stage/git.log" 2>&1 || fail '更新包不完整或不适用于当前版本。'
    printf '正在读取本地 Git 更新包……\n'
    as_user git -C "$project" fetch "$stage/update.bundle" main >>"$stage/git.log" 2>&1 || fail '读取更新包失败。'
else
    # 拒绝 URL 中直接嵌入认证信息，避免 Git 出错时把凭据输出到日志。
    remote=$(as_user git -C "$project" remote get-url origin)
    case "$remote" in http://*@*|https://*@*) fail '远端 URL 含认证信息，请改用本机凭据管理。' ;; esac
    printf '正在获取 GitHub 更新，原服务保持运行……\n'
    as_user env GIT_TERMINAL_PROMPT=0 timeout 45 git -C "$project" fetch origin main >"$stage/git.log" 2>&1 || fail '连接 GitHub 失败；可改用 workbench-update /更新包路径.bundle。'
fi
target=$(as_user git -C "$project" rev-parse FETCH_HEAD)
as_user git -C "$project" merge-base --is-ancestor "$old_commit" "$target" || fail '服务器与目标版本存在分歧，不能快进更新。'
if [[ "$old_commit" == "$target" && "$force" == 0 ]]; then
    printf '代码已经是最新版本；如曾手动拉取但未重启，可执行 workbench-update --restart。\n'
    exit 0
fi
printf '正在独立目录安装依赖并测试，原服务保持运行……\n'
as_user mkdir -p "$stage/candidate"
as_user git -C "$project" archive --format=tar --output="$stage/source.tar" "$target"
as_user tar -xf "$stage/source.tar" -C "$stage/candidate"
# 不把生产 DATA_DIR / APP_ORIGIN 传给测试或安装脚本。
as_user env -u DATA_DIR -u APP_ORIGIN NODE_ENV=development npm_config_engine_strict=true npm --prefix "$stage/candidate" ci --cache "$stage/cache" --registry=https://registry.npmmirror.com --no-audit --no-fund >"$stage/prepare.log" 2>&1 || fail '依赖安装或资源构建失败，原服务继续运行。'
as_user env -u DATA_DIR -u APP_ORIGIN NODE_ENV=test npm --prefix "$stage/candidate" test >>"$stage/prepare.log" 2>&1 || fail '新版测试未通过，原服务继续运行。'
# 测试期间可能有人改动源码，切换前再检查一次。
[[ -z $(as_user git -C "$project" status --porcelain) && $(as_user git -C "$project" rev-parse HEAD) == "$old_commit" ]] || fail '准备期间源码发生变化，取消切换。'
backup=$(mktemp -d "$backup_root/update-$(date +%Y%m%d-%H%M%S)-XXXXXX")
printf '%s\n' "$old_commit" > "$backup/previous-commit.txt"
printf '%s\n' "$target" > "$backup/target-commit.txt"
printf '测试通过，正在停服备份数据库和图片……\n'
stopped=1
systemctl stop "$service"
! systemctl is-active --quiet "$service" || fail '服务未能停止，取消备份。'
# 不递归复制历史备份；tar 非零退出即阻止切换。
tar --exclude='./backups' -cpf "$backup/data.tar" -C "$data_dir" .
tar -tf "$backup/data.tar" >/dev/null
printf '备份归档已完成\n' > "$backup/backup-complete.txt"
printf '正在切换代码并使用已缓存依赖构建……\n'
changed=1
as_user git -C "$project" merge --ff-only "$target" >"$stage/switch.log" 2>&1 || fail '源码切换失败。'
as_user env -u DATA_DIR -u APP_ORIGIN NODE_ENV=development npm_config_engine_strict=true npm --prefix "$project" ci --offline --cache "$stage/cache" --no-audit --no-fund >>"$stage/switch.log" 2>&1 || fail '正式目录的离线构建失败。'
start_attempted=1
systemctl start "$service"
ready=0
for ((attempt=0; attempt<30; attempt++)); do
    if systemctl is-active --quiet "$service" && curl --noproxy '*' --silent --fail --connect-timeout 1 --max-time 2 "http://127.0.0.1:$port/login" -o "$stage/login.html"; then
        ready=1; break
    fi
    sleep 1
done
(( ready )) || fail '新版启动或登录页检查失败。'
printf '更新成功，当前提交：%.7s\n数据备份：%s/data.tar\n' "$target" "$backup"
