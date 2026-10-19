#!/bin/sh
# Post-deploy check of Ishonch: the site, the API, the bot webhook, Telegram settings and, on the server, the
# containers, open ports, logs and backups. Read-only: it changes nothing and sends no messages.
# Run from the project directory after `docker compose up -d --build`:
#   ./deploy/smoke.sh                       # BASE_URL from MINIAPP_URL in .env
#   ./deploy/smoke.sh https://ishonch.uz    # or from a laptop: server-only checks are skipped
# Exit code 1 when any check failed (✗); warnings (!) do not fail it.
set -u

[ -f ./.env ] && { set -a; . ./.env; set +a; }
BASE_URL="${1:-${MINIAPP_URL:-}}"
BASE_URL="${BASE_URL%/}"
if [ -z "$BASE_URL" ]; then
  echo "usage: $0 https://<домен>   (или MINIAPP_URL в .env)" >&2
  exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILS=0
bot_id=""
WARNS=0
# Colours only on a terminal: the output also goes to cron mail and CI logs.
if [ -t 1 ]; then G='\033[32m' Y='\033[33m' R='\033[31m' N='\033[0m'; else G='' Y='' R='' N=''; fi
ok() { printf "  ${G}✓${N} %s\n" "$*"; }
warn() { printf "  ${Y}!${N} %s\n" "$*"; WARNS=$((WARNS + 1)); }
fail() { printf "  ${R}✗${N} %s\n" "$*"; FAILS=$((FAILS + 1)); }
section() { printf '\n%s\n' "$*"; }

# req URL [curl args…] → HTTP code (000 when unreachable); body in $TMP/body, headers in $TMP/head.
req() {
  url="$1"; shift
  curl -sS -o "$TMP/body" -D "$TMP/head" -w '%{http_code}' --max-time 20 "$@" "$url" 2>"$TMP/err" || true
}
header() { grep -i "^$1:" "$TMP/head" | tail -n 1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }
# json_field NAME FILE → a scalar value of a flat JSON field (enough for Telegram's and /health's answers).
json_field() { sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\).*/\1/p" "$2" | head -n 1 | tr -d '\\'; }

echo "Ishonch: проверка после деплоя — $BASE_URL"

section "Сайт и TLS"
case "$BASE_URL" in
  https://*)
    host="$(echo "$BASE_URL" | sed 's#^https://##; s#[/:].*##')"
    cert="$(echo | openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null | openssl x509 2>/dev/null)"
    if [ -z "$cert" ]; then
      fail "TLS: не удалось получить сертификат $host"
    elif echo "$cert" | openssl x509 -noout -checkend $((14 * 86400)) >/dev/null; then
      ok "TLS-сертификат действует ещё больше 14 дней ($(echo "$cert" | openssl x509 -noout -enddate | cut -d= -f2))"
    else
      fail "TLS-сертификат истекает в ближайшие 14 дней или уже истёк"
    fi
    code="$(req "http://$host/")"
    case "$code" in
      301|302|307|308) ok "http:// перенаправляет на https:// ($code)" ;;
      *) warn "http://$host/ отвечает $code, а не перенаправлением на https" ;;
    esac
    ;;
  *) warn "BASE_URL не https: Telegram открывает Mini App только по HTTPS" ;;
esac

code="$(req "$BASE_URL/")"
if [ "$code" = 200 ] && grep -q 'id="root"' "$TMP/body"; then
  ok "Mini App открывается (200)"
else
  fail "Mini App: $BASE_URL/ ответил $code $(cat "$TMP/err")"
fi
case "$(header cache-control)" in
  *no-cache*) ok "index.html не кэшируется (новая версия сразу доходит до Telegram)" ;;
  *) warn "у index.html нет Cache-Control: no-cache — пользователи могут видеть старую версию" ;;
esac
case "$(header content-security-policy)" in
  *frame-ancestors*telegram.org*) ok "CSP frame-ancestors разрешает только Telegram" ;;
  *) fail "нет заголовка CSP frame-ancestors — Mini App можно встроить на чужой сайт" ;;
