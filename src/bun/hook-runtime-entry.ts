// @ts-nocheck
import { dirname } from "node:path";
import {
  appendHookDebugLog,
  databasePath,
  ensureDirectory,
  openHookRuntimeDatabase,
} from "./hook-runtime-support";
import { sendStopNotifications } from "./hook-runtime-notifications";
import { applyStopDecision, toHookStopOutput } from "./hook-runtime-stop";
import {
  findGeneratedTitleTargetSession,
  getEffectivePreset,
  getSession,
  getSettings,
  parseGeneratedTitlePayload,
  updateSessionTitle,
  upsertSession,
  writeSession,
} from "./hook-runtime-session-store";

function countSessions(db) {
  return db.query("select count(*) as count from sessions").get().count;
}

async function logHookEvent(details) {
  await appendHookDebugLog({
    type: "hook-event",
    ...details,
  });
}

async function parseHookInput() {
  return JSON.parse(await Bun.stdin.text());
}

function isSupportedHookEvent(input) {
  return (
    input.hook_event_name === "SessionStart" ||
    input.hook_event_name === "Stop" ||
    input.hook_event_name === "UserPromptSubmit"
  );
}

async function handleMissingSessionId(hookEventName, input, sessionCountBefore) {
  await logHookEvent({
    hookEventName,
    action: "ignored",
    reason: "missing-session-id",
    payload: input,
    sessionCountBefore,
    sessionCountAfter: sessionCountBefore,
  });
}

async function handleSessionStart(db, input, sessionCountBefore) {
  const session = upsertSession(db, input, input.source === "resume" ? "resume" : "startup");
  const sessionCountAfter = countSessions(db);

  await logHookEvent({
    hookEventName: "SessionStart",
    action: "upsert-session",
    sessionId: input.session_id,
    payload: input,
    sessionCountBefore,
    sessionCountAfter,
    storedSession: session,
  });
}

async function handleUserPromptSubmit(db, input, sessionCountBefore) {
  const existingSession = getSession(db, input.session_id);
  const session = upsertSession(db, input, existingSession?.source ?? "startup");
  const sessionCountAfter = countSessions(db);

  await logHookEvent({
    hookEventName: "UserPromptSubmit",
    action: existingSession ? "update-session-title" : "recover-session-on-prompt",
    sessionId: input.session_id,
    payload: input,
    sessionCountBefore,
    sessionCountAfter,
    storedSession: session,
  });
}

async function handleGeneratedTitle(db, input, sessionCountBefore, generatedTitle) {
  const titleTargetSession = findGeneratedTitleTargetSession(db, input);
  if (!titleTargetSession) {
    return false;
  }

  updateSessionTitle(db, titleTargetSession.sessionId, generatedTitle);
  const sessionCountAfter = countSessions(db);
  await logHookEvent({
    hookEventName: "Stop",
    action: "apply-generated-title",
    sessionId: input.session_id,
    targetSessionId: titleTargetSession.sessionId,
    generatedTitle,
    payload: input,
    sessionCountBefore,
    sessionCountAfter,
  });
  return true;
}

async function handleArchivedStop(db, input, sessionCountBefore) {
  const session = upsertSession(db, input, "stop");
  writeSession(db, session, true);
  const sessionCountAfter = countSessions(db);

  await logHookEvent({
    hookEventName: "Stop",
    action: "ignored",
    reason: "archived-session",
    sessionId: input.session_id,
    payload: input,
    sessionCountBefore,
    sessionCountAfter,
    storedSession: session,
  });
}

async function handleStop(db, input, sessionCountBefore) {
  const existingSession = getSession(db, input.session_id);
  const generatedTitle =
    input.transcript_path == null ? parseGeneratedTitlePayload(input.last_assistant_message) : null;
  if (
    generatedTitle &&
    (await handleGeneratedTitle(db, input, sessionCountBefore, generatedTitle))
  ) {
    return;
  }

  if (existingSession?.archived) {
    await handleArchivedStop(db, input, sessionCountBefore);
    return;
  }

  const settingsRow = getSettings(db);
  const session = upsertSession(db, input, "stop");
  session.stopCount += 1;
  writeSession(db, session, true);

  const deliveredTelegramTargets = await sendStopNotifications(db, input);
  const preset = getEffectivePreset(db, input.session_id);
  const stopDecision = await applyStopDecision(
    db,
    settingsRow,
    input.session_id,
    preset,
    input,
    deliveredTelegramTargets,
  );
  const sessionCountAfter = countSessions(db);

  await logHookEvent({
    hookEventName: "Stop",
    action: stopDecision ? "block-stop" : "allow-stop",
    reason: existingSession ? undefined : "recover-session-on-stop",
    sessionId: input.session_id,
    payload: input,
    sessionCountBefore,
    sessionCountAfter,
    storedSession: session,
    preset,
    remainingTurnsBefore: stopDecision?.remainingTurnsBefore ?? null,
    remainingTurnsAfter: stopDecision?.remainingTurnsAfter ?? null,
    promptSource: stopDecision?.promptSource ?? null,
  });

  const hookOutput = toHookStopOutput(stopDecision);
  if (hookOutput) {
    process.stdout.write(`${JSON.stringify(hookOutput)}\n`);
  }
}

async function handleHookEvent(db, input, sessionCountBefore) {
  if (input.hook_event_name === "SessionStart") {
    await handleSessionStart(db, input, sessionCountBefore);
    return;
  }

  if (input.hook_event_name === "UserPromptSubmit") {
    await handleUserPromptSubmit(db, input, sessionCountBefore);
    return;
  }

  await handleStop(db, input, sessionCountBefore);
}

async function main() {
  const input = await parseHookInput();
  if (!isSupportedHookEvent(input)) {
    return;
  }

  await ensureDirectory(dirname(databasePath));
  const db = openHookRuntimeDatabase();
  const sessionCountBefore = countSessions(db);

  try {
    if (typeof input.session_id !== "string" || input.session_id.length === 0) {
      await handleMissingSessionId(input.hook_event_name, input, sessionCountBefore);
      return;
    }

    await handleHookEvent(db, input, sessionCountBefore);
  } finally {
    db.close(false);
  }
}

await main().catch(async (error) => {
  await logHookEvent({
    action: "uncaught-error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
  });
  throw error;
});
