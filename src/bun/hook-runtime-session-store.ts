// @ts-nocheck
import { resolveSessionPresetState } from "./loopndroll-core";
import { runPlatformShellCommand } from "./platform-runtime";
import {
  generatedTitleMatchWindowMs,
  nowIsoString,
  withSqliteBusyRetry,
} from "./hook-runtime-support";

export function getSettings(db) {
  const row = db
    .query(
      "select default_prompt, scope, global_preset, global_notification_id, global_completion_check_id, global_completion_check_wait_for_reply, hooks_auto_registration from settings where id = 1",
    )
    .get();
  if (!row) {
    throw new Error("Loopndroll settings row is missing.");
  }

  return row;
}

function getValidGlobalNotificationId(db, candidate) {
  if (typeof candidate !== "string") {
    return null;
  }

  const notificationId = candidate.trim();
  if (notificationId.length === 0) {
    return null;
  }

  const existingNotification = db
    .query("select id from notifications where id = ?")
    .get(notificationId);

  return existingNotification ? notificationId : null;
}

function getValidGlobalCompletionCheckId(db, candidate) {
  if (typeof candidate !== "string") {
    return null;
  }

  const completionCheckId = candidate.trim();
  if (completionCheckId.length === 0) {
    return null;
  }

  const existingCompletionCheck = db
    .query("select id from completion_checks where id = ?")
    .get(completionCheckId);

  return existingCompletionCheck ? completionCheckId : null;
}

function parseCompletionCheckCommands(commandsJson) {
  try {
    const parsed = JSON.parse(commandsJson);
    return Array.isArray(parsed)
      ? parsed.map((command) => String(command).trim()).filter((command) => command.length > 0)
      : [];
  } catch {
    return [];
  }
}

export function getActiveCompletionCheckForSession(db, sessionId) {
  const row = db
    .query(
      `select
        s.preset as session_preset,
        s.preset_overridden as preset_overridden,
        s.completion_check_id as session_completion_check_id,
        s.completion_check_wait_for_reply as session_completion_check_wait_for_reply,
        st.global_preset as global_preset,
        st.global_completion_check_id as global_completion_check_id,
        st.global_completion_check_wait_for_reply as global_completion_check_wait_for_reply
      from sessions s
      left join settings st on st.id = 1
      where s.session_id = ?
      limit 1`,
    )
    .get(sessionId);
  if (!row) {
    return {
      completionCheck: null,
      waitForReplyAfterCompletion: false,
    };
  }

  const presetState = resolveSessionPresetState(
    row.session_preset,
    row.preset_overridden,
    row.global_preset,
  );
  const usesSessionConfig = presetState.presetSource === "session";
  const completionCheckId = getValidGlobalCompletionCheckId(
    db,
    usesSessionConfig ? row.session_completion_check_id : row.global_completion_check_id,
  );
  if (completionCheckId === null) {
    return {
      completionCheck: null,
      waitForReplyAfterCompletion: false,
    };
  }

  const completionCheckRow = db
    .query("select id, label, commands_json from completion_checks where id = ? limit 1")
    .get(completionCheckId);
  if (!completionCheckRow) {
    return {
      completionCheck: null,
      waitForReplyAfterCompletion: false,
    };
  }

  return {
    completionCheck: {
      id: completionCheckRow.id,
      label: completionCheckRow.label,
      commands: parseCompletionCheckCommands(completionCheckRow.commands_json),
    },
    waitForReplyAfterCompletion: usesSessionConfig
      ? Boolean(row.session_completion_check_wait_for_reply)
      : Boolean(row.global_completion_check_wait_for_reply),
  };
}

function summarizeCompletionCheckOutput(output) {
  const normalizedOutput = String(output ?? "").trim();
  if (normalizedOutput.length === 0) {
    return null;
  }

  const lines = normalizedOutput
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const tail = lines.slice(-8).join("\n").trim();
  return tail.length > 0 ? tail : null;
}