esac
asset="$(sed -n 's#.*src="\(/assets/[^"]*\.js\)".*#\1#p' "$TMP/body" | head -n 1)"
if [ -n "$asset" ]; then
  code="$(req "$BASE_URL$asset")"
  [ "$code" = 200 ] && ok "сборка Mini App загружается ($asset)" || fail "сборка Mini App: $asset ответил $code"
fi

section "API"
code="$(req "$BASE_URL/api/health")"
if [ "$code" = 200 ] && grep -q '"ok":true' "$TMP/body"; then
  ok "health: база отвечает за $(sed -n 's/.*"ms":\([0-9]*\).*/\1/p' "$TMP/body") мс, версия $(json_field version "$TMP/body"), работает $(json_field uptimeSec "$TMP/body") с"
else
  fail "health: $code $(cat "$TMP/body" "$TMP/err" 2>/dev/null | head -c 300)"
fi
code="$(req "$BASE_URL/api/catalog")"
if [ "$code" = 200 ] && grep -q '"items":\[' "$TMP/body"; then
  n="$(grep -o '"favorite":' "$TMP/body" | wc -l | tr -d ' ')"
  [ "$n" -gt 0 ] && ok "витрина: на первой странице объявлений — $n" || warn "витрина пустая — до открытия наполните её (памятка, раздел 8)"
else
  fail "витрина: /api/catalog ответил $code"
fi
code="$(req "$BASE_URL/api/me")"
[ "$code" = 401 ] && ok "без входа /api/me закрыт (401)" || fail "/api/me без входа ответил $code, ожидалось 401"
code="$(req "$BASE_URL/api/me" -H "Authorization: Internal smoke-check")"
[ "$code" = 403 ] && ok "внутренний токен снаружи не принимается (403)" || fail "запрос с Authorization: Internal ответил $code, ожидалось 403 от nginx"
if [ -n "${METRICS_TOKEN:-}" ]; then
  code="$(req "$BASE_URL/api/metrics")"
  [ "$code" = 404 ] && ok "/metrics без токена скрыт" || fail "/metrics без токена ответил $code"
  code="$(req "$BASE_URL/api/metrics" -H "Authorization: Bearer $METRICS_TOKEN")"
  if [ "$code" = 200 ]; then
    dead="$(sed -n 's/^ishonch_jobs{state="dead"} \([0-9]*\)/\1/p' "$TMP/body")"
    due="$(sed -n 's/^ishonch_jobs{state="due"} \([0-9]*\)/\1/p' "$TMP/body")"
    ok "/metrics с токеном отвечает"
    [ "${dead:-0}" = 0 ] || warn "фоновых задач, сдавшихся после всех попыток: $dead (см. таблицу jobs)"
    [ "${due:-0}" -lt 100 ] || warn "очередь фоновых задач растёт: $due ждут выполнения"
  else
    fail "/metrics с токеном ответил $code"
  fi
fi

section "Бот"
code="$(req "$BASE_URL/tg-webhook" -X POST -H 'Content-Type: application/json' -d '{}')"
if [ -n "${BOT_WEBHOOK_URL:-}" ]; then
  [ "$code" = 401 ] && ok "вебхук бота доступен и отклоняет запросы без секрета (401)" \
    || fail "вебхук бота: POST /tg-webhook без секрета ответил $code, ожидалось 401 (бот не запущен?)"
fi
if [ -n "${BOT_TOKEN:-}" ]; then
  tg() { m="$1"; shift; curl -sS --max-time 20 "$@" "https://api.telegram.org/bot$BOT_TOKEN/$m" >"$TMP/tg" 2>"$TMP/err" || true; }
  tg getMe
  if grep -q '"ok":true' "$TMP/tg"; then
    bot_id="$(sed -n 's/.*"result":{"id":\([0-9]*\).*/\1/p' "$TMP/tg")"
    ok "токен бота рабочий: @$(json_field username "$TMP/tg")"
  else
    bot_id=""
    fail "getMe: токен бота не принят ($(json_field description "$TMP/tg")$(cat "$TMP/err"))"
  fi
fi
if [ -n "${BOT_TOKEN:-}" ] && [ -n "$bot_id" ]; then
  tg getWebhookInfo
  hook="$(json_field url "$TMP/tg")"
  pending="$(json_field pending_update_count "$TMP/tg")"
  last_err="$(json_field last_error_message "$TMP/tg")"
  last_err_at="$(json_field last_error_date "$TMP/tg")"
  if [ -n "${BOT_WEBHOOK_URL:-}" ]; then
    [ "$hook" = "$BOT_WEBHOOK_URL" ] && ok "Telegram шлёт обновления на $hook" \
      || fail "вебхук в Telegram: «$hook», ожидался $BOT_WEBHOOK_URL (перезапустите bot)"
  else
    [ -z "$hook" ] && ok "бот работает в режиме polling (BOT_WEBHOOK_URL не задан)" \
      || warn "BOT_WEBHOOK_URL пуст, но в Telegram стоит вебхук $hook — polling не получит обновлений"
  fi
  [ "${pending:-0}" -lt 50 ] || warn "в Telegram накопилось необработанных обновлений: $pending"
  if [ -n "$last_err" ] && [ $(($(date +%s) - ${last_err_at:-0})) -lt 3600 ]; then
    warn "последняя ошибка доставки вебхука (меньше часа назад): $last_err"
  fi
  for pair in "Модерация:${MODERATION_CHAT_ID:-}" "Доставка:${OPERATOR_CHAT_ID:-}"; do
    name="${pair%%:*}"; chat="${pair#*:}"
    if [ -z "$chat" ]; then
      warn "группа «$name»: id не задан в .env — служебные уведомления туда не придут"
      continue
    fi
    tg getChatMember --data-urlencode "chat_id=$chat" --data-urlencode "user_id=$bot_id"
    status="$(json_field status "$TMP/tg")"
    case "$status" in
      administrator) ok "группа «$name»: бот администратор" ;;
      member) warn "группа «$name»: бот участник, не админ — проверьте, что privacy mode выключен" ;;
      *) fail "группа «$name» ($chat): бот не в группе ($status$(json_field description "$TMP/tg"))" ;;
    esac
  done
