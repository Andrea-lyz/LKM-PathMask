/*
 * A stand-in for the KernelSU WebUI bridge.
 *
 * The manager injects `window.ksu` with exec / listPackages /
 * getPackagesInfo; the contract is the one published by the `kernelsu`
 * npm package (js/README.md in tiann/KernelSU). exec is callback-based,
 * not promise-based: the page passes a global function name and the
 * bridge calls it back with (errno, stdout, stderr).
 *
 * Commands are matched by substring, longest-first, so a specific rule
 * always beats a generic one. Anything unmatched returns empty stdout
 * with errno 0, which is what the real bridge does for a command that
 * legitimately produces no output -- the page is written to tolerate
 * that everywhere.
 */

export const FIXED_EPOCH = 1792000000;

const CONF = {
	"/data/adb/pathmask/target_path.conf": [
		"/dev/cpuset/scene-daemon",
		"dir:/dev/???/scene_mode_category",
		"/system_ext/app/SoterService",
	].join("\n"),
	"/data/adb/pathmask/scope_mode.conf": "deny",
	"/data/adb/pathmask/hide_dirents.conf": "1",
	"/data/adb/pathmask/deny_packages.conf": [
		"com.chunqiunativecheck",
		"com.eltavine.duckdetector",
		"luna.safe.luna",
	].join("\n"),
	"/data/adb/pathmask/deny_uids.conf": "10123",
	"/data/adb/pathmask/allow_packages.conf": "",
	"/data/adb/pathmask/allow_uids.conf": "",
	"/data/adb/pathmask/allow_system_uids.conf": "0\n1000\n2000",
	"/data/adb/pathmask/wait_seconds.conf": "60",
	"/data/adb/pathmask/enable_syscall_hooks.conf": "1",
	"/data/adb/pathmask/syscall_hooks.conf":
		"newfstatat,statx,faccessat2,readlinkat,openat,openat2",
	"/data/adb/pathmask/auto_scene_debugfs.conf": "0",
	"/data/adb/pathmask/scene_debugfs_paths": "",
	"/data/adb/pathmask/scene_debugfs_state": "",
	"/data/adb/pathmask/procguard.conf": "0",
	"/data/adb/pathmask/write_op_policy.conf": "passthrough",
	"/data/adb/pathmask/boot_state":
		`state=loaded\nupdated=${FIXED_EPOCH - 900}\ndeadline=0\ndetail=`,
	"/data/adb/pathmask/load_fail_count": "",
	"/data/adb/pathmask/load_fail_reason": "",
};

// A statusLog shaped like the real one: buildDmesgSection and
// parseSysfsParams both key off these section headers, so the stub has
// to carry them or the stale-config and verdict paths go untested.
const STATUS_LOG = `--- basic ---
Mon Oct  5 12:00:00 UTC 2026
Linux localhost 6.1.75-android14-11-gb1a2c3d4ab8f #1 SMP PREEMPT aarch64
14
OnePlus
OP5552L1
--- modules ---
pathmask 163840 0 - Live 0xffffffffc0800000 (O)
--- module files ---
-rw------- 1 root root 184320 2026-10-01 12:00 pathmask.ko
--- sysfs parameters ---
target_paths=/dev/cpuset/scene-daemon,dir:/dev/???/scene_mode_category,/system_ext/app/SoterService
resolved_count=3
scope_mode=deny
deny_uids=10123,10124,10125
enable_syscall_hooks=Y
syscall_hooks=newfstatat,statx,faccessat2,readlinkat,openat,openat2
write_op_policy=passthrough
--- procguard parameters ---
--- load failure guard ---
load_fail_count=0
`;

const DMESG = `[   12.345678] pathmask: hooked __arm64_sys_newfstatat
[   12.345701] pathmask: hooked __arm64_sys_openat
[   12.345733] pathmask: skip __arm64_sys_faccessat (disabled)
[   12.400001] pathmask: target[0] /dev/cpuset/scene-daemon ino=346 dev=0:80
[   12.500002] pathmask: loaded -- 3 target(s) hidden, scope=deny
[   98.100003] pathmask: inode_permission hook fired (first time)
`;

const MODULES_ALL = `pathmask 163840 0 - Live 0xffffffffc0800000 (O)
samsung_helper 24576 1 - Live 0xffffffffc0200000 (O)
`;

const PACKAGES = {
	user: [
		{ packageName: "com.chunqiunativecheck", appLabel: "Native Check", uid: 10123, isSystem: false },
		{ packageName: "com.eltavine.duckdetector", appLabel: "Duck Detector", uid: 10124, isSystem: false },
		{ packageName: "luna.safe.luna", appLabel: "Luna", uid: 10125, isSystem: false },
	],
	system: [
		{ packageName: "com.android.settings", appLabel: "Settings", uid: 1000, isSystem: true },
		{ packageName: "com.android.shell", appLabel: "Shell", uid: 2000, isSystem: true },
	],
};

/*
 * Ordered rules, first match wins, so the two multi-section diagnostic
 * blobs go first: their commands mention grep, uname and test operators
 * that would otherwise be caught by a narrower rule and return a
 * fragment instead of the whole block.
 */
