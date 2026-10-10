import {
	type AgentMode,
	type AgentResult,
	formatUserInputBlock,
} from "@cline/shared";
import type { TeamEvent } from "../../extensions/tools/team";
import {
	buildTeamProgressSummary,
	isDurableTeamEvent,
	toTeamProgressLifecycleEvent,
} from "../../extensions/tools/team";
import type { CoreSessionEvent } from "../../types/events";
import type { ActiveSession, TeamRunUpdate } from "../../types/session";

export function trackTeamRunState(
	session: ActiveSession,
	event: TeamEvent,
): void {
	switch (event.type) {
		case "run_queued":
		case "run_started":
			session.activeTeamRunIds.add(event.run.id);
			break;
		case "run_completed":
		case "run_failed":
		case "run_cancelled":
		case "run_interrupted": {
			let runError: string | undefined;
			if (event.type === "run_failed") {
				runError = event.run.error;
			} else if (
				event.type === "run_cancelled" ||
				event.type === "run_interrupted"
			) {
				runError = event.run.error ?? event.reason;
			}
			session.activeTeamRunIds.delete(event.run.id);
			session.pendingTeamRunUpdates.push({
				runId: event.run.id,
				agentId: event.run.agentId,
				taskId: event.run.taskId,
				status: event.type.replace("run_", "") as TeamRunUpdate["status"],
				error: runError,
				iterations: (event.run.result as { iterations?: number } | undefined)
					?.iterations,
			});
			notifyTeamRunWaiters(session);
			break;
		}
		default:
			break;
	}
}

export async function dispatchTeamEventToBackend(
	rootSessionId: string,
	event: TeamEvent,
	invokeOptional: (method: string, ...args: unknown[]) => Promise<void>,
): Promise<void> {
	switch (event.type) {
		case "run_progress":
			await invokeOptional(
				"onTeamTaskProgress",
				rootSessionId,
				event.run.agentId,
				event.message,
				{ kind: event.message === "heartbeat" ? "heartbeat" : "progress" },
			);
			break;
		case "agent_event":
			if (
				event.event.type === "content_start" &&
				event.event.contentType === "text" &&
				typeof event.event.text === "string"
			) {
				const snippet = event.event.text
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, 120);
				if (snippet) {
					await invokeOptional(
						"onTeamTaskProgress",
						rootSessionId,
						event.agentId,
						snippet,
						{ kind: "text" },
					);
				}
			}
			break;
		case "task_start":
			await invokeOptional(
				"onTeamTaskStart",
				rootSessionId,
				event.agentId,
				event.message,
			);
			break;
		case "task_end": {
			const status =
				event.status ??
				(event.error
					? "failed"
					: event.result?.finishReason === "aborted"
						? "cancelled"
						: "completed");
			if (status === "cancelled") {
				await invokeOptional(
					"onTeamTaskEnd",
					rootSessionId,
					event.agentId,
					"cancelled",
					"[done] aborted",
					event.result,
					event.result?.messages ?? event.messages,
				);
			} else if (status === "failed") {
				const message =
					event.error?.message || event.result?.text || "Teammate task failed";
				await invokeOptional(
					"onTeamTaskEnd",
					rootSessionId,
					event.agentId,
					"failed",
					`[error] ${message}`,
					event.result,
					event.result?.messages ?? event.messages,
				);
			} else {
				await invokeOptional(
					"onTeamTaskEnd",
					rootSessionId,
					event.agentId,
					"completed",
					`[done] ${event.result?.finishReason ?? "completed"}`,
					event.result,
					event.result?.messages,
				);
			}
			break;
		}
		default:
			break;
	}
}

/** Minimum gap between `team_progress` emits driven by telemetry events. */
export const TEAM_PROGRESS_TELEMETRY_THROTTLE_MS = 1000;

interface TelemetryProgressThrottle {
	last: number;
	timer?: ReturnType<typeof setTimeout>;
	pending?: () => void;
}
const telemetryProgressThrottle = new WeakMap<
	object,
	TelemetryProgressThrottle
