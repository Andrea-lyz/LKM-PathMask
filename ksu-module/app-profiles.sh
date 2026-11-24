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

# Validate the syntax and limits of a private copy of the configuration and
# print one "user package filter path" request per path of an enabled profile.
# UID ownership is not checked here.
pm_parse_app_profiles() {
	PM_PARSE_SIZE=$(wc -c < "$1") || return 1
	[ "$PM_PARSE_SIZE" -le "$APP_PROFILE_MAX_BYTES" ] || return 1
	# Some awk implementations do not preserve embedded NUL bytes in records.
	[ "$(LC_ALL=C tr -d '\000' < "$1" | wc -c)" -eq "$PM_PARSE_SIZE" ] || return 1
	LC_ALL=C awk -v max_paths="$APP_PROFILE_MAX_PATHS" '
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
	' "$1"
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
	pm_parse_app_profiles "$APP_PROFILE_WORK/input" > "$APP_PROFILE_WORK/requests" || return 1

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

# Rule mode migration. These helpers only read the live configuration and
# write candidates into a private workspace; replacing live files is left to
# the caller's acknowledged transaction. Report lines are machine readable.
pm_migration_report() {
	printf 'PATHMASK_MIGRATION %s\n' "$*"
}

# A missing file fingerprints differently from an empty one.
pm_config_fingerprint() {
	for PM_FP_FILE in "$@"; do
		if [ -f "$PM_FP_FILE" ]; then
			printf '+%s\n' "$(($(wc -c < "$PM_FP_FILE")))"
			cat "$PM_FP_FILE"
		else
			printf '%s\n' '-'
		fi
	done | sha256sum | cut -d ' ' -f 1
}

pm_valid_package_name() {
	[ "${#1}" -le 255 ] || return 1
	printf '%s\n' "$1" | LC_ALL=C grep -Eqx '[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*'
}

# Cache one user's package inventory in the workspace. An empty listing is
# treated as unreadable: every Android user has at least one package.
pm_migration_inventory() {
	PM_MIG_INVENTORY="$2/user-$1"
	[ -f "$PM_MIG_INVENTORY" ] && return 0
	PM_MIG_INVENTORY_TEXT=$(pm_inventory_for_user "$1") || return 1
	case "$PM_MIG_INVENTORY_TEXT" in
		*package:*) ;;
		*) return 1 ;;
	esac
	printf '%s\n' "$PM_MIG_INVENTORY_TEXT" > "$PM_MIG_INVENTORY"
}

