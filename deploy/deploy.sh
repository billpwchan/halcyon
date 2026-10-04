#!/usr/bin/env bash
# Self-hosting example (the live demo runs this way): build, upload a timestamped release, repoint `current`, recreate
# the container. HOST (user@server) and KEY (ssh key path) come from the environment or from deploy/local.sh, which
# git ignores.
# Earlier releases stay in /opt/halcyon/releases for rollback (repoint `current`, then recreate).
# compose.yaml is installed at /opt/halcyon/, where its ./current and ./deploy paths resolve.
# The gateway fragment (gateway.caddy) is copied but not reloaded; after changing it, validate and reload
# jchart-shared-gateway by hand and re-check every host in sites-enabled.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f deploy/local.sh ] && . deploy/local.sh
: "${HOST:?set HOST=user@server (or put it in deploy/local.sh)}"
: "${KEY:?set KEY=/path/to/ssh-key (or put it in deploy/local.sh)}"
STAMP=$(date +%Y%m%d-%H%M%S)

npm run build
ssh -i "$KEY" "$HOST" 'mkdir -p ~/halcyon-upload'
rsync -az --delete -e "ssh -i $KEY" dist/ "$HOST:halcyon-upload/dist/"
rsync -az --delete -e "ssh -i $KEY" deploy/ "$HOST:halcyon-upload/deploy/"
ssh -i "$KEY" "$HOST" "STAMP=$STAMP bash -s" <<'REMOTE'
set -euo pipefail
R=/opt/halcyon
sudo mkdir -p $R/releases $R/deploy
sudo cp -a ~/halcyon-upload/dist $R/releases/$STAMP
sudo cp ~/halcyon-upload/deploy/Caddyfile ~/halcyon-upload/deploy/gateway.caddy $R/deploy/
sudo cp ~/halcyon-upload/deploy/compose.yaml $R/compose.yaml
sudo ln -sfn releases/$STAMP $R/current
sudo chown -R root:root $R
sudo chmod -R a+rX $R
# the bind mount resolves `current` when the container starts
cd $R && sudo docker compose up -d --force-recreate
for i in $(seq 1 30); do sudo docker exec halcyon wget -q -O - http://127.0.0.1:8080/healthz 2>/dev/null && break; sleep 1; done
echo
echo "released $STAMP"
REMOTE
curl -fsS -o /dev/null -w "live %{http_code}\n" https://halcyon.billpwchan.art/