>();

export function emitTeamProgress(
	session: ActiveSession,
	rootSessionId: string,
	event: TeamEvent,
	emit: (event: CoreSessionEvent) => void,
	now: () => number = Date.now,
): void {
	const teamRuntime = session.runtime.teamRuntime;
	if (!teamRuntime) return;
	const send = () => publishTeamProgress(session, rootSessionId, event, emit);
	// Streamed chunks and heartbeats don't change the summary's counts; building
	// it copies the whole team state, so throttle those to ~1/s per team. The
	// latest throttled event is sent at the end of the window so its activity
	// message is not lost.
	let throttle = telemetryProgressThrottle.get(teamRuntime);
	if (!throttle) {
		throttle = { last: 0 };
		telemetryProgressThrottle.set(teamRuntime, throttle);
	}
	if (isDurableTeamEvent(event)) {
		// A newer durable event supersedes any queued telemetry progress; sending
		// it afterwards would make e.g. a completed run look active again.
		throttle.pending = undefined;
		send();
		return;
	}
	const ts = now();
	const wait = TEAM_PROGRESS_TELEMETRY_THROTTLE_MS - (ts - throttle.last);
	if (wait <= 0) {
		throttle.last = ts;
		throttle.pending = undefined;
		send();
		return;
	}
	throttle.pending = send;
	if (!throttle.timer) {
		const state = throttle;
		state.timer = setTimeout(() => {
			state.timer = undefined;
			const pending = state.pending;
			state.pending = undefined;
			if (pending) {
				state.last = now();
				pending();
			}
		}, wait);
		(state.timer as { unref?: () => void }).unref?.();
	}
}

function publishTeamProgress(
	session: ActiveSession,
	rootSessionId: string,
	event: TeamEvent,
	emit: (event: CoreSessionEvent) => void,
): void {
	const teamRuntime = session.runtime.teamRuntime;
	if (!teamRuntime) return;
	const teamName = teamRuntime.getTeamName();
	emit({
		type: "team_progress",
		payload: {
			sessionId: rootSessionId,
			teamName,
			lifecycle: toTeamProgressLifecycleEvent({
				teamName,
				sessionId: rootSessionId,
				event,
			}),
			summary: buildTeamProgressSummary(teamName, teamRuntime.exportState()),
		},
	});
}

/**
 * How often a parked `waitForTeamRunUpdates()` re-reconciles against the team
 * runtime. Only a safety net for runs stranded while we are already waiting;
 * terminal events still wake the waiter immediately.
 */
export const TEAM_RUN_WAIT_RECHECK_MS = 5_000;

const TERMINAL_TEAM_RUN_STATUSES = new Set([
	"completed",
	"failed",
	"cancelled",
	"interrupted",
]);

/**
 * Drop tracked run ids the team runtime no longer reports as in flight.
 *
 * `activeTeamRunIds` is populated from `run_queued`/`run_started` and is only
 * ever cleared by the matching terminal event. Several real paths end a run
 * without emitting one — `hydrateState()` and `cleanup()` clear the whole run
 * map, and `emitEvent` swallows listener errors — so a run id can outlive the
 * run itself. Because `waitForTeamRunUpdates()` blocks while the set is
 * non-empty and is only woken by terminal events, one stranded id makes the
 * lead's auto-continue loop await a wakeup that can never arrive: the session
 * stops generating, the turn never settles, and every later prompt queues
 * behind it forever while the process stays healthy.
 *
 * The team runtime's run map is authoritative, so reconcile against it:
 * ids that are gone or already terminal are released, and a terminal run
 * still yields the update the lead was waiting for instead of being
 * silently dropped.
 */