elif [ -z "${BOT_TOKEN:-}" ]; then
  warn "BOT_TOKEN не задан — проверки Telegram пропущены"
fi

# Server-side checks: only where this directory runs the stack.
if [ -f docker-compose.yml ] && docker compose ps >/dev/null 2>&1; then
  section "Сервер"
  states="$(docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null)"
  for svc in postgres minio api bot miniapp; do
    line="$(echo "$states" | grep "^$svc ")"
    case "$line" in
      *" running healthy"|*" running ") ok "контейнер $svc: ${line#"$svc "}" ;;
      *" running starting") warn "контейнер $svc ещё запускается — повторите через минуту" ;;
      "") fail "контейнер $svc не запущен" ;;
      *) fail "контейнер $svc: ${line#"$svc "}" ;;
    esac
  done

  docker compose logs api --since 24h >"$TMP/api.log" 2>&1
  if grep -q "UNSAFE CONFIG" "$TMP/api.log"; then
    grep "UNSAFE CONFIG" "$TMP/api.log" | sed 's/.*UNSAFE CONFIG: //' | sort -u | while read -r w; do fail "UNSAFE CONFIG: $w"; done
    FAILS=$((FAILS + 1))
  else
    ok "в логе API нет предупреждений UNSAFE CONFIG"
  fi
  errors="$(grep -c '"level":50' "$TMP/api.log")"
  [ "$errors" -eq 0 ] && ok "ошибок в логе API за сутки нет" || warn "ошибок в логе API за сутки: $errors (docker compose logs api | grep '\"level\":50')"

  if command -v ss >/dev/null; then
    for port in 3000 5432 8081 9000 9001; do
      ss -ltnH "sport = :$port" 2>/dev/null | grep -qv '127.0.0.1\|\[::1\]' \
        && fail "порт $port слушает на всех адресах — он должен быть только на 127.0.0.1"
    done
    mport="${MINIAPP_PORT:-8080}"
    ss -ltnH "sport = :$mport" 2>/dev/null | grep -qv '127.0.0.1\|\[::1\]' \
      && warn "Mini App (порт $mport) открыт на всех адресах — Docker обходит ufw; достаточно 127.0.0.1 за Caddy"
    ok "порты проверены"
  fi

  dir="${BACKUP_DIR:-./backups}/db"
  last="$(ls -t "$dir"/ishonch_*.dump 2>/dev/null | head -n 1)"
  if [ -z "$last" ]; then
    warn "бэкапов базы ещё нет ($dir) — запустите ./deploy/backup.sh и добавьте его в cron"
  elif [ -n "$(find "$last" -mmin -1560)" ]; then
    ok "последний бэкап базы: $(basename "$last") ($(du -h "$last" | cut -f1))"
  else
    fail "последний бэкап базы старше 26 часов: $(basename "$last") — проверьте cron и logs/backup.log"
  fi
  crontab -l 2>/dev/null | grep -q "deploy/backup.sh" && ok "бэкап стоит в cron" || warn "deploy/backup.sh не найден в crontab этого пользователя"

  used="$(df -P . | awk 'NR == 2 { sub("%", "", $5); print $5 }')"
  [ "${used:-0}" -lt 85 ] && ok "диск занят на $used%" || warn "диск занят на $used% — почистите старые образы: docker image prune"
fi

echo
if [ "$FAILS" -gt 0 ]; then
  printf "${R}Ошибок: %s${N}, предупреждений: %s\n" "$FAILS" "$WARNS"
  exit 1
fi
printf "${G}Всё в порядке${N}, предупреждений: %s\n" "$WARNS"
