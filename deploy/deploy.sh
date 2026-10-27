#!/usr/bin/env bash
# FutureNutra (Astro static site) - one-shot deploy on port 8080.
#
# Standalone: does NOT touch the CampusAI stack on port 80.
# Idempotent: safe to re-run; it recreates the container from the current site/.
#
# Usage:
#   bash deploy.sh              # deploy
#   bash deploy.sh --status     # container state + recent logs
#   bash deploy.sh --rollback   # stop and remove (site files stay on disk)

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 支持两种目录布局，自动定位 docker-compose.yml 所在目录：
#
#   A) 仓库内开发布局               B) 部署包解压后的扁平布局
#      futurnutra/                     futurnutra/
#      ├── dist/                       ├── deploy.sh      ← 本脚本
#      └── deploy/                     ├── docker-compose.yml
#          ├── deploy.sh  ← 本脚本      ├── nginx.conf
#          ├── docker-compose.yml       └── site/
#          ├── nginx.conf
#          └── site/
#
# 从前这里无条件 `cd "$SCRIPT_DIR/.."`，只认布局 A；
# 而打包脚本产出的是布局 B，于是在服务器上直接报
# 「缺少 docker-compose.yml」——脚本自己把自己坑了。
# 现在改成按文件存在性探测，两种布局都能跑。
if [[ -f "${SCRIPT_DIR}/docker-compose.yml" ]]; then
  ROOT_DIR="${SCRIPT_DIR}"                    # 布局 B（部署包）
elif [[ -f "${SCRIPT_DIR}/../docker-compose.yml" ]]; then
  ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"  # 布局 A（仓库内）
else
  printf '找不到 docker-compose.yml。\n' >&2
  printf '  已检查: %s\n' "${SCRIPT_DIR}/docker-compose.yml" >&2
  printf '  已检查: %s\n' "${SCRIPT_DIR}/../docker-compose.yml" >&2
  printf '请确认部署包已完整解压（应含 deploy.sh / docker-compose.yml / nginx.conf / site/）。\n' >&2
  exit 1
fi
cd "${ROOT_DIR}"

C_GRN=$'\033[32m'; C_RED=$'\033[31m'; C_YEL=$'\033[33m'
C_BLU=$'\033[34m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'

step() { printf '\n%s==> %s%s\n' "${C_BLU}" "$*" "${C_RST}"; }
ok()   { printf '  %s✓%s %s\n' "${C_GRN}" "${C_RST}" "$*"; }
warn() { printf '  %s!%s %s\n' "${C_YEL}" "${C_RST}" "$*"; }
die()  { printf '  %s✗%s %s\n' "${C_RED}" "${C_RST}" "$*" >&2; exit 1; }
dim()  { printf '%s%s%s\n' "${C_DIM}" "$*" "${C_RST}"; }

DC=(docker compose -f docker-compose.yml)

# ── preflight ───────────────────────────────────────────────
preflight() {
  step "前置检查"
  command -v docker >/dev/null 2>&1 || die "未装 docker"
  docker info >/dev/null 2>&1 || die "docker 守护进程未运行"
  ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?')"

  [[ -f docker-compose.yml ]] || die "缺少 docker-compose.yml（是否在 deploy/ 目录下运行？）"
  [[ -f nginx.conf ]]        || die "缺少 nginx.conf"
  [[ -d site ]]              || die "缺少 site/ 目录（解压包不完整？）"
  [[ -f site/index.html ]]   || die "site/index.html 不存在"

  local n
  n="$(find site -type f | wc -l | tr -d ' ')"
  ok "站点文件 ${n} 个"

  # 关键页面必须存在，否则部署完是空的
  [[ -f site/shop/phyto-moss/index.html ]] \
    || die "site/shop/phyto-moss/index.html 缺失 —— 这正是要展示的页面"
  ok "目标页面 site/shop/phyto-moss/index.html 存在"

  # 端口占用检查：8080 若被别的容器占了要先说清楚。
  #
  # 不能靠 `ss` 输出去认领有者：在服务器上 `ss -lntp` 只显示
  # "docker-proxy"，进程名（users:(("docker-proxy"...))）并不等于容器名，
  # 所以以前那条 grep 'futurnutra-web' 永远匹配不上，把「本项目自己在跑」
  # 误报成了「被其他进程占用」。改成问 docker：占用 8080 的容器是不是
  # 我们自己的。
  if command -v ss >/dev/null 2>&1 && ss -lnt 2>/dev/null | grep -q ':8080 '; then
    local holder_cid holder_name
    # docker compose ps -q web 拿到本项目容器 id；再看它是否已映射 8080
    holder_cid="$("${DC[@]}" ps -q web 2>/dev/null || true)"
    if [[ -n "${holder_cid}" ]]; then
      holder_name="$(docker inspect -f '{{.Name}}' "${holder_cid}" 2>/dev/null | sed 's|^/||')"
      dim "  8080 已被本项目容器 ${holder_name} 占用（将重建，正常）"
    else
      # 不是我们的容器，找出真正的占用者
      local other
      other="$(docker ps --filter "publish=8080" --format '{{.Names}} ({{.Image}})' 2>/dev/null | head -1)"
      if [[ -n "${other}" ]]; then
        warn "8080 已被其他容器占用：${other}"
        dim "  继续会失败，请先停掉该容器或改 docker-compose.yml 的端口映射"
      else
        warn "8080 已被某个非 docker 进程占用"
        dim "  $(ss -lntp 2>/dev/null | grep ':8080 ' | head -1)"
      fi
    fi
  else
    ok "8080 端口空闲"
  fi
}

