#!/usr/bin/env node
// The bridge declines the compaction takeover when pi-observational-memory will
// answer it — and still takes over when OM has nothing to say.
//
// pi's runner keeps the LAST non-cancel `session_before_compact` result, so with
// the bridge loaded after OM (the order here, and the order in the report) the
// bridge's Claude Code summarization replaced OM's rendering and /om:status read
// 0 visible observations from the compaction details it was handed.
//
// OM's observer needs a model, which this test has no business spending: a tiny
// seed extension writes the `om.observations.recorded` entry OM's own fold reads
// instead, and OM runs in passive mode so nothing else of it touches a model.
// The control run is the same session with that seeding switched off, which is
// where the takeover must still happen — an unconditional decline there leaves a
// bridge model to pi's native summarizer, the hang of issue #8.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 180_000;
const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";
const OM_ENTRY = join(homedir(), ".pi/agent/npm/node_modules/pi-observational-memory/src/index.ts");
// The first line of OM's renderSummary preamble (session-ledger/render-summary.ts).
const OM_SUMMARY_HEAD = "These are condensed memories from earlier in this session.";
const SEEDED_OBSERVATION = "the guard test seeded this observation without a model call";

if (!existsSync(OM_ENTRY)) {
	console.log(`SKIP: pi-observational-memory is not installed at ${OM_ENTRY}`);
	process.exit(0);
}

const workDir = mkdtempSync(join(tmpdir(), "compact-om-guard-"));
const seedExtension = join(workDir, "seed-om-entries.mjs");

// One valid V3 observation record covering the head of the branch, the way OM's
// consolidation trigger would have written it once its observer had run.
writeFileSync(seedExtension, `
export default function seedOmEntries(pi) {
	if (process.env.OM_GUARD_SEED !== "1") return;
	let seeded = false;
	pi.on("turn_end", (_event, ctx) => {
		if (seeded) return;
		const first = ctx.sessionManager.getBranch().find((entry) => entry.type === "message");
		if (!first) return;
		seeded = true;
		pi.appendEntry("om.observations.recorded", {
			observations: [{
				id: "a1b2c3d4e5f6",
				content: ${JSON.stringify(SEEDED_OBSERVATION)},
				timestamp: new Date().toISOString(),
				relevance: "high",
				sourceEntryIds: [first.id],
				tokenCount: 12,
			}],
			coversUpToId: first.id,
		});
		console.error("[seed-om-entries] appended om.observations.recorded coversUpToId=" + first.id);
	});
}
`);

async function run({ name, seed, loadOM = true }) {
	const testAgentDir = mkdtempSync(join(workDir, `${name}-agent-`));
	writeFileSync(join(testAgentDir, "settings.json"), JSON.stringify({
		compaction: { keepRecentTokens: 50 },
	}));

	const harness = createRpcHarness({
		name: `compact-om-guard-${name}`,
		args: ["--model", BRIDGE_MODEL],
		// OM and the seeder first, the bridge last: the losing order, and the one the
		// fix has to survive. Loading the bridge first would pass with no fix at all.
		// When loadOM is false, the seeder still runs (it needs no OM code to append
		// the entry) but OM itself is not on the extension list — the known gap: a
		// session resumed with OM since disabled, whose history still carries its
		// entries.
		extensionsBefore: loadOM ? [OM_ENTRY, seedExtension] : [seedExtension],
		env: {
			PI_CODING_AGENT_DIR: testAgentDir,
			PI_OBSERVATIONAL_MEMORY_PASSIVE: "1",
			OM_GUARD_SEED: seed ? "1" : "0",
		},
		defaultTimeout: TIMEOUT,
	});

	await harness.startAndWait(3000);
	try {
		console.log(`[${name}] seeding a few turns...`);
		await harness.promptAndWait("Pick a number between 1 and 100. Reply with just the number.");
		await harness.promptAndWait("Now pick a color. Reply with just the color.");
		await harness.promptAndWait("Now pick a fruit. Reply with just the fruit.");

		console.log(`[${name}] /compact...`);
		const compaction = await harness.send({ type: "compact" }, TIMEOUT);
		const log = readFileSync(harness.DEBUG_LOG, "utf8");
		if (!compaction?.summary?.trim()) {
			throw new Error(`[${name}] compact returned no summary: ${JSON.stringify(compaction)}`);
		}
		console.log(`[${name}] summary head: ${compaction.summary.slice(0, 90).replace(/\n/g, " ")}`);
		return { compaction, log, DEBUG_LOG: harness.DEBUG_LOG, RPC_LOG: harness.RPC_LOG };
	} finally {
		await harness.stop();
	}
}