# Legacy blacklist -> per-app profiles. Every resolvable app of the legacy
# blacklist gets an enabled profile holding every literal shared path. An
# existing profile keeps its flags and paths and only gains missing paths.
#   $1 app_profiles.conf  $2 target_path.conf  $3 deny_packages.conf
#   $4 deny_uids.conf     $5 hide_dirents.conf $6 private workspace
#   $7 optional list of shared paths that were carried over from profiles;
#      they are skipped so one app's path never spreads to every app.
# Writes $6/candidate and $6/paths (the shared paths offered) and prints the
# report.
pm_migrate_legacy_deny() {
	PM_MIG_WORK="$6"
	APP_PROFILE_ERROR="cannot prepare the migration workspace"
	{ : > "$PM_MIG_WORK/candidate" && : > "$PM_MIG_WORK/apps" &&
		: > "$PM_MIG_WORK/paths" && : > "$PM_MIG_WORK/existing"; } || return 1
	if [ -e "$1" ] || [ -L "$1" ]; then
		APP_PROFILE_ERROR="unreadable app profile configuration"
		{ [ -f "$1" ] && [ ! -L "$1" ] && cat "$1" > "$PM_MIG_WORK/existing"; } || return 1
		APP_PROFILE_ERROR="invalid app profile configuration"
		pm_parse_app_profiles "$PM_MIG_WORK/existing" > /dev/null || return 1
	fi

	# Same reading as the legacy loader's hide_dirents.conf.
	PM_MIG_FILTER=1
	if [ -f "$5" ]; then
		case "$(head -n 1 "$5" | tr -d '\r')" in
			0|false|False|no|No) PM_MIG_FILTER=0 ;;
		esac
	fi

	APP_PROFILE_ERROR="cannot read the installed package list"
	if [ -f "$3" ]; then
		while IFS= read -r PM_MIG_LINE || [ -n "$PM_MIG_LINE" ]; do
			PM_MIG_LINE=$(printf '%s' "$PM_MIG_LINE" | tr -d '\r ')
			case "$PM_MIG_LINE" in ''|\#*) continue ;; esac
			pm_migration_inventory 0 "$PM_MIG_WORK" || return 1
			if pm_valid_package_name "$PM_MIG_LINE" &&
			   pm_resolve_profile_uid 0 "$PM_MIG_LINE" "$PM_MIG_INVENTORY" > /dev/null; then
				printf '0 %s\n' "$PM_MIG_LINE" >> "$PM_MIG_WORK/apps"
			else
				pm_migration_report skip-package "$PM_MIG_LINE"
			fi
		done < "$3"
	fi

	# deny_uids.conf holds raw UIDs. Only a UID owned by exactly one ordinary
	# app of an existing user maps onto a profile.
	if [ -f "$4" ]; then
		while IFS= read -r PM_MIG_LINE || [ -n "$PM_MIG_LINE" ]; do
			PM_MIG_LINE=$(printf '%s' "$PM_MIG_LINE" | tr -d '\r')
			case "$PM_MIG_LINE" in ''|\#*) continue ;; esac
			printf '%s\n' "$PM_MIG_LINE" | tr ',' '\n' | tr -d ' \t'
		done < "$4" > "$PM_MIG_WORK/uids" || return 1
		PM_MIG_SEEN=" "
		while IFS= read -r PM_MIG_UID; do
			case "$PM_MIG_UID" in ''|*[!0-9]*) continue ;; esac
			case "$PM_MIG_SEEN" in *" $PM_MIG_UID "*) continue ;; esac
			PM_MIG_SEEN="$PM_MIG_SEEN$PM_MIG_UID "
			PM_MIG_PKG=""
			PM_MIG_USER=0
			# A leading zero is not a canonical UID (and would read as octal).
			case "$PM_MIG_UID" in
				0?*) ;;
				*)
					if [ "${#PM_MIG_UID}" -le 10 ]; then
						PM_MIG_USER=$((PM_MIG_UID / 100000))
						if pm_migration_inventory "$PM_MIG_USER" "$PM_MIG_WORK"; then
							PM_MIG_PKG=$(LC_ALL=C awk -v uid="uid:$PM_MIG_UID" '
								$1 ~ /^package:[A-Za-z0-9_.]+$/ && NF == 2 && $2 == uid { n++; name = substr($1, 9) }
								END { if (n == 1) print name }
							' "$PM_MIG_INVENTORY")
						elif [ "$PM_MIG_USER" = 0 ]; then
							return 1
						fi
					fi
					;;
			esac
			if [ -n "$PM_MIG_PKG" ] && pm_valid_package_name "$PM_MIG_PKG" &&
			   pm_resolve_profile_uid "$PM_MIG_USER" "$PM_MIG_PKG" "$PM_MIG_INVENTORY" > /dev/null; then
				printf '%s %s\n' "$PM_MIG_USER" "$PM_MIG_PKG" >> "$PM_MIG_WORK/apps"
				pm_migration_report uid-app "$PM_MIG_UID" "$PM_MIG_PKG"
			else
				pm_migration_report skip-uid "$PM_MIG_UID"
			fi
		done < "$PM_MIG_WORK/uids"
	fi
	APP_PROFILE_ERROR="cannot prepare the migration workspace"
	LC_ALL=C sort -u "$PM_MIG_WORK/apps" > "$PM_MIG_WORK/apps.sorted" || return 1

	# Only literal shared paths carry over. Glob lines (Scene's randomized
	# /dev/<hash> mount) resolve differently on every boot and per-app rules
	# have no runtime expansion, so they are reported rather than frozen.
	if [ -s "$PM_MIG_WORK/apps.sorted" ] && [ -f "$2" ]; then
		APP_PROFILE_ERROR="unreadable shared path configuration"
		LC_ALL=C awk -v exclude_file="${7:-}" '
			BEGIN {
				if (exclude_file != "")
					while ((getline line < exclude_file) > 0) excluded[line] = 1
			}
			{ sub(/\r$/, "") }
			/^[ \t]*$/ || /^#/ { next }
			{
				raw = $0
				line = raw
				sub(/^any:[^:]*:/, "", line)
				parent = 0
				if (line ~ /^dir:/) { parent = 1; line = substr(line, 5) }
				if (line ~ /[*?[]/) { print "dynamic " raw; next }
				if (parent) { sub(/\/[^\/]*$/, "", line); if (line == "") line = "/" }
				if (line !~ /^\// || line ~ /^\/+$/ || line ~ /[,;[:cntrl:]]/ ||
				    line ~ / $/ || length(line) > 255) { print "invalid " raw; next }
				if (!(line in excluded) && !seen[line]++) print "ok " line
			}
		' "$2" > "$PM_MIG_WORK/path-scan" || return 1
		while IFS= read -r PM_MIG_LINE; do
			case "$PM_MIG_LINE" in
				'ok '*)
					PM_MIG_PATH=${PM_MIG_LINE#ok }
					# The WebUI only stores per-app paths that exist.
					if [ -e "$PM_MIG_PATH" ]; then
						printf '%s\n' "$PM_MIG_PATH" >> "$PM_MIG_WORK/paths"
						pm_migration_report path "$PM_MIG_PATH"
					else
						pm_migration_report skip-missing "$PM_MIG_PATH"
					fi
					;;
				*) pm_migration_report "skip-$PM_MIG_LINE" ;;
			esac
		done < "$PM_MIG_WORK/path-scan"
	fi

	APP_PROFILE_ERROR="cannot merge the legacy blacklist"
	PM_MIG_STATUS=0
	LC_ALL=C awk -v filter="$PM_MIG_FILTER" -v max_paths="$APP_PROFILE_MAX_PATHS" \
		-v apps_file="$PM_MIG_WORK/apps.sorted" -v paths_file="$PM_MIG_WORK/paths" \
		-v report="$PM_MIG_WORK/merge-report" '
		function flush(k,    i) {
			if (k == "" || !(k in target)) return
			for (i = 1; i <= np; i++) {
				if ((k, path[i]) in have) continue
				have[k, path[i]] = 1
				print "path " path[i]
				added[k]++
				count[k]++
			}
		}
		BEGIN {
			printf "" > report
			while ((getline line < apps_file) > 0) {
				split(line, f, " ")
				k = f[1] ":" f[2]
				target[k] = 1; order[++na] = k; user[k] = f[1]; pkg[k] = f[2]
			}
			while ((getline line < paths_file) > 0) path[++np] = line
		}
		{ sub(/\r$/, "") }
		/^app / {
			flush(key)
			key = $2 ":" $3
			exists[key] = 1
			enabled[key] = $4
			print
			next
		}
		/^path / { have[key, substr($0, 6)] = 1; count[key]++ }
		{ print }
		END {
			flush(key)
			for (i = 1; i <= na; i++) {
				k = order[i]
				if (k in exists) {
					print (enabled[k] == "1" ? "app-merged " : "app-disabled ") user[k] " " pkg[k] " " added[k] + 0 > report
				} else if (np) {
					print "app " user[k] " " pkg[k] " 1 " filter
					for (j = 1; j <= np; j++) print "path " path[j]
					exists[k] = 1; enabled[k] = "1"; count[k] = np
					print "app-new " user[k] " " pkg[k] " " np > report
				} else {
					print "app-nopath " user[k] " " pkg[k] > report
				}
			}
			for (k in exists) if (enabled[k] == "1") active += count[k]
			print "active " active + 0 > report
			close(report)
			if (active > max_paths) exit 3
		}
	' "$PM_MIG_WORK/existing" > "$PM_MIG_WORK/candidate" || PM_MIG_STATUS=$?
	if [ "$PM_MIG_STATUS" = 3 ]; then
		APP_PROFILE_ERROR="migrated blacklist exceeds $APP_PROFILE_MAX_PATHS enabled paths"
		return 1
	fi
	[ "$PM_MIG_STATUS" = 0 ] || return 1
	if [ "$(wc -c < "$PM_MIG_WORK/candidate")" -gt "$APP_PROFILE_MAX_BYTES" ]; then
		APP_PROFILE_ERROR="migrated blacklist exceeds the configuration size limit"
		return 1
	fi
	while IFS= read -r PM_MIG_LINE; do
		pm_migration_report "$PM_MIG_LINE"
	done < "$PM_MIG_WORK/merge-report"
	APP_PROFILE_ERROR=""
}