# ── up ──────────────────────────────────────────────────────
deploy_up() {
  step "启动静态站点容器"
  "${DC[@]}" up -d --remove-orphans

  # 等 healthcheck 通过
  printf '  等待健康检查'
  local i cid st
  cid="$("${DC[@]}" ps -q web 2>/dev/null || true)"
  for i in $(seq 1 30); do
    cid="$("${DC[@]}" ps -q web 2>/dev/null || true)"
    if [[ -n "${cid}" ]]; then
      st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${cid}" 2>/dev/null || echo unknown)"
      case "${st}" in
        healthy) printf '\n'; ok "容器健康"; return 0 ;;
        none)    printf '\n'; ok "容器已启动（无 healthcheck）"; return 0 ;;
      esac
    fi
    printf '.'; sleep 1
  done
  printf '\n'
  "${DC[@]}" logs --tail 40 web >&2 || true
  die "容器未在 30s 内变为 healthy"
}

# ── verify ──────────────────────────────────────────────────
# 只看状态码/内容，不看 curl 退出码 —— 某些 curl 构建会「写出 body 却返回非 0」，
# 用退出码判断会把健康的服务误判成故障。
_http_code() {
  local url="$1" timeout="${2:-10}" attempt code
  for attempt in 1 2 3 4 5; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time "${timeout}" "${url}" 2>/dev/null || true)"
    if [[ -n "${code}" && "${code}" != "000" ]]; then printf '%s' "${code}"; return 0; fi
    sleep 1
  done
  printf '000'; return 1
}

