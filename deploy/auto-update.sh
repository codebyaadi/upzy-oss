#!/usr/bin/env bash
# Keeps the server on the latest release. Run by a systemd timer every few minutes (see install-auto-update.sh).
#
#   1. Checks out the newest v* tag of this repo (so compose.yml and the Caddyfile match the images).
#   2. Pulls the images. If nothing changed, it stops here.
#   3. Restarts the stack on the new images (the migrate job runs first).
#   4. Waits for the API to report healthy. If it doesn't, it puts the previous images back and exits with an error.
#
# Releases are made by pushing a v* tag (.github/workflows/deploy.yml builds and pushes the images).
# Settings (environment): HEALTH_SERVICE (default api), HEALTH_WAIT seconds (default 150), COMPOSE_PROFILES_ARGS.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
HEALTH_SERVICE="${HEALTH_SERVICE:-api}"
HEALTH_WAIT="${HEALTH_WAIT:-150}"
read -r -a PROFILE <<<"${COMPOSE_PROFILES_ARGS:---profile aws}"
log() { echo "[$(date -u +%FT%TZ)] $*"; }

# One run at a time.
exec 9>/tmp/upzy-update.lock
flock -n 9 || { log "another update is running"; exit 0; }

compose() { docker compose "${PROFILE[@]}" "$@"; }

# Images that failed their health check. A release that rolled back is not retried every 5 minutes (each attempt
# would take the API down for a while); a newer release has a different image id and is tried as usual.
FAILED_FILE=".failed-images"
touch "$FAILED_FILE"

# What is running now: "image=id" for each container of the stack, and whether any runs an image that is no longer the
# local one for its tag (a newer pull, including one done by hand).
running_images() {
  compose ps -a -q | while read -r cid; do
    [[ -n "$cid" ]] && echo "$(docker inspect -f '{{.Config.Image}}={{.Image}}' "$cid")"
  done | sort -u
}
is_stale() {
  local line img id cur
  while IFS= read -r line; do
    img="${line%%=*}"; id="${line#*=}"
    cur="$(docker image inspect -f '{{.Id}}' "$img" 2>/dev/null || true)"
    [[ -n "$cur" && "$cur" != "$id" ]] && ! grep -qxF "$cur" "$FAILED_FILE" && return 0
  done <<<"$1"
  return 1
}

# 1. Match the deploy files to the newest release (skipped when this isn't a git checkout, e.g. in tests).
if [[ -z "${UPZY_NO_GIT:-}" ]] && git -C .. rev-parse --git-dir >/dev/null 2>&1; then
  git -C .. fetch -q --depth 1 origin 'refs/tags/v*:refs/tags/v*' || log "could not reach git; keeping current files"
  latest="$(git -C .. tag --list 'v*' --sort=-v:refname | head -1)"
  if [[ -n "$latest" && "$(git -C .. describe --tags --exact-match 2>/dev/null || true)" != "$latest" ]]; then
    log "deploy files -> $latest"
    git -C .. checkout -q -f "$latest"
  fi
fi

# Config files (compose.yml, Caddyfile) that changed since the last successful update also need applying.
HASH_FILE=".deploy-hash"
files_hash="$(cat compose.yml Caddyfile 2>/dev/null | sha256sum | cut -d' ' -f1)"
[[ -f "$HASH_FILE" ]] || echo "$files_hash" > "$HASH_FILE"   # first run: what is here is what is running
files_changed=0
[[ "$(cat "$HASH_FILE")" == "$files_hash" ]] || files_changed=1
caddy_changed=0
if ((files_changed)); then
  caddy_changed=1   # the Caddyfile is bind-mounted: a reload is cheap and harmless even if only compose.yml changed
fi

# 2. New images?
[[ -n "${UPZY_SKIP_PULL:-}" ]] || compose pull -q
before="$(running_images)"
if [[ -n "$(compose ps -q "$HEALTH_SERVICE")" ]] && ! is_stale "$before" && ((!files_changed)); then
  exit 0   # running, on the newest images, config unchanged
fi
log "update needed (new images, changed config, or not running)"

# 3. Restart on them.
compose up -d --remove-orphans

# 4. Health gate.
deadline=$((SECONDS + HEALTH_WAIT))
until [[ "$(compose ps "$HEALTH_SERVICE" --format '{{.Health}}')" == "healthy" ]]; do
  if ((SECONDS > deadline)); then
    log "ERROR: $HEALTH_SERVICE is not healthy after ${HEALTH_WAIT}s, rolling back"
    # Remember what failed, so the next run doesn't try the same release again.
    while IFS='=' read -r img _; do
      [[ -n "$img" ]] && docker image inspect -f '{{.Id}}' "$img" >> "$FAILED_FILE" 2>/dev/null || true
    done <<<"$before"
    # Put the previous images back under the tags compose uses, then restart on them.
    while IFS='=' read -r img id; do
      [[ -n "$img" ]] && docker tag "$id" "$img"
    done <<<"$before"
    compose up -d --remove-orphans || true
    log "rolled back to the previous images (database migrations are not undone)"
    exit 1
  fi
  sleep 3
done
echo "$files_hash" > "$HASH_FILE"
if ((caddy_changed)) && [[ -n "$(compose ps -q caddy 2>/dev/null)" ]]; then
  compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 && log "reloaded Caddy" || log "could not reload Caddy"
fi
log "updated; $HEALTH_SERVICE is healthy"
: > "$FAILED_FILE"
docker image prune -f >/dev/null
