#!/usr/bin/env bash
# End-to-end test of a LocalVPS Linux package, run the way a user would: as a normal user with sudo,
# installing the stack with the exact commands the panel generates, then creating every site type.
#
#   tests/e2e-linux.sh dist/LocalVPS-<version>-linux-x64.tar.gz
set -uo pipefail
ARCHIVE="$(realpath "$1")"
WORK="$(mktemp -d)"
FAILS=0
log()  { printf '\n\033[1;34m### %s\033[0m\n' "$*"; }
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check "description" command...
  local what="$1"; shift
  if "$@"; then pass "$what"; else fail "$what"; fi
}

log "Unpack and start the panel"
tar -xzf "$ARCHIVE" -C "$WORK"
APP="$WORK/LocalVPS"
(cd "$APP" && nohup ./localvps --no-open > panel.log 2>&1 &)
for _ in $(seq 1 60); do grep -q 'LocalVPS panel' "$APP/panel.log" 2>/dev/null && break; sleep 0.5; done
cat "$APP/panel.log"
TOKEN=$(python3 -c "import json;print(json.load(open('$APP/data/secrets.json'))['panelToken'])")
A=$(grep -oE 'http://127\.0\.0\.1:[0-9]+' "$APP/panel.log" | head -1)
api() { curl -s -H "x-panel-token: $TOKEN" -H 'content-type: application/json' "$@"; }
jobid() { python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('job') or json.dumps(d))"; }
waitjob() {
  local id="$1" s
  for _ in $(seq 1 300); do
    s=$(api "$A/api/jobs/$id" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
    [ "$s" != running ] && break; sleep 3
  done
  api "$A/api/jobs/$id" | python3 -c "import json,sys;j=json.load(sys.stdin);print('\n'.join('    '+l for l in j['log'][-5:]))"
  [ "$s" = done ]
}
http_code() { curl -s -o /dev/null -w '%{http_code}' "$1"; }

log "Provider and catalog"
api "$A/api/overview" | python3 -c "import json,sys;o=json.load(sys.stdin);print('  provider:',o['provider']['label'],'| httpPort:',o['settings']['httpPort'])"
api "$A/api/components/catalog" > "$WORK/cat.json"
check "catalog offers PHP 8.4 via apt" python3 -c "import json,sys;c=json.load(open('$WORK/cat.json'));sys.exit(0 if any(x['branch']=='8.4' and 'command' in x for x in c['php']) else 1)"

log "Install nginx, PHP 8.4 and MariaDB with the panel's sudo commands"
for spec in "nginx system" "php 8.4" "mariadb system"; do
  set -- $spec
  CMD=$(api -X POST -d "{\"type\":\"$1\",\"branch\":\"$2\"}" "$A/api/components/install" | python3 -c "import json,sys;print(json.load(sys.stdin)['command'])")
  echo "  \$ $CMD"
  if bash -c "$CMD" > "$WORK/install-$1.log" 2>&1; then pass "install $1"; else fail "install $1"; tail -20 "$WORK/install-$1.log"; fi
done
check "system services were switched off" bash -c '! systemctl is-active --quiet nginx && ! systemctl is-active --quiet mariadb'

log "Detect installed components"
api -X POST "$A/api/components/detect" > "$WORK/detect.json"
python3 -c "
import json
c=json.load(open('$WORK/detect.json'))['components']
print('  nginx  ', c['nginx'] and c['nginx']['version'])
print('  php    ', {b:r['version'] for b,r in c['php'].items()})
print('  mariadb', c['mariadb'] and c['mariadb']['version'])"
check "nginx, PHP 8.4 and MariaDB detected" python3 -c "import json,sys;c=json.load(open('$WORK/detect.json'))['components'];sys.exit(0 if c['nginx'] and '8.4' in c['php'] and c['mariadb'] else 1)"

log "Install Node.js 24"
check "node.js download job" waitjob "$(api -X POST -d '{"type":"node","branch":"24"}' "$A/api/components/install" | jobid)"

log "Start all services"
api -X POST "$A/api/services/all/start"; echo
api "$A/api/services" | python3 -c "import json,sys;[print('  ',s['key'],'running' if s['running'] else 'STOPPED',s['port'],s['error'] or '') for s in json.load(sys.stdin)]"
check "all services running" python3 -c "import json,sys,urllib.request as u;r=u.Request('$A/api/services',headers={'x-panel-token':'$TOKEN'});sys.exit(0 if all(s['running'] for s in json.load(u.urlopen(r))) else 1)"
check "services run as the user, not root" bash -c "! ps -o user= -C nginx,mariadbd,php-fpm8.4 | grep -qx root"

log "Sites"
api -X POST -d '{"name":"demo","template":"blank","createDb":true}' "$A/api/sites"; echo
DEMO=$(curl -s http://demo.localhost:8080/)
grep -oE 'PHP [0-9.]+ on [A-Za-z]+|connected ✔|not reachable[^<]*|<b>[^<]*</b>[^<]*' <<<"$DEMO" | sed 's/^/    /'
check "blank PHP site connects to its database" grep -q 'connected ✔' <<<"$DEMO"
check "WordPress template" waitjob "$(api -X POST -d '{"name":"blog","template":"wordpress"}' "$A/api/sites" | jobid)"
check "WordPress redirects to its installer" bash -c "curl -s -o /dev/null -w '%{redirect_url}' http://blog.localhost:8080/ | grep -q wp-admin/install.php"
check "Laravel template" waitjob "$(api -X POST -d '{"name":"shop","template":"laravel","php":"8.4"}' "$A/api/sites" | jobid)"
# An unknown hostname falls through to the landing page (also 200), so check for the app itself.
check "Laravel site serves its welcome page" bash -c "curl -s http://shop.localhost:8080/ | grep -qi laravel"
check "Laravel migrations ran in MariaDB" bash -c "curl -s -H 'x-panel-token: $TOKEN' -H 'content-type: application/json' -d '{\"db\":\"shop_db\",\"sql\":\"SELECT COUNT(*) FROM migrations\"}' $A/api/db/query | grep -q '\[\[3\]\]'"
check "Next.js template" waitjob "$(api -X POST -d '{"name":"web","template":"nextjs"}' "$A/api/sites" | jobid)"
check "Next.js site serves through nginx" bash -c "curl -s http://web.localhost:8080/ | grep -q _next/"

log "Security"
check "MariaDB root rejects an empty password over TCP" bash -c "! mariadb --no-defaults -h127.0.0.1 -P3306 -uroot --password= -e 'select 1' >/dev/null 2>&1"
sql() { # run SQL through the panel's console and print the first cell
  python3 -c "import json,sys;print(json.dumps({'sql':sys.argv[1]}))" "$1" | api -d @- "$A/api/db/query" | python3 -c "import json,sys;print(json.load(sys.stdin)['results'][0]['rows'][0][0])"
}
check "no anonymous or passwordless root accounts" test "$(sql "SELECT COUNT(*) FROM mysql.user WHERE User='' OR (User='root' AND authentication_string='')")" = 0
check "API rejects requests without the token" test "$(curl -s -o /dev/null -w '%{http_code}' "$A/api/overview")" = 401
check "terminal shells available (node-pty loads)" bash -c "curl -s -H 'x-panel-token: $TOKEN' $A/api/terminal/shells | grep -q '\"id\"'"

log "Export bundle"
check "export Laravel site with database" waitjob "$(api -X POST -d '{"name":"shop","includeDb":true}' "$A/api/exports" | jobid)"
BUNDLE=$(ls "$APP"/exports/shop-*/provision.sh 2>/dev/null | head -1)
check "provision.sh passes bash -n" bash -n "$BUNDLE"

log "Stop all"
api -X POST "$A/api/services/all/stop" > /dev/null; sleep 2
check "no services left running" bash -c "! pgrep -u \"$(id -u)\" -x 'nginx|mariadbd|php-fpm8.4' >/dev/null"

log "Panel log"
tail -20 "$APP/panel.log"
pkill -f "$APP/localvps" || true

echo
if [ "$FAILS" -eq 0 ]; then echo "All checks passed."; else echo "$FAILS check(s) failed."; exit 1; fi
