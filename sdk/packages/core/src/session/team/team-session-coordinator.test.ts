import { TeamMessageType } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import type { ActiveSession } from "../../types/session";
import {
	dispatchTeamEventToBackend,
	hasPendingTeamRunWork,
	TEAM_RUN_WAIT_RECHECK_MS,
	trackTeamRunState,
	waitForTeamRunUpdates,
} from "./team-session-coordinator";

describe("dispatchTeamEventToBackend", () => {
	it("persists intentionally aborted teammate tasks as cancelled", async () => {
		const invokeOptional = vi.fn(async () => {});
		const error = new DOMException("This operation was aborted", "AbortError");

		await dispatchTeamEventToBackend(
			"root-session",
			{
				type: TeamMessageType.TaskEnd,
				agentId: "teammate-1",
				status: "cancelled",
				error,
				messages: [],
			},
			invokeOptional,
		);

		expect(invokeOptional).toHaveBeenCalledWith(
			"onTeamTaskEnd",
			"root-session",
			"teammate-1",
			"cancelled",
			"[done] aborted",
			undefined,
			[],
		);
	});
});

type TestRun = {
	id: string;
	agentId: string;
	status: string;
	taskId?: string;
	error?: string;
	result?: { iterations?: number };
};

function createTeamSession(runs: TestRun[]): {
	session: ActiveSession;
	runsById: Map<string, TestRun>;
} {
	const runsById = new Map(runs.map((run) => [run.id, run]));
	const session = {
		activeTeamRunIds: new Set<string>(),
		pendingTeamRunUpdates: [],
		teamRunWaiters: [],
		aborting: false,
		config: { enableAgentTeams: true },
		runtime: {
			teamRuntime: {
				getRun: (runId: string) => runsById.get(runId),
			},
		},
	} as unknown as ActiveSession;
	return { session, runsById };
}

describe("team run tracking does not strand the lead session", () => {
	it("releases a tracked run the team runtime no longer knows about", () => {
		const { session, runsById } = createTeamSession([
			{ id: "run_00001", agentId: "t1", status: "running" },
		]);
		trackTeamRunState(session, {
			type: TeamMessageType.RunStarted,
			run: { id: "run_00001", agentId: "t1" },
		} as never);
		expect(hasPendingTeamRunWork(session)).toBe(true);

		// hydrateState()/cleanup() drop the run without a terminal event.
		runsById.delete("run_00001");

		expect(hasPendingTeamRunWork(session)).toBe(false);
		expect(session.activeTeamRunIds.size).toBe(0);
	});

	it("surfaces an update for a run that ended without a terminal event", async () => {
		const { session, runsById } = createTeamSession([
			{ id: "run_00001", agentId: "t1", status: "running" },
		]);
		trackTeamRunState(session, {
			type: TeamMessageType.RunStarted,
			run: { id: "run_00001", agentId: "t1" },
		} as never);

		// The run reaches a terminal state but its event never arrives
		// (emitEvent swallows listener errors).
		const run = runsById.get("run_00001");
		if (run) {
			run.status = "failed";
			run.error = "boom";
			run.result = { iterations: 3 };
		}

		const updates = await waitForTeamRunUpdates(session);
		expect(updates).toEqual([
			{
				runId: "run_00001",
				agentId: "t1",
				taskId: undefined,
				status: "failed",
				error: "boom",
				iterations: 3,
			},
		]);
		expect(session.activeTeamRunIds.size).toBe(0);
	});

	it("wakes up when a run is stranded while the lead is already waiting", async () => {
		vi.useFakeTimers();
		try {
			const { session, runsById } = createTeamSession([
				{ id: "run_00001", agentId: "t1", status: "running" },
			]);
			trackTeamRunState(session, {
				type: TeamMessageType.RunStarted,
				run: { id: "run_00001", agentId: "t1" },
			} as never);

			let settled = false;
			const waiting = waitForTeamRunUpdates(session).then((updates) => {
				settled = true;
				return updates;
			});

			// Parked on a live run: nothing to report yet.
			await vi.advanceTimersByTimeAsync(TEAM_RUN_WAIT_RECHECK_MS * 2);
			expect(settled).toBe(false);

			// The run disappears mid-wait, emitting no event and no wakeup.
			// Before the fix this blocked the turn (and the session) forever.
			runsById.delete("run_00001");
			await vi.advanceTimersByTimeAsync(TEAM_RUN_WAIT_RECHECK_MS);

			await expect(waiting).resolves.toEqual([]);
			expect(session.activeTeamRunIds.size).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
