# SPDX-License-Identifier: GPL-2.0
# Sourced by service.sh. No configuration is interpreted as shell code.

APP_PROFILE_MAX_BYTES=131072
APP_PROFILE_MAX_PATHS=256
APP_PROFILE_PARAM=/sys/module/pathmask/parameters/app_profiles

pm_legacy_scope_resolved() {
	case "$1" in
		allow|deny) [ -n "$2" ] ;;
		*) return 0 ;;
	esac
}

# The package commands must not inherit a /data/adb file descriptor:
# with stdin or stdout pointing at one, they fail with
# "Failure calling service package: Failed transaction" on at least one
# Android 17 build. stdin is therefore /dev/null and stdout is captured by
# the caller through a pipe.
pm_inventory_for_user() {
	cmd package list packages --user "$1" -U 2>/dev/null < /dev/null ||
		pm list packages --user "$1" -U 2>/dev/null < /dev/null
}

# Refuse non-unique package ownership, unknown users and non-ordinary app IDs.
pm_resolve_profile_uid() {
	LC_ALL=C awk -v user="$1" -v package_name="$2" '
		$1 ~ /^package:[A-Za-z0-9_.]+$/ && NF == 2 && $2 ~ /^uid:[0-9]+$/ {
			uid = substr($2, 5) + 0
			seen[uid]++
			if ($1 == "package:" package_name) { found++; chosen = uid }
		}
		END {
			if (found != 1 || seen[chosen] != 1 || chosen > 2147483647 ||
			    int(chosen / 100000) != user || chosen % 100000 < 10000 ||
			    chosen % 100000 > 19999) exit 1
			printf "%.0f\n", chosen
		}
	' "$3"
}

# Compile a complete configuration into a private transaction file. A malformed
# record or unresolved active profile rejects the whole file, not just its row.
pm_compile_app_profiles() {
	APP_PROFILE_COUNT=0
	APP_PROFILE_ERROR=""
	APP_PROFILE_RULES="$2/rules"
	APP_PROFILE_CONFIG_SOURCE="$1"
	APP_PROFILE_WORK="$2"
	APP_PROFILE_ERROR="cannot prepare rule transaction"
	: > "$APP_PROFILE_RULES" || return 1
	if [ ! -e "$APP_PROFILE_CONFIG_SOURCE" ] && [ ! -L "$APP_PROFILE_CONFIG_SOURCE" ]; then
		APP_PROFILE_ERROR=""
		return 0
	fi
	APP_PROFILE_ERROR="unreadable app profile configuration"
	[ -f "$APP_PROFILE_CONFIG_SOURCE" ] && [ ! -L "$APP_PROFILE_CONFIG_SOURCE" ] || return 1
	if ! cat "$APP_PROFILE_CONFIG_SOURCE" > "$APP_PROFILE_WORK/input"; then
		return 1
	fi
	APP_PROFILE_ERROR="invalid app profile configuration"
	APP_PROFILE_SIZE=$(wc -c < "$APP_PROFILE_WORK/input") || return 1
	[ "$APP_PROFILE_SIZE" -le "$APP_PROFILE_MAX_BYTES" ] || return 1
	# Some awk implementations do not preserve embedded NUL bytes in records.
	[ "$(LC_ALL=C tr -d '\000' < "$APP_PROFILE_WORK/input" | wc -c)" -eq "$APP_PROFILE_SIZE" ] || return 1
	if ! LC_ALL=C awk -v max_paths="$APP_PROFILE_MAX_PATHS" '
		{ sub(/\r$/, "") }
		/^ *$/ || /^#/ { next }
		/^app / {
			if ($0 ~ /[[:cntrl:]]/ || NF != 5 || $2 !~ /^(0|[1-9][0-9]*)$/ ||
			    $2 > 21474 || length($3) > 255 ||
			    $3 !~ /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/ ||
			    $4 !~ /^[01]$/ || $5 !~ /^[01]$/ || ++profile_count > 1024) exit 1
			user = $2; name = $3; enabled = $4; filter = $5
			key = user ":" name
			if (profiles[key]++) exit 1
			next
		}
		/^path / {
			path = substr($0, 6)
			if (!key || path !~ /^\// || path ~ /^\/+$/ || path ~ /[,;[:cntrl:]]/ ||
			    path ~ / $/ || length(path) > 255 || ++paths[key] > max_paths ||
			    unique[key SUBSEP path]++) exit 1
			if (enabled == "1") {
				if (++active_count > max_paths) exit 1
				print user " " name " " filter " " path
			}
			next
		}
		{ exit 1 }
	' "$APP_PROFILE_WORK/input" > "$APP_PROFILE_WORK/requests"; then
		return 1
	fi

	APP_PROFILE_LAST=""
	while IFS=' ' read -r APP_PROFILE_USER APP_PROFILE_PKG APP_PROFILE_FILTER APP_PROFILE_PATH; do
		APP_PROFILE_KEY="$APP_PROFILE_USER:$APP_PROFILE_PKG"
		APP_PROFILE_INVENTORY="$APP_PROFILE_WORK/user-$APP_PROFILE_USER"
		if [ "$APP_PROFILE_KEY" != "$APP_PROFILE_LAST" ]; then
			APP_PROFILE_ERROR="cannot verify UID ownership for $APP_PROFILE_KEY"
			if [ ! -f "$APP_PROFILE_INVENTORY" ]; then
				# Capture through a pipe and let this shell write the file.
				# Redirecting the package command's stdout straight into a
				# file under /data/adb makes it fail with
				# "Failure calling service package: Failed transaction".
				APP_PROFILE_INVENTORY_TEXT=$(pm_inventory_for_user "$APP_PROFILE_USER") || return 1
				printf '%s\n' "$APP_PROFILE_INVENTORY_TEXT" > "$APP_PROFILE_INVENTORY" || return 1
				unset APP_PROFILE_INVENTORY_TEXT
			fi
			APP_PROFILE_UID=$(pm_resolve_profile_uid "$APP_PROFILE_USER" "$APP_PROFILE_PKG" "$APP_PROFILE_INVENTORY") || return 1
			APP_PROFILE_LAST="$APP_PROFILE_KEY"
		fi
		APP_PROFILE_ERROR="cannot stage path for $APP_PROFILE_KEY"
		if [ "${3:-0}" = 1 ] && [ ! -e "$APP_PROFILE_PATH" ]; then
			APP_PROFILE_ERROR="configured path is not available for $APP_PROFILE_KEY"
			return 1
		fi
		printf '%s %s %s\n' "$APP_PROFILE_UID" "$APP_PROFILE_FILTER" "$APP_PROFILE_PATH" >> "$APP_PROFILE_RULES" || return 1
		APP_PROFILE_COUNT=$((APP_PROFILE_COUNT + 1))
	done < "$APP_PROFILE_WORK/requests"
	APP_PROFILE_ERROR=""
}