const runs = [];
try {
	const seeded = await run({ name: "seeded", seed: true });
	runs.push(seeded);
	if (!seeded.compaction.summary.startsWith(OM_SUMMARY_HEAD)) {
		throw new Error(
			"the compaction entry does not carry observational memory's rendering — the bridge " +
			`took it over and OM's free summary was thrown away. Summary head: ${seeded.compaction.summary.slice(0, 300)}`,
		);
	}
	if (!seeded.compaction.summary.includes(SEEDED_OBSERVATION)) {
		throw new Error(
			`OM's preamble is there but the seeded observation is not. Summary: ${seeded.compaction.summary.slice(0, 500)}`,
		);
	}
	if (!/declining takeover .* observational memory will summarize \(observations=1 reflections=0\)/.test(seeded.log)) {
		throw new Error(
			"no decline line in the bridge debug log: OM's summary won for some other reason " +
			"(load order, an error in the bridge handler) and this test proves nothing about the guard.",
		);
	}
	if (/session_before_compact: takeover complete/.test(seeded.log)) {
		throw new Error("the bridge ran its own summarization anyway — it declined after spending the model call");
	}
	console.log("seeded: OM's summary reached the compaction entry, bridge declined");

	const control = await run({ name: "control", seed: false });
	runs.push(control);
	if (control.compaction.summary.startsWith(OM_SUMMARY_HEAD)) {
		throw new Error("control run got OM's summary, but nothing seeded OM's ledger");
	}
	if (!/session_before_compact: takeover complete/.test(control.log)) {
		throw new Error(
			"the bridge did not take over a compaction OM had nothing to say about. pi's native " +
			"summarizer over a bridge model is the hang of issue #8, and the takeover is what avoids it.",
		);
	}
	if (/declining takeover/.test(control.log)) {
		throw new Error("the bridge declined with an empty OM projection — OM declines too, so nobody answers");
	}
	console.log("control: no OM entries, bridge took over as before");

	// The known gap this branch used to leave open: entries in history from an OM
	// that is not loaded on this run. A decision made from history alone declines
	// to a handler nobody registered, and pi's emit() returns nothing for
	// session_before_compact — satisfying neither OM's answer nor the bridge's —
	// so pi's native summarizer calls the model directly instead. Measured here it
	// does not actually hang: pi marks that call cacheRetention:"none", and an
	// unrelated guard the bridge's main streamFn already has (599ffbb, predating
	// this one) reroutes any such call to the isolated path regardless of who
	// declined session_before_compact and why. So the assertion with teeth here
	// is the log, not a timeout: pre-fix, the bridge declines
	// ("declining takeover — observational memory will summarize") and never logs
	// "takeover complete", leaving this specific compaction correct only by way of
	// that unrelated safety net — which was never this guard's job to depend on,
	// and would leave a real hang if that other guard's marker ever narrowed.
	const notLoaded = await run({ name: "not-loaded", seed: true, loadOM: false });
	runs.push(notLoaded);
	if (notLoaded.compaction.summary.startsWith(OM_SUMMARY_HEAD)) {
		throw new Error("OM is not loaded on this run, so nothing could have rendered its preamble");
	}
	if (!/session_before_compact: takeover complete/.test(notLoaded.log)) {
		throw new Error(
			"the bridge did not take over even though OM is not loaded to answer instead — that is the " +
			"known gap this test exists to close, session_before_compact went unanswered.",
		);
	}
	if (/declining takeover/.test(notLoaded.log)) {
		throw new Error(
			"the bridge declined based on OM's entries in history even though OM is not loaded to answer — " +
			"nobody answered session_before_compact, which is the gap this guard exists to close",
		);
	}
	console.log("not-loaded: OM's entries are in history but OM is not loaded, bridge took over rather than declining");

	console.log("PASS");
} catch (e) {
	process.exitCode = 1;
	console.log(`FAIL: ${e.message}\n${e.stack}`);
	for (const r of runs) console.log(`  Debug log: ${r.DEBUG_LOG}\n  RPC log:   ${r.RPC_LOG}`);
} finally {
	rmSync(workDir, { recursive: true, force: true });
}