verify() {
  step "验收"
  local base="http://127.0.0.1:8080"

  local code
  code="$(_http_code "${base}/shop/phyto-moss/" 15)" || code="000"
  [[ "${code}" == "200" ]] && ok "/shop/phyto-moss/ → 200" \
    || die "目标页面返回 ${code}（应为 200）"

  # 内容校验：确认真的是那个商品页，而不是 404 页面。
  #
  # 注意这里用 case 而不是 `printf ... | grep -q`。
  # `grep -q` 一旦匹配成功就立即退出，会让上游 printf 收到 SIGPIPE（141），
  # 在 `set -o pipefail` 下整条管道被判为失败 —— 于是页面明明是对的，
  # 却打出「没找到 PhytoMoss 字样」的假警告。实测在服务器上踩到过。
  # case 是纯 bash 内建，不涉及管道，不存在这个问题。
  local html
  html="$(curl -s --max-time 15 "${base}/shop/phyto-moss/" 2>/dev/null || true)"
  case "${html}" in
    *PhytoMoss*) ok "页面内容确认为 PhytoMoss+" ;;
    *phytomoss*) ok "页面内容确认为 PhytoMoss+（小写匹配）" ;;
    *)           warn "页面里没找到 PhytoMoss 字样（页面 ${#html} 字节），请人工确认" ;;
  esac

  # 其余主页
  for path in "/" "/shop/" "/about/" "/faq/" "/contact/"; do
    local c
    c="$(_http_code "${base}${path}" 10)" || c="000"
    if [[ "${c}" == "200" ]]; then ok "${path} → 200"; else warn "${path} → ${c}"; fi
  done

  # 静态资源（从页面里取第一个 _astro 资源验证）
  local asset
  asset="$(printf '%s' "${html}" | grep -o '/_astro/[A-Za-z0-9._-]*\.\(js\|css\)' | head -1 || true)"
  if [[ -n "${asset}" ]]; then
    local ac
    ac="$(_http_code "${base}${asset}" 10)" || ac="000"
    [[ "${ac}" == "200" ]] && ok "静态资源 ${asset} → 200" || warn "静态资源 ${asset} → ${ac}"
  fi

  # 404 行为：多页静态站，未知路径就该是 404
  local nf
  nf="$(_http_code "${base}/this-does-not-exist-xyz/" 10)" || nf="000"
  [[ "${nf}" == "404" ]] && ok "未知路径正确返回 404" || warn "未知路径返回 ${nf}（预期 404）"

  # ------------------------------------------------------------------
  # 重定向端口校验 —— 这条专门防一个实测踩到的坑。
  #
  # 站点用 8080:80 端口映射，nginx 内部只认 80。默认 absolute_redirect on
  # 时，try_files 命中目录（/shop -> /shop/）会生成绝对 Location，
  # 形如 http://<host>/shop/ —— **8080 丢了**，浏览器于是跳到 80 端口，
  # 也就是另一台（知枢）站点上。
  #
  # 症状是「点首页导航按钮跳到了别的项目」，很难联想到 nginx 重定向。
  # 所以这里主动探测：请求一个无斜杠目录，看 Location 是否保留了端口。
  # ------------------------------------------------------------------
  # ------------------------------------------------------------------
  # 这里同时验证「修复仍然生效」和「重定向没丢端口」两种情况：
  #   - 没有 Location 头  → 说明 /shop 直接 200，正是修复后的目标状态
  #   - 有 Location 头    → 必须带 :8080 或是相对路径
  # 之前只判后者，把「已修复」误报成了警告。
  # ------------------------------------------------------------------
  local loc
  loc="$(curl -s -I --max-time 10 "${base}/shop" 2>/dev/null \
         | grep -i '^location:' | tr -d '\r' | awk '{print $2}' || true)"
  if [[ -z "${loc}" ]]; then
    ok "/shop 无重定向，直接返回 200（端口不会丢失）"
  elif [[ "${loc}" == /* ]]; then
    ok "重定向使用相对路径（${loc}），端口不会丢失"
  elif [[ "${loc}" == *":8080/"* || "${loc}" == *":8080"* ]]; then
    ok "重定向保留了端口（${loc}）"
  else
    warn "重定向丢失端口：${loc}"
    warn "  浏览器会跳到 80 端口（可能是另一个站点）。"
    warn "  修复：nginx.conf 里不要给 try_files 传裸的 \$uri/ 候选"
  fi

  # 端口隔离确认：知枢必须还在 80 上跑着
  local c80
  c80="$(_http_code "http://127.0.0.1/" 10)" || c80="000"
  if [[ "${c80}" == "200" ]]; then
    ok "80 端口仍由知枢 CampusAI 正常提供服务（未受影响）"
  else
    warn "80 端口返回 ${c80} —— 若你已下线知枢可忽略"
  fi

  # 公网地址提示。
  #
  # api.ipify.org 在国内 ECS 上经常不可达，以前只有这一个来源，
  # 失败就回退到 `hostname -I` 的内网地址（172.19.x.x），
  # 打印出来会误导人 —— 那个地址外网根本访问不到。
  #
  # 依次尝试多个来源，并且**优先使用云厂商元数据服务**：
  # 阿里云 ECS 通过 100.100.100.200 提供实例元数据，稳定且不依赖公网。
  local pub_ip=""
  # 1) 阿里云元数据服务（最可靠）
  pub_ip="$(curl -fsS --max-time 3 \
    http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null || true)"
  # 2) 其他公共回显服务
  if [[ -z "${pub_ip}" ]]; then
    for svc in https://ifconfig.me/ip https://ipinfo.io/ip https://api.ipify.org; do
      pub_ip="$(curl -fsS --max-time 5 "${svc}" 2>/dev/null | tr -d '[:space:]' || true)"
      [[ -n "${pub_ip}" ]] && break
    done
  fi
  # 3) 都拿不到就用内网地址，但明确标注
  local ip_is_public=1
  if [[ -z "${pub_ip}" ]]; then
    pub_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '<服务器IP>')"
    ip_is_public=0
  fi

  printf '\n%s部署完成%s\n' "${C_GRN}" "${C_RST}"
  printf '  访问地址：  %shttp://%s:8080/shop/phyto-moss/%s\n' "${C_BLU}" "${pub_ip}" "${C_RST}"
  printf '  首页：      http://%s:8080/\n' "${pub_ip}"
  if [[ "${ip_is_public}" == "0" ]]; then
    printf '  %s注意：上面是内网地址，外网请用服务器的公网 IP%s\n' "${C_YEL}" "${C_RST}"
  fi
  printf '\n  %s务必确认阿里云安全组已放行 TCP 8080%s\n' "${C_YEL}" "${C_RST}"
}

# ── status ──────────────────────────────────────────────────
status() {
  step "容器状态"
  "${DC[@]}" ps
  step "最近日志"
  "${DC[@]}" logs --tail 25 web || true
}

# ── rollback ────────────────────────────────────────────────
rollback() {
  step "停止并移除容器"
  "${DC[@]}" down --remove-orphans || true
  ok "已移除。站点文件仍保留在 ${ROOT_DIR}/site（未删除）"
  dim "  重新启动：bash deploy.sh"
}

# ── main ────────────────────────────────────────────────────
main() {
  printf '%s\n' '╭──────────────────────────────────────────────╮'
  printf '%s\n' '│  FutureNutra · 静态站点部署 (端口 8080)      │'
  printf '%s\n' '╰──────────────────────────────────────────────╯'

  case "${1:-}" in
    --status)   status; exit 0 ;;
    --rollback) rollback; exit 0 ;;
    --help|-h)
      printf '用法: bash deploy.sh [--status|--rollback|--help]\n'
      exit 0 ;;
  esac

  preflight
  deploy_up
  verify
}

main "$@"
