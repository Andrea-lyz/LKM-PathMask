# TODO

## Multi-path hiding

Status: implemented.

Current behavior:

- `target_path` remains available for a legacy single path.
- `target_paths` accepts comma-separated paths.
- The KernelSU wrapper accepts one path per line in `target_path.conf`.
- Each existing path is resolved to a `(dev, inode)` pair at module load time.
- Missing paths are skipped; loading fails only if no configured path exists.

Follow-up ideas:

- Add duplicate target detection.
- Add a runtime debug log that prints the number of hidden entries removed from
  each `getdents64` buffer.

## Per-app rules

Status: implemented; kernel side still needs a DDK build and a device run.

Current behavior:

- `app_profiles.conf` holds one profile per (Android user, package): an enable
  switch, a directory-listing switch and its own path list.
- The kernel target table gained an owner UID per entry. A legacy target keeps
  the `scope_mode` / `deny_uids` gate; a per-app target is hidden only from
  that exact UID (real, effective or filesystem), so two apps can carry
  different paths in one module instance.
- Rules reach the kernel after insmod through
  `/sys/module/pathmask/parameters/app_profiles`; each write appends entries,
  `-` clears the per-app ones. This avoids the kernel command-line size limit
  and lets `service.sh` chunk a long ruleset.
- `profile_mode=1` lets the module load with no legacy `target_paths`, and
  never falls back to the legacy single-path default in that case.
- The WebUI writes the ruleset only when the user presses 应用到模块 twice; the
  legacy files are never rewritten by that action.

Known limits:

- Per-app rules cover the app's own UID, not its isolated processes.
- Only paths the boot script can resolve for the listed Android user apply;
  unresolved packages are logged and skipped.

## Scoped hiding / blacklist / whitelist

Status: implemented for UID blacklist and whitelist.

Current behavior:

- `scope_mode=global` keeps the old behavior.
- `scope_mode=deny` hides only from configured UIDs.
- `scope_mode=allow` hides from everyone except configured UIDs.
- The KernelSU wrapper resolves package names from `deny_packages.conf` or
  `allow_packages.conf` into UIDs before loading the module, based on the
  active scope mode.
- The KernelSU WebUI can edit paths, scoped packages, direct UIDs,
  `scope_mode`, and `hide_dirents`.

Follow-up ideas:

- Add process-name matching as a secondary filter.
- Add runtime config updates without unload/reload.