const RULES = [
	// refreshDiagnostics' two big collectors.
	["--- basic ---", () => STATUS_LOG],
	["persistent config", () => "--- persistent config ---\n### target_path.conf\n"],
	["resolve_pkg", () => PACKAGES.user
		.map((p) => `${p.packageName}\t${p.uid}`)
		.join("\n")],

	["grep '^pathmask '", () => "pathmask 163840 0 - Live 0xffffffffc0800000 (O)"],
	["grep '^nohello '", () => ""],
	["grep '^procguard '", () => ""],
	["grep -E '^(pathmask|procguard|nohello) '", () =>
		"pathmask 163840 0 - Live 0xffffffffc0800000 (O)"],
	["cat /proc/modules", () => MODULES_ALL],
	["parameters/deny_uids", () => "10123,10124,10125"],
	["parameters/resolved_count", () => "3"],
	["parameters/blocked_hits", () => ""],
	["parameters/missed", () => ""],
	["parameters/target_gid", () => ""],
	["procguard.ko", () => "present"],
	// Quoted needles: every path reaches the shell through shellQuote(),
	// so an unquoted needle never matches.
	["&& ls -l '", () =>
		"-rw------- 1 root root 184320 2026-10-01 12:00 /data/adb/modules/pathmask/pathmask.ko"],
	["sha1sum", () => "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"],
	["stat -c '%s'", () => "184320"],
	["ls -1 '", () => ""],
	["[ -d '/data/adb/nohello' ]", () => ""],
	["uname -r", () => "6.1.75-android14-11-gb1a2c3d4ab8f"],
	["uname -a", () => "Linux localhost 6.1.75-android14-11-gb1a2c3d4ab8f #1 SMP PREEMPT aarch64"],
	["kernel/tainted", () => "4608"],
	["dmesg_restrict", () => "0"],
	["getconf PAGE_SIZE", () => "4096"],
	["getenforce", () => "Enforcing"],
	["dmesg", () => DMESG],
	["logcat", () => "10-05 12:00:01.000  1234  1234 I pathmask: service.sh start\n"],
	["grep '^version='", () => "version=2.8.3"],
	["date +%s", () => String(FIXED_EPOCH)],
	["pm list packages", () => PACKAGES.user
		.concat(PACKAGES.system)
		.map((p) => `package:${p.packageName} uid:${p.uid}`)
		.join("\n")],
	// refreshTargetProbe's existence probe: report each literal path as
	// present. Glob lines are emitted as `echo DYNAMIC <tag>` and
	// contribute nothing, which is what a healthy device looks like.
	["if [ -e", (cmd) => {
		const out = [];
		const re = /if \[ -e '([^']+)' \]; then echo OK '([^']+)'; else echo MISS '([^']+)'; fi/g;
		let m;
		while ((m = re.exec(cmd)) !== null) out.push(`OK ${m[2]}`);
		return out.join("\n");
	}],
	["packages.list", (cmd) => {
		const out = [];
		const m = cmd.match(/for p in ((?:'[^']*'\s*)+);/);
		if (m) {
			for (const quoted of m[1].trim().split(/\s+/)) {
				out.push(`OK ${quoted.replace(/'/g, "")}`);
			}
		}
		return out.join("\n");
	}],
];

/*
 * Every standalone conf read goes through readFile() /
 * readFileOrDefault(), whose command is exactly
 *   [ -f '<path>' ] && cat '<path>' || <fallback>
 * so anchor on that shape. A plain substring test is not enough: the
 * diagnostic collectors embed conf reads inside much larger scripts
 * (`$(cat '<fail_count>')` in statusLog, `cat '<scope_mode>'` in
 * configLog), and matching those would return one conf's body in place
 * of the whole block.
 */
function confLookup(command, overrides) {
	const table = overrides ? { ...CONF, ...overrides } : CONF;
	for (const [path, body] of Object.entries(table)) {
		if (command.startsWith(`[ -f '${path}' ] && cat '${path}'`)) return body;
	}
	return null;
}

export function resolveCommand(command, confOverrides) {
	const fromConf = confLookup(command, confOverrides);
	if (fromConf !== null) return fromConf;
	for (const [needle, handler] of RULES) {
		if (command.includes(needle)) return handler(command);
	}
	return "";
}

/*
 * Build the bridge. Options:
 *   window   the jsdom window the page runs in. Required: the callback
 *            the page registers lives there, not on Node's globalThis.
 *   swallow  a needle whose command is accepted but never answered, so
 *            the caller can exercise the exec watchdog.
 *   withoutNativePackages  omit listPackages / getPackagesInfo to model
 *            an older manager that only injects exec.
 *   onExec   called with every command, for assertions.
 */
export function createKsuStub(options = {}) {
	const calls = [];
	const pending = [];
	// Mutable so a test can wedge the bridge, watch the watchdog fire,
	// then unwedge it and confirm the page recovers.
	const state = { swallow: options.swallow || null };
	const host = () => options.window || null;

	const ksu = {
		exec(command, argsJson, callbackName) {
			calls.push(command);
			if (options.onExec) options.onExec(command);
			if (state.swallow && command.includes(state.swallow)) {
				pending.push(callbackName);
				return;
			}
			let stdout;
			try {
				stdout = resolveCommand(command, options.conf);
			} catch (error) {
				stdout = "";
			}
			// The real bridge answers asynchronously from the app
			// thread; a microtask keeps the page's await points
			// honest without adding wall-clock time to the test.
			Promise.resolve().then(() => {
				const view = host();
				const cb = view && view[callbackName];
				if (typeof cb === "function") cb(0, stdout, "");
			});
		},
	};

	if (!options.withoutNativePackages) {
		ksu.listPackages = (type) => {
			const key = type === "all" ? null : type;
			const all = PACKAGES.user.concat(PACKAGES.system);
			return (key ? PACKAGES[key] || [] : all).map((p) => p.packageName);
		};
		ksu.getPackagesInfo = (names) => {
			const all = PACKAGES.user.concat(PACKAGES.system);
			const wanted = new Set(names);
			return all.filter((p) => wanted.has(p.packageName));
		};
	}

	return { ksu, calls, pending, state };
}