export function reconcileActiveTeamRunIds(session: ActiveSession): void {
	const teamRuntime = session.runtime.teamRuntime;
	if (!teamRuntime || session.activeTeamRunIds.size === 0) return;
	for (const runId of [...session.activeTeamRunIds]) {
		const run = teamRuntime.getRun(runId);
		if (run && !TERMINAL_TEAM_RUN_STATUSES.has(run.status)) {
			continue;
		}
		session.activeTeamRunIds.delete(runId);
		if (!run) continue;
		// The run finished but its terminal event never reached us; surface
		// the outcome so the lead still gets told what happened.
		session.pendingTeamRunUpdates.push({
			runId: run.id,
			agentId: run.agentId,
			taskId: run.taskId,
			status: run.status as TeamRunUpdate["status"],
			error: run.error,
			iterations: (run.result as { iterations?: number } | undefined)
				?.iterations,
		});
	}
}

export function hasPendingTeamRunWork(session: ActiveSession): boolean {
	reconcileActiveTeamRunIds(session);
	return (
		session.activeTeamRunIds.size > 0 ||
		session.pendingTeamRunUpdates.length > 0
	);
}

export function shouldAutoContinueTeamRuns(
	session: ActiveSession,
	finishReason: AgentResult["finishReason"],
): boolean {
	if (session.aborting) {
		return false;
	}
	const canAutoContinue =
		finishReason === "completed" || finishReason === "max_iterations";
	if (!canAutoContinue) {
		return false;
	}
	return (
		session.config.enableAgentTeams === true && hasPendingTeamRunWork(session)
	);
}

export function notifyTeamRunWaiters(session: ActiveSession): void {
	const waiters = session.teamRunWaiters.splice(0);
	for (const resolve of waiters) resolve();
}

export async function waitForTeamRunUpdates(
	session: ActiveSession,
): Promise<TeamRunUpdate[]> {
	while (true) {
		if (session.aborting) return [];
		// Release run ids whose runs already ended without a terminal event
		// before deciding to block on them (see reconcileActiveTeamRunIds).
		reconcileActiveTeamRunIds(session);
		if (session.pendingTeamRunUpdates.length > 0) {
			const updates = [...session.pendingTeamRunUpdates];
			session.pendingTeamRunUpdates.length = 0;
			return updates;
		}
		if (session.activeTeamRunIds.size === 0) return [];
		// Terminal events are the fast path, but a run can also be stranded
		// *while* we are parked here (the team state is hydrated or cleaned
		// up mid-wait), and that strands no wakeup of its own. Re-check on a
		// timer so the loop above always gets another chance to reconcile
		// instead of sleeping forever on a run that no longer exists.
		await new Promise<void>((resolve) => {
			let settled = false;
			const wake = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(wake, TEAM_RUN_WAIT_RECHECK_MS);
			(timer as { unref?: () => void }).unref?.();
			session.teamRunWaiters.push(wake);
		});
	}
}

export function buildTeamRunContinuationPrompt(
	session: ActiveSession,
	updates: TeamRunUpdate[],
): string {
	const lines = updates.map((u) => {
		const parts = [`- ${u.runId} (${u.agentId}) -> ${u.status}`];
		if (u.taskId) parts.push(` task=${u.taskId}`);
		if (typeof u.iterations === "number")
			parts.push(` iterations=${u.iterations}`);
		if (u.error) parts.push(` error=${u.error}`);
		return parts.join("");
	});
	const remaining = session.activeTeamRunIds.size;
	const instruction =
		remaining > 0
			? `There are still ${remaining} teammate run(s) in progress. Continue coordination and decide whether to wait for more updates.`
			: "No teammate runs are currently in progress. Continue coordination using these updates.";
	return formatModePrompt(
		`System-delivered teammate async run updates:\n${lines.join("\n")}\n\n${instruction}`,
		session.config.mode,
	);
}

export function formatModePrompt(
	prompt: string,
	mode: AgentMode | undefined,
): string {
	return formatUserInputBlock(
		prompt,
		mode === "plan" ? "plan" : mode === "yolo" ? "yolo" : "act",
	);
}
