/**
 * Unit tests for the observational-memory guard on the compaction takeover.
 *
 * pi runs every `session_before_compact` handler and keeps the last non-cancel
 * result, so load order alone decides whether OM's free, already-computed
 * summary or the bridge's Claude Code one reaches the session. The bridge
 * declines when OM is certain to answer; the interesting half of "certain" is
 * the other direction — OM declines on an empty projection and pi's *native*
 * summarizer runs, which on a bridge model is the hang the takeover exists to
 * prevent (issue #8). So every case here that the bridge must *not* decline is
 * a case where OM would have produced nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { observationalMemoryDecision, observationalMemoryIsLoaded } from "../src/om-guard.js";

const CUT = "entry-cut";

function observation(id, over = {}) {
	return {
		id,
		content: "the user asked for a guard",
		timestamp: "2026-09-24T10:00:00.000Z",
		relevance: "high",
		sourceEntryIds: ["entry-1"],
		tokenCount: 12,
		...over,
	};
}

function reflection(id, over = {}) {
	return { id, content: "the project is a pi extension", supportingObservationIds: ["aaaaaaaaaaaa"], tokenCount: 8, ...over };
}

function recorded(customType, data) {
	return { type: "custom", id: `om-${customType}-${data.coversUpToId}`, customType, data };
}

/** A branch of plain messages with `extra` ledger entries spliced in before the cut. */
function branch(extra = []) {
	return [
		{ type: "message", id: "entry-1" },
		{ type: "message", id: "entry-2" },
		...extra,
		{ type: "message", id: CUT },
		{ type: "message", id: "entry-after" },
	];
}

