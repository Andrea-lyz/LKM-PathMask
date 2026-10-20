const test = require("node:test");
const assert = require("node:assert/strict");

const bridgeModule = require("../js/core/bridge.js");
const appsModule = require("../js/domain/apps.js");

function fakeBridge({ fail = false, legacy = false } = {}) {
	return {
		calls: [],
		exec(command, options, callback) {
			if (legacy) {
				if (typeof callback !== "undefined") throw new Error("legacy bridge only accepts two arguments");
				callback = options;
				options = undefined;
			}
			this.calls.push({ command, options, callback });
			setTimeout(() => {
				const done = typeof callback === "string" ? globalThis[callback] : callback;
				if (fail) done(1, "", "denied");
				else done(0, `out:${command}`, "");
			}, 0);
		},
	};
}

test("execShell resolves stdout and passes a JSON options object", async () => {
	const bridge = fakeBridge();
	const out = await bridgeModule.execShell("echo hi", { bridge });
	assert.equal(out, "out:echo hi");
	assert.equal(JSON.parse(bridge.calls[0].options).cwd, undefined);
});

test("execShell falls back to the two-argument bridge signature", async () => {
	const bridge = fakeBridge({ legacy: true });
	const out = await bridgeModule.execShell("id", { bridge });
	assert.equal(out, "out:id");
});

test("execShell rejects with errno and stderr", async () => {
	const bridge = fakeBridge({ fail: true });
	await assert.rejects(
		bridgeModule.execShell("bad", { bridge }),
		(error) => error.errno === 1 && error.stderr === "denied",
	);
});

test("execShell rejects when the bridge is unavailable", async () => {
	await assert.rejects(
		bridgeModule.execShell("id", { bridge: null }),
		/KernelSU WebUI API/,
	);
});

test("safeExec returns an ERROR string and probeExec returns structured data", async () => {
	assert.equal(await bridgeModule.safeExec("bad", { bridge: fakeBridge({ fail: true }) }), "ERROR: denied");
	const probe = await bridgeModule.probeExec("bad", { bridge: fakeBridge({ fail: true }) });
	assert.deepEqual(
		{ ok: probe.ok, errno: probe.errno, stderr: probe.stderr },
		{ ok: false, errno: 1, stderr: "denied" },
	);
});

test("detectCapabilities reports only implemented ksu methods", () => {
	const caps = bridgeModule.detectCapabilities({
		exec() {},
		moduleInfo() {},
		getPackagesInfo() {},
	});
	assert.deepEqual(caps, {
		exec: true,
		moduleInfo: true,
		listPackages: false,
		getPackagesInfo: true,
		enableEdgeToEdge: false,
		toast: false,
	});
});

test("getModuleInfo parses the bridge JSON and tolerates failure", () => {
	const bridge = { moduleInfo: () => JSON.stringify({ id: "pathmask", version: "2.8.3" }) };
	assert.deepEqual(bridgeModule.getModuleInfo(bridge), { id: "pathmask", version: "2.8.3" });
	assert.equal(bridgeModule.getModuleInfo({ moduleInfo: () => "not json" }), null);
	assert.equal(bridgeModule.getModuleInfo(null), null);
});

test("parsePackageList drops malformed lines and keeps uid text", () => {
	const rows = appsModule.parsePackageList(
		"package:com.b uid:10102\nnoise\npackage:com.a uid:10101\npackage:com.c\n",
	);
	assert.deepEqual(rows, [
		{ pkg: "com.b", uid: "10102" },
		{ pkg: "com.a", uid: "10101" },
	]);
});

test("mergePackages enriches rows and marks unresolved packages", () => {
	const rows = [
		{ pkg: "com.a", uid: "10101" },
		{ pkg: "com.missing", uid: "10102" },
	];
	const infos = [
		{ packageName: "com.a", appLabel: "Alpha", isSystem: false, uid: 10101 },
		{ packageName: "com.missing", error: "Package not found or inaccessible" },
	];
	assert.deepEqual(appsModule.mergePackages(rows, infos), [
		{ pkg: "com.a", uid: "10101", label: "Alpha", isSystem: false, resolved: true, icon: "ksu://icon/com.a" },
		{ pkg: "com.missing", uid: "10102", label: "com.missing", isSystem: false, resolved: false, icon: "" },
	]);
});

test("filterApps searches label and package, filters by system and selection", () => {
	const apps = [
		{ pkg: "com.zeta", label: "Zeta", isSystem: true, uid: "1000" },
		{ pkg: "com.alpha", label: "Alpha", isSystem: false, uid: "10101" },
		{ pkg: "com.beta", label: "Beta", isSystem: false, uid: "10102" },
	];
	const selected = new Set(["com.beta"]);
	assert.deepEqual(
		appsModule.filterApps(apps, { query: "bet", filter: "all", selected }).map((a) => a.pkg),
		["com.beta"],
	);
	assert.deepEqual(
		appsModule.filterApps(apps, { query: "", filter: "system", selected }).map((a) => a.pkg),
		["com.zeta"],
	);
	assert.deepEqual(
		appsModule.filterApps(apps, { query: "", filter: "selected", selected }).map((a) => a.pkg),
		["com.beta"],
	);
	assert.deepEqual(
		appsModule.filterApps(apps, { query: "", filter: "all", selected }).map((a) => a.pkg),
		["com.beta", "com.alpha", "com.zeta"],
	);
});
