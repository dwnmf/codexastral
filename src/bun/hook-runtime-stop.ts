// @ts-nocheck
import { awaitReplyPollIntervalMs } from "./hook-runtime-support";
import {
  clearRemainingTurns,
  clearSessionAwaitingReplies,
  consumeSessionRemotePrompt,
  decrementRemainingTurns,
  getActiveCompletionCheckForSession,
  getEffectivePreset,
  getRemainingTurnState,
  readPersistentSessionRemotePrompt,
  renderPrompt,
  replaceSessionAwaitingReplies,
  runCompletionCheckCommands,
  shouldWaitForReplyAfterCompletion,
  getSettings,
} from "./hook-runtime-session-store";

function createBlockedStopDecision(
  reason,
  promptSource,
  remainingTurnsBefore,
  remainingTurnsAfter,
) {
  return {
    decision: "block",
    reason,
    remainingTurnsBefore,
    remainingTurnsAfter,
    promptSource,
  };
}

function getTurnId(input) {
  return typeof input?.turn_id === "string" ? input.turn_id : null;
}

function useQueuedPrompt(db, sessionId) {
  const queuedPrompt = consumeSessionRemotePrompt(db, sessionId);
  if (!queuedPrompt) {
    return null;
  }

  return createBlockedStopDecision(queuedPrompt, "telegram", null, null);
}

function usePersistentOrQueuedPrompt(
  db,
  sessionId,
  fallbackReason,
  remainingTurnsAfter = null,
  remainingTurnsBefore = null,
) {
  const remotePrompt =
    readPersistentSessionRemotePrompt(db, sessionId) ?? consumeSessionRemotePrompt(db, sessionId);
  return createBlockedStopDecision(
    remotePrompt ?? fallbackReason,
    remotePrompt ? "telegram" : "default",
    remainingTurnsBefore,
    remainingTurnsAfter,
  );
}

async function waitForAwaitReplyResolution(db, sessionId, waitMode = "await-reply") {
  while (true) {
    const remotePrompt = consumeSessionRemotePrompt(db, sessionId);
    if (remotePrompt) {
      return {
        type: "prompt",
        prompt: remotePrompt,
      };
    }

    const effectivePreset = getEffectivePreset(db, sessionId);
    const shouldKeepWaiting =
      waitMode === "completion-checks"
        ? effectivePreset === "completion-checks" &&
          shouldWaitForReplyAfterCompletion(db, sessionId)
        : effectivePreset === "await-reply";
    if (!shouldKeepWaiting) {
      return {
        type: "preset-change",
        preset: effectivePreset,
      };
    }

    await Bun.sleep(awaitReplyPollIntervalMs);
  }
}

async function resolveAfterAwaitingReply(db, sessionId, input, telegramTargets, waitMode) {
  const awaitingReplyCount = replaceSessionAwaitingReplies(
    db,
    sessionId,
    getTurnId(input),
    telegramTargets,
  );
  if (awaitingReplyCount <= 0) {
    clearSessionAwaitingReplies(db, sessionId);
    return null;
  }

  const resolution = await waitForAwaitReplyResolution(db, sessionId, waitMode);
  clearSessionAwaitingReplies(db, sessionId);
  if (resolution?.type === "prompt") {
    return createBlockedStopDecision(resolution.prompt, "telegram", null, null);
  }

  if (resolution?.type === "preset-change") {
    const nextSettingsRow = getSettings(db);
    return await applyStopDecision(db, nextSettingsRow, sessionId, resolution.preset, input, []);
  }

  return null;
}

function handleNoPreset(db, sessionId) {
  clearRemainingTurns(db, sessionId);
  clearSessionAwaitingReplies(db, sessionId);
  return null;
}

function handleInfinitePreset(db, settingsRow, sessionId) {
  clearSessionAwaitingReplies(db, sessionId);
  return usePersistentOrQueuedPrompt(db, sessionId, renderPrompt(settingsRow.default_prompt, null));
}

async function handleAwaitReplyPreset(db, sessionId, input, telegramTargets) {
  clearRemainingTurns(db, sessionId);

  const queuedPromptDecision = useQueuedPrompt(db, sessionId);
  if (queuedPromptDecision) {
    clearSessionAwaitingReplies(db, sessionId);
    return queuedPromptDecision;
  }

  return await resolveAfterAwaitingReply(db, sessionId, input, telegramTargets, "await-reply");
}

function handleCompletionCheckFailure(db, sessionId, reason) {
  clearSessionAwaitingReplies(db, sessionId);
  return createBlockedStopDecision(reason, "default", null, null);
}

async function handleCompletionChecksPreset(db, sessionId, input, telegramTargets) {
  clearRemainingTurns(db, sessionId);

  const activeCompletionCheck = getActiveCompletionCheckForSession(db, sessionId);
  const runResult = runCompletionCheckCommands(input, activeCompletionCheck.completionCheck);
  if (runResult.status === "failed") {
    return handleCompletionCheckFailure(db, sessionId, runResult.reason);
  }

  if (!activeCompletionCheck.waitForReplyAfterCompletion) {
    clearSessionAwaitingReplies(db, sessionId);
    return null;
  }

  const queuedPromptDecision = useQueuedPrompt(db, sessionId);
  if (queuedPromptDecision) {
    clearSessionAwaitingReplies(db, sessionId);
    return queuedPromptDecision;
  }

  return await resolveAfterAwaitingReply(
    db,
    sessionId,
    input,
    telegramTargets,
    "completion-checks",
  );
}

function handleMaxTurnsPreset(db, settingsRow, sessionId, preset) {
  const turnState = getRemainingTurnState(db, sessionId, preset);
  if (!turnState) {
    return handleNoPreset(db, sessionId);
  }

  if (turnState.remainingTurns <= 0) {
    clearSessionAwaitingReplies(db, sessionId);
    return null;
  }

  const remainingTurnsAfter = decrementRemainingTurns(db, sessionId, turnState.remainingTurns);
  clearSessionAwaitingReplies(db, sessionId);
  return usePersistentOrQueuedPrompt(
    db,
    sessionId,
    renderPrompt(settingsRow.default_prompt, remainingTurnsAfter),
    remainingTurnsAfter,
    turnState.remainingTurns,
  );
}

export async function applyStopDecision(
  db,
  settingsRow,
  sessionId,
  preset,
  input,
  telegramTargets,
) {
  if (!preset) {
    return handleNoPreset(db, sessionId);
  }

  if (preset === "infinite") {
    return handleInfinitePreset(db, settingsRow, sessionId);
  }

  if (preset === "await-reply") {
    return await handleAwaitReplyPreset(db, sessionId, input, telegramTargets);
  }

  if (preset === "completion-checks") {
    return await handleCompletionChecksPreset(db, sessionId, input, telegramTargets);
  }

  return handleMaxTurnsPreset(db, settingsRow, sessionId, preset);
}

export function toHookStopOutput(stopDecision) {
  if (!stopDecision || typeof stopDecision !== "object") {
    return null;
  }

  if (stopDecision.decision === "block" && typeof stopDecision.reason === "string") {
    return {
      decision: "block",
      justification: stopDecision.reason,
    };
  }

  return null;
}