describe("observationalMemoryDecision", () => {
	it("takes over when the branch carries no memory entries at all", () => {
		const decision = observationalMemoryDecision(branch(), CUT, true);

		assert.equal(decision.willSummarize, false,
			"OM declines on an empty projection, and then native compaction runs on a bridge model");
		assert.equal(decision.observations, 0);
	});

	it("declines when recorded observations cover the cut", () => {
		const entries = branch([
			recorded("om.observations.recorded", { observations: [observation("aaaaaaaaaaaa"), observation("bbbbbbbbbbbb")], coversUpToId: "entry-2" }),
		]);

		const decision = observationalMemoryDecision(entries, CUT, true);

		assert.equal(decision.willSummarize, true);
		assert.equal(decision.observations, 2);
		assert.equal(decision.reflections, 0);
	});

	it("declines on reflections alone, which OM folds from the full-fold boundary", () => {
		// No full-fold compaction in the branch, so OM's maintenance boundary covers
		// nothing and the ordinary projection has no reflections — but its full fold
		// reads them up to the cut. Only a non-empty answer from *both* is certain.
		const reflections = recorded("om.reflections.recorded", { reflections: [reflection("cccccccccccc")], coversUpToId: "entry-2" });

		assert.equal(observationalMemoryDecision(branch([reflections]), CUT, true).willSummarize, false,
			"OM's ordinary projection would be empty here, so OM would decline");

		const withFullFold = [
			{ type: "compaction", id: "c1", firstKeptEntryId: "entry-1", details: { type: "om.folded", version: 1, fullFold: true, observations: [], reflections: [] } },
			{ type: "message", id: "entry-1" },
			recorded("om.reflections.recorded", { reflections: [reflection("cccccccccccc")], coversUpToId: "entry-1" }),
			{ type: "message", id: CUT },
		];
		const decision = observationalMemoryDecision(withFullFold, CUT, true);

		assert.equal(decision.willSummarize, true, "the reflection is inside the maintenance boundary now");
		assert.equal(decision.reflections, 1);
	});

	it("takes over when every observation covering the cut has been dropped", () => {
		const entries = branch([
			recorded("om.observations.recorded", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "entry-1" }),
			recorded("om.observations.dropped", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "entry-1" }),
		]);

		// The drop is inside the full fold's boundary even with no maintenance
		// boundary, so OM's full projection is empty and its ordinary one is not —
		// the bridge takes over, which is the old behaviour and never a hang.
		assert.equal(observationalMemoryDecision(entries, CUT, true).willSummarize, false);
	});

	it("takes over when only drop entries are present", () => {
		const entries = branch([
			recorded("om.observations.dropped", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "entry-1" }),
		]);

		assert.equal(observationalMemoryDecision(entries, CUT, true).willSummarize, false);
	});

	it("takes over on entries OM's fold ignores", () => {
		const cases = {
			"an old V2 custom type": { type: "custom", id: "v2", customType: "om.memory.recorded", data: { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "entry-1" } },
			"an id that is not a memory id": recorded("om.observations.recorded", { observations: [observation("nope")], coversUpToId: "entry-1" }),
			"a missing tokenCount": recorded("om.observations.recorded", { observations: [observation("aaaaaaaaaaaa", { tokenCount: undefined })], coversUpToId: "entry-1" }),
			"an unknown relevance": recorded("om.observations.recorded", { observations: [observation("aaaaaaaaaaaa", { relevance: "urgent" })], coversUpToId: "entry-1" }),
			"no sourceEntryIds": recorded("om.observations.recorded", { observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: [] })], coversUpToId: "entry-1" }),
			"coverage of an entry not in this branch": recorded("om.observations.recorded", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "entry-elsewhere" }),
			"coverage after the cut": recorded("om.observations.recorded", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "entry-after" }),
		};

		for (const [name, entry] of Object.entries(cases)) {
			assert.equal(observationalMemoryDecision(branch([entry]), CUT, true).willSummarize, false,
				`${name}: OM's fold skips this, so OM would produce nothing and pi would fall to native compaction`);
		}
	});

	it("takes over when the cut is not an entry of this branch", () => {
		const entries = branch([
			recorded("om.observations.recorded", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "entry-1" }),
		]);

		// OM resolves firstKeptEntryId to an index too, and an unresolvable one
		// covers nothing: its projection is empty and it declines.
		assert.equal(observationalMemoryDecision(entries, "entry-nowhere", true).willSummarize, false);
		assert.equal(observationalMemoryDecision(entries, undefined, true).willSummarize, false);
	});

	it("takes over when OM's ledger has entries but OM is not loaded", () => {
		// The known gap: a session resumed with OM since disabled still carries its
		// entries. Declining here would hand the takeover to a handler nobody
		// registered, and pi's emit() would fall through to the native summarizer.
		const entries = branch([
			recorded("om.observations.recorded", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "entry-2" }),
		]);

		assert.equal(observationalMemoryDecision(entries, CUT, false).willSummarize, false);
	});

	it("declines when OM is loaded and its ledger has entries covering the cut", () => {
		const entries = branch([
			recorded("om.observations.recorded", { observations: [observation("aaaaaaaaaaaa")], coversUpToId: "entry-2" }),
		]);

		assert.equal(observationalMemoryDecision(entries, CUT, true).willSummarize, true);
	});

	it("takes over when the branch has no memory entries, loaded or not", () => {
		assert.equal(observationalMemoryDecision(branch(), CUT, false).willSummarize, false);
		assert.equal(observationalMemoryDecision(branch(), CUT, true).willSummarize, false);
	});
});

describe("observationalMemoryIsLoaded", () => {
	it("is true when the session has OM's status command registered", () => {
		assert.equal(observationalMemoryIsLoaded([{ name: "om:status" }]), true);
		assert.equal(observationalMemoryIsLoaded([{ name: "om:view" }, { name: "om:status" }]), true);
	});

	it("is false when no command list carries it, including an empty session", () => {
		assert.equal(observationalMemoryIsLoaded([]), false);
		assert.equal(observationalMemoryIsLoaded([{ name: "om:view" }]), false);
		assert.equal(observationalMemoryIsLoaded([{ name: "bug" }, { name: "compact" }]), false);
	});
});