# Per-app profile paths -> shared path list for global/allow modes. Each path
# of an enabled profile that the shared list lacks is appended once. Profiles
# are dormant in these modes, so an invalid file is reported, not fatal.
#   $1 app_profiles.conf  $2 target_path.conf  $3 private workspace
#   $4 optional list of profile paths that came from the legacy shared list;
#      they are not put back after being removed from it.
# Writes $3/targets and $3/added only when a path is added and prints the
# report.
pm_carry_profile_paths() {
	PM_MIG_WORK="$3"
	APP_PROFILE_ERROR="cannot prepare the migration workspace"
	{ : > "$PM_MIG_WORK/shared" && : > "$PM_MIG_WORK/requests"; } || return 1
	if [ ! -e "$1" ] && [ ! -L "$1" ]; then
		APP_PROFILE_ERROR=""
		return 0
	fi
	if ! { [ -f "$1" ] && [ ! -L "$1" ] && cat "$1" > "$PM_MIG_WORK/existing" &&
	       pm_parse_app_profiles "$PM_MIG_WORK/existing" > "$PM_MIG_WORK/requests"; }; then
		pm_migration_report profiles-invalid
		APP_PROFILE_ERROR=""
		return 0
	fi
	if [ -e "$2" ] || [ -L "$2" ]; then
		APP_PROFILE_ERROR="unreadable shared path configuration"
		{ [ -f "$2" ] && [ ! -L "$2" ] && cat "$2" > "$PM_MIG_WORK/shared"; } || return 1
	fi
	APP_PROFILE_ERROR="cannot merge per-app paths"
	PM_MIG_STATUS=0
	# Limits mirror the kernel's MAX_HIDE_TARGETS and TARGET_PATHS_LEN.
	LC_ALL=C awk -v report="$PM_MIG_WORK/carry-report" -v added="$PM_MIG_WORK/added" \
		-v exclude_file="${4:-}" '
		BEGIN {
			printf "" > report
			printf "" > added
			if (exclude_file != "")
				while ((getline line < exclude_file) > 0) have[line] = 1
		}
		FILENAME == ARGV[1] {
			line = $0
			sub(/\r$/, "", line)
			if (line ~ /^[ \t]*$/ || line ~ /^#/) next
			lines++
			bytes += length(line) + 1
			have[line] = 1
			sub(/^any:[^:]*:/, "", line)
			have[line] = 1
			next
		}
		{
			p = $0
			sub(/^[^ ]+ [^ ]+ [^ ]+ /, "", p)
			if (p in have) next
			have[p] = 1
			# A glob character would turn a literal per-app path into a pattern.
			if (p ~ /[*?[]/) { print "skip-pattern " p > report; next }
			print p > added
			print "shared-path " p > report
			lines++
			bytes += length(p) + 1
			n++
		}
		END {
			close(report)
			close(added)
			if (n && (lines > 64 || bytes > 4095)) exit 3
			exit n ? 4 : 0
		}
	' "$PM_MIG_WORK/shared" "$PM_MIG_WORK/requests" || PM_MIG_STATUS=$?
	if [ "$PM_MIG_STATUS" = 3 ]; then
		APP_PROFILE_ERROR="shared path list would exceed the kernel's 64-path limit"
		return 1
	fi
	if [ "$PM_MIG_STATUS" = 4 ]; then
		APP_PROFILE_ERROR="cannot write the shared path candidate"
		{
			cat "$PM_MIG_WORK/shared"
			if [ -s "$PM_MIG_WORK/shared" ] && [ -n "$(tail -c 1 "$PM_MIG_WORK/shared")" ]; then
				printf '\n'
			fi
			cat "$PM_MIG_WORK/added"
		} > "$PM_MIG_WORK/targets" || return 1
	elif [ "$PM_MIG_STATUS" != 0 ]; then
		return 1
	fi
	while IFS= read -r PM_MIG_LINE; do
		pm_migration_report "$PM_MIG_LINE"
	done < "$PM_MIG_WORK/carry-report"
	APP_PROFILE_ERROR=""
}