pm_write_app_profile() {
	printf '%s' "$1" > "$APP_PROFILE_PARAM"
}

pm_apply_app_profiles() {
	APP_PROFILE_GENERATION="$1"
	APP_PROFILE_ERROR="kernel app profile interface unavailable"
	[ -r "$APP_PROFILE_PARAM" ] && [ -w "$APP_PROFILE_PARAM" ] || return 1
	APP_PROFILE_ERROR="kernel rejected app profile transaction"
	pm_write_app_profile "begin $APP_PROFILE_GENERATION" || return 1
	APP_PROFILE_NEXT=0
	while IFS= read -r APP_PROFILE_RULE; do
		APP_PROFILE_NEXT=$((APP_PROFILE_NEXT + 1))
		APP_PROFILE_ERROR="kernel did not accept path $APP_PROFILE_NEXT"
		if ! pm_write_app_profile "add $APP_PROFILE_GENERATION $APP_PROFILE_RULE"; then
			pm_write_app_profile "abort $APP_PROFILE_GENERATION" || true
			return 1
		fi
	done < "$APP_PROFILE_RULES"
	APP_PROFILE_ERROR="kernel did not commit app profile transaction"
	if ! pm_write_app_profile "commit $APP_PROFILE_GENERATION"; then
		pm_write_app_profile "abort $APP_PROFILE_GENERATION" || true
		return 1
	fi
	APP_PROFILE_ERROR="kernel did not acknowledge the requested app rules"
	APP_PROFILE_CONFIRMED=$(cat "$APP_PROFILE_PARAM") || return 1
	[ "$APP_PROFILE_CONFIRMED" = "$APP_PROFILE_GENERATION $APP_PROFILE_COUNT" ] || return 1
	APP_PROFILE_ERROR=""
}