export function runCompletionCheckCommands(input, completionCheck) {
  const cwd = typeof input?.cwd === "string" && input.cwd.trim().length > 0 ? input.cwd : null;
  if (cwd === null) {
    return {
      status: "skipped",
    };
  }

  if (
    !completionCheck ||
    !Array.isArray(completionCheck.commands) ||
    completionCheck.commands.length === 0
  ) {
    return {
      status: "skipped",
    };
  }

  for (const command of completionCheck.commands) {
    const result = runPlatformShellCommand({
      command,
      cwd,
    });
    const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();

    if (result.error) {
      const outputSummary = summarizeCompletionCheckOutput(combinedOutput);
      return {
        status: "failed",
        reason: [
          "Completion check failed while running:",
          command,
          outputSummary ? "" : "The command exited before completion.",
          outputSummary ? `Recent output:\n${outputSummary}` : null,
          "",
          "Fix issues.",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }

    if (result.status !== 0) {
      const outputSummary = summarizeCompletionCheckOutput(combinedOutput);
      return {
        status: "failed",
        reason: [
          "Completion check failed while running:",
          command,
          `Exit code: ${result.status}`,
          outputSummary ? `Recent output:\n${outputSummary}` : null,
          "",
          "Fix issues.",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
  }

  return {
    status: "passed",
  };
}

function applyGlobalNotificationToSession(db, sessionId, notificationId) {
  if (notificationId === null) {
    return;
  }

  withSqliteBusyRetry(() =>
    db
      .query(
        `insert into session_notifications (session_id, notification_id)
          values (?, ?)
          on conflict(session_id, notification_id) do nothing`,
      )
      .run(sessionId, notificationId),
  );
}

function allocateNextSessionRef(db) {
  const allocate = db.transaction(() => {
    const row = db.query("select last_value from session_ref_sequence where id = 1").get();
    const nextValue = (typeof row?.last_value === "number" ? row.last_value : 0) + 1;

    db.query(
      `insert into session_ref_sequence (id, last_value)
        values (1, ?)
        on conflict(id) do update set last_value = excluded.last_value`,
    ).run(nextValue);

    return `C${nextValue}`;
  });

  return withSqliteBusyRetry(() => allocate());
}

function buildNewSession(db, sessionId) {
  const timestamp = nowIsoString();
  return {
    sessionId,
    sessionRef: allocateNextSessionRef(db),
    source: "startup",
    cwd: null,
    archived: false,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    activeSince: null,
    stopCount: 0,
    preset: null,
    presetOverridden: false,
    title: null,
    transcriptPath: null,
    lastAssistantMessage: null,
  };
}

export function getSession(db, sessionId) {
  const row = db
    .query(
      `select
        session_id,
        session_ref,
        source,
        cwd,
        archived,
        first_seen_at,
        last_seen_at,
        active_since,
        stop_count,
        preset,
        preset_overridden,
        title,
        transcript_path,
        last_assistant_message
      from sessions
      where session_id = ?`,
    )
    .get(sessionId);

  if (!row) {
    return null;
  }

  return {
    sessionId: row.session_id,
    sessionRef: row.session_ref,
    source: row.source,
    cwd: row.cwd,
    archived: Boolean(row.archived),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    activeSince: row.active_since,
    stopCount: row.stop_count,
    preset: row.preset,
    presetOverridden: Boolean(row.preset_overridden),
    title: row.title,
    transcriptPath: row.transcript_path,
    lastAssistantMessage: row.last_assistant_message,
  };
}

export function writeSession(db, session, existing) {
  if (existing) {
    withSqliteBusyRetry(() =>
      db
        .query(
          `update sessions
          set session_ref = ?,
              source = ?,
              cwd = ?,
              archived = ?,
              first_seen_at = ?,
              last_seen_at = ?,
              active_since = ?,
              stop_count = ?,
              preset = ?,
              preset_overridden = ?,
              title = ?,
              transcript_path = ?,
              last_assistant_message = ?
          where session_id = ?`,
        )
        .run(
          session.sessionRef,
          session.source,
          session.cwd,
          session.archived ? 1 : 0,
          session.firstSeenAt,
          session.lastSeenAt,
          session.activeSince,
          session.stopCount,
          session.preset,
          session.presetOverridden ? 1 : 0,
          session.title,
          session.transcriptPath,
          session.lastAssistantMessage,
          session.sessionId,
        ),
    );
    return;
  }

  withSqliteBusyRetry(() =>
    db
      .query(
        `insert into sessions (
          session_id,
          session_ref,
          source,
          cwd,
          archived,
          first_seen_at,
          last_seen_at,
          active_since,
          stop_count,
          preset,
          preset_overridden,
          title,
          transcript_path,
          last_assistant_message
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.sessionId,
        session.sessionRef,
        session.source,
        session.cwd,
        session.archived ? 1 : 0,
        session.firstSeenAt,
        session.lastSeenAt,
        session.activeSince,
        session.stopCount,
        session.preset,
        session.presetOverridden ? 1 : 0,
        session.title,
        session.transcriptPath,
        session.lastAssistantMessage,
      ),
  );
}

function deriveSessionTitle(prompt) {
  const normalizedPrompt = String(prompt ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalizedPrompt.length === 0) {
    return null;
  }

  return normalizedPrompt.slice(0, 80);
}

export function upsertSession(db, input, source) {
  const existing = getSession(db, input.session_id);
  const next = existing ? { ...existing } : buildNewSession(db, input.session_id);

  next.source = source;
  if (typeof input.cwd === "string" && input.cwd.length > 0) {
    next.cwd = input.cwd;
  }
  next.lastSeenAt = nowIsoString();
  next.firstSeenAt = existing?.firstSeenAt ?? next.firstSeenAt;
  if (typeof input.transcript_path === "string" && input.transcript_path.length > 0) {
    next.transcriptPath = input.transcript_path;
  }
  if (typeof input.last_assistant_message === "string") {
    next.lastAssistantMessage = input.last_assistant_message;
  }
  if (typeof input.prompt === "string" && !next.title) {
    next.title = deriveSessionTitle(input.prompt);
  }

  const effectivePreset = resolveSessionPresetState(
    next.preset,
    next.presetOverridden,
    getSettings(db).global_preset,
  ).effectivePreset;
  if (effectivePreset !== null && next.activeSince === null) {
    next.activeSince = nowIsoString();
  } else if (effectivePreset === null && next.activeSince !== null) {
    next.activeSince = null;
  }

  writeSession(db, next, existing);
  if (!existing) {
    applyGlobalNotificationToSession(
      db,
      next.sessionId,
      getValidGlobalNotificationId(db, getSettings(db).global_notification_id),
    );
  }
  return next;
}

function isPromptOnlyArtifact(session) {
  if (session.transcriptPath !== null) {
    return false;
  }

  const titleLooksInternal = session.title?.startsWith("You are a helpful assistant.") ?? false;
  const assistantPayloadLooksInternal =
    session.lastAssistantMessage?.startsWith('{"title":') ?? false;

  return titleLooksInternal || assistantPayloadLooksInternal;
}

export function parseGeneratedTitlePayload(message) {
  if (typeof message !== "string" || message.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(message);
    return typeof parsed?.title === "string" && parsed.title.trim().length > 0
      ? parsed.title.trim()
      : null;
  } catch {
    return null;
  }
}

export function findGeneratedTitleTargetSession(db, input) {
  if (typeof input.cwd !== "string" || input.cwd.length === 0) {
    return null;
  }

  const cutoffIso = new Date(Date.now() - generatedTitleMatchWindowMs).toISOString();
  const rows = db
    .query(
      `select
        session_id,
        session_ref,
        source,
        cwd,
        archived,
        first_seen_at,
        last_seen_at,
        active_since,
        stop_count,
        preset,
        title,
        transcript_path,
        last_assistant_message
      from sessions
      where session_id != ?
        and cwd = ?
        and transcript_path is not null
        and last_seen_at >= ?
      order by last_seen_at desc`,
    )
    .all(input.session_id, input.cwd, cutoffIso)
    .map((row) => ({
      sessionId: row.session_id,
      sessionRef: row.session_ref,
      source: row.source,
      cwd: row.cwd,
      archived: Boolean(row.archived),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      activeSince: row.active_since,
      stopCount: row.stop_count,
      preset: row.preset,
      title: row.title,
      transcriptPath: row.transcript_path,
      lastAssistantMessage: row.last_assistant_message,
    }));

  return rows.find((session) => !isPromptOnlyArtifact(session)) ?? null;
}

export function updateSessionTitle(db, sessionId, title) {
  db.query("update sessions set title = ? where session_id = ?").run(title, sessionId);
}

function getRemainingTurns(db, sessionId) {
  const row = db
    .query("select remaining_turns from session_runtime where session_id = ?")
    .get(sessionId);
  return typeof row?.remaining_turns === "number" ? row.remaining_turns : null;
}

function setRemainingTurns(db, sessionId, remainingTurns) {
  db.query(
    `insert into session_runtime (session_id, remaining_turns)
      values (?, ?)
      on conflict(session_id) do update set remaining_turns = excluded.remaining_turns`,
  ).run(sessionId, remainingTurns);
}

function getSessionRemotePrompt(db, sessionId, deliveryMode) {
  const row = db
    .query(
      "select prompt_text from session_remote_prompts where session_id = ? and delivery_mode = ?",
    )
    .get(sessionId, deliveryMode);
  return typeof row?.prompt_text === "string" && row.prompt_text.trim().length > 0
    ? row.prompt_text.trim()
    : null;
}

export function getMaxTurns(preset) {
  if (preset === "max-turns-1") return 1;
  if (preset === "max-turns-2") return 2;
  if (preset === "max-turns-3") return 3;
  return null;
}

export function clearRemainingTurns(db, sessionId) {
  db.query("delete from session_runtime where session_id = ?").run(sessionId);
}

export function clearSessionAwaitingReplies(db, sessionId) {
  db.query("delete from session_awaiting_replies where session_id = ?").run(sessionId);
}

export function replaceSessionAwaitingReplies(db, sessionId, turnId, telegramTargets) {
  clearSessionAwaitingReplies(db, sessionId);

  if (!Array.isArray(telegramTargets) || telegramTargets.length === 0) {
    return 0;
  }

  const insertAwaitingReply = db.query(
    `insert into session_awaiting_replies (
      session_id,
      bot_token,
      chat_id,
      turn_id,
      started_at
    ) values (?, ?, ?, ?, ?)`,
  );
  const startedAt = nowIsoString();
  let insertedCount = 0;
  const seenTargets = new Set();

  for (const target of telegramTargets) {
    const botToken = typeof target?.botToken === "string" ? target.botToken.trim() : "";
    const chatId = typeof target?.chatId === "string" ? target.chatId.trim() : "";
    if (botToken.length === 0 || chatId.length === 0) {
      continue;
    }

    const dedupeKey = `${botToken}::${chatId}`;
    if (seenTargets.has(dedupeKey)) {
      continue;
    }

    seenTargets.add(dedupeKey);
    insertAwaitingReply.run(sessionId, botToken, chatId, turnId ?? null, startedAt);
    insertedCount += 1;
  }

  return insertedCount;
}

export function consumeSessionRemotePrompt(db, sessionId) {
  const promptText = getSessionRemotePrompt(db, sessionId, "once");

  if (promptText === null) {
    return null;
  }

  db.query(
    "delete from session_remote_prompts where session_id = ? and delivery_mode = 'once'",
  ).run(sessionId);
  return promptText;
}

export function readPersistentSessionRemotePrompt(db, sessionId) {
  return getSessionRemotePrompt(db, sessionId, "persistent");
}

export function renderPrompt(template, remainingTurns) {
  return template
    .replaceAll("{{remaining_turns}}", remainingTurns === null ? "" : String(remainingTurns))
    .trim();
}

export function getRemainingTurnState(db, sessionId, preset) {
  const maxTurns = getMaxTurns(preset);
  if (maxTurns === null) {
    return null;
  }

  const remainingTurns = getRemainingTurns(db, sessionId) ?? maxTurns;
  return {
    maxTurns,
    remainingTurns,
  };
}

export function decrementRemainingTurns(db, sessionId, remainingTurns) {
  setRemainingTurns(db, sessionId, remainingTurns - 1);
  return remainingTurns - 1;
}

export function getEffectivePreset(db, sessionId) {
  const row = db
    .query(
      `select
        s.preset as session_preset,
        s.preset_overridden as preset_overridden,
        s.archived as session_archived,
        st.global_preset as global_preset
      from sessions s
      left join settings st on st.id = 1
      where s.session_id = ?
      limit 1`,
    )
    .get(sessionId);

  if (!row || row.session_archived) {
    return null;
  }

  return resolveSessionPresetState(row.session_preset, row.preset_overridden, row.global_preset)
    .effectivePreset;
}

export function shouldWaitForReplyAfterCompletion(db, sessionId) {
  const activeGlobalCompletionCheck = getActiveCompletionCheckForSession(db, sessionId);
  return (
    activeGlobalCompletionCheck.completionCheck !== null &&
    activeGlobalCompletionCheck.waitForReplyAfterCompletion
  );
}
