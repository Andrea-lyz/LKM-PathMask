const test = require("node:test");
const assert = require("node:assert/strict");

const {
	ALL_SYSCALL_HOOKS,
	DEFAULT_SYSCALL_HOOKS,
	DEFAULT_WAIT_SECONDS,
	LOG_PAGE_LINES,
	countCsv,
	joinTargetLine,
	linesFromText,
	normalizeScope,
	paginate,
	parseBoolish,
	parseBootState,
	parsePackageLine,
	parseSceneDebugfsState,
	parseSyscallHooksText,
	parseWaitSeconds,
	shellQuote,
	splitTargetLine,
} = require("../js/core/format.js");

test("splitTargetLine parses plain, dir and grouped targets", () => {
	assert.deepEqual(splitTargetLine("/system_ext/app/SoterService"), {
		group: "",
		useParent: false,
		path: "/system_ext/app/SoterService",
	});
	assert.deepEqual(splitTargetLine("dir:/data/local/tmp/secret"), {
		group: "",
		useParent: true,
		path: "/data/local/tmp/secret",
	});
	assert.deepEqual(splitTargetLine("any:scene:dir:/dev/???/scene_mode_category"), {
		group: "scene",
		useParent: true,
		path: "/dev/???/scene_mode_category",
	});
});

test("joinTargetLine round-trips the supported prefix order", () => {
	assert.equal(joinTargetLine("/a", false, ""), "/a");
	assert.equal(joinTargetLine(" /a ", true, ""), "dir:/a");
	assert.equal(joinTargetLine("/a", false, "scene"), "any:scene:/a");
	assert.equal(joinTargetLine("/a", true, "scene"), "any:scene:dir:/a");
	assert.equal(joinTargetLine("   ", true, "scene"), "");
});

test("parseBoolish accepts service.sh booleans and falls back", () => {
	for (const value of ["1", "true", "YES", "on", "y"]) {
		assert.equal(parseBoolish(value), true);
	}
	for (const value of ["0", "false", "NO", "off", "n"]) {
		assert.equal(parseBoolish(value), false);
	}
	assert.equal(parseBoolish("", true), true);
	assert.equal(parseBoolish("maybe", false), false);
});

test("normalizeScope keeps known scopes and defaults to deny", () => {
	assert.equal(normalizeScope(" global "), "global");
	assert.equal(normalizeScope("allow"), "allow");
	assert.equal(normalizeScope("deny"), "deny");
	assert.equal(normalizeScope(""), "deny");
	assert.equal(normalizeScope("wat"), "deny");
});

test("linesFromText trims, drops comments and blank lines", () => {
	assert.deepEqual(linesFromText("  /a  \r\n# comment\n\n /b\n"), ["/a", "/b"]);
	assert.deepEqual(linesFromText("# only comments"), []);
});

test("countCsv counts non-empty comma-separated values", () => {
	assert.equal(countCsv("10100, 10101,, 10102"), 3);
	assert.equal(countCsv(""), 0);
});

test("paginate splits logs into fixed-size pages", () => {
	const lines = Array.from({ length: LOG_PAGE_LINES + 2 }, (_, i) => `line-${i}`);
	const pages = paginate(lines.join("\n"));
	assert.equal(pages.length, 2);
	assert.equal(pages[0].split("\n").length, LOG_PAGE_LINES);
	assert.equal(pages[1], "line-80\nline-81");
	assert.deepEqual(paginate(""), [""]);
});

test("parsePackageLine accepts pm list packages -U output", () => {
	assert.deepEqual(parsePackageLine("package:com.example.app uid:10123"), {
		pkg: "com.example.app",
		uid: "10123",
	});
	assert.equal(parsePackageLine("package:com.example.app"), null);
	assert.equal(parsePackageLine(""), null);
});

test("parseBootState decodes key=value state files", () => {
	assert.deepEqual(parseBootState("state=loaded\nupdated=100\ndeadline=160\ndetail=ok"), {
		state: "loaded",
		updated: 100,
		deadline: 160,
		detail: "ok",
	});
	assert.deepEqual(parseBootState(""), { state: "", updated: 0, deadline: 0, detail: "" });
});

test("parseSceneDebugfsState decodes all known keys", () => {
	assert.deepEqual(
		parseSceneDebugfsState("enabled=1\napplied_enabled=0\nstatus=found\npackage_status=installed\ncount=2\nupdated=9\ndetail=/dev/x"),
		{
			enabled: 1,
			appliedEnabled: 0,
			status: "found",
			packageStatus: "installed",
			count: 2,
			updated: 9,
			detail: "/dev/x",
		},
	);
});

test("parseSyscallHooksText handles defaults, all, none and unknown tokens", () => {
	assert.deepEqual([...parseSyscallHooksText("")], DEFAULT_SYSCALL_HOOKS);
	assert.deepEqual([...parseSyscallHooksText("all")], ALL_SYSCALL_HOOKS);
	assert.deepEqual([...parseSyscallHooksText("none")], []);
	assert.deepEqual([...parseSyscallHooksText("statx, unknown\nopenat")], ["statx", "openat"]);
});

test("parseWaitSeconds uses the default for invalid or non-positive values", () => {
	assert.equal(parseWaitSeconds("90"), 90);
	assert.equal(parseWaitSeconds("0"), DEFAULT_WAIT_SECONDS);
	assert.equal(parseWaitSeconds("nope"), DEFAULT_WAIT_SECONDS);
	assert.equal(parseWaitSeconds(""), DEFAULT_WAIT_SECONDS);
});

test("shellQuote makes a value safe for a POSIX shell", () => {
	assert.equal(shellQuote("/data/adb/pathmask"), "'/data/adb/pathmask'");
	assert.equal(shellQuote("a'b"), "'a'\\''b'");
});
