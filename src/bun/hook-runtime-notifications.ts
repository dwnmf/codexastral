// @ts-nocheck
import {
  appendHookDebugLog,
  nowIsoString,
  telegramMaxMessageLength,
  telegramNotificationFooter,
} from "./hook-runtime-support";
import { getEffectivePreset } from "./hook-runtime-session-store";

function truncateTelegramText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function buildTelegramNotificationText(sessionRef, sessionTitle, message, preset) {
  const headerParts = [];
  if (typeof sessionRef === "string" && sessionRef.trim().length > 0) {
    headerParts.push(`[${sessionRef.trim()}]`);
  }
  if (typeof sessionTitle === "string" && sessionTitle.trim().length > 0) {
    headerParts.push(sessionTitle.trim());
  }

  const header = headerParts.join(" - ");
  const segments = [header, String(message ?? "").trim()].filter(
    (segment) => typeof segment === "string" && segment.length > 0,
  );
  const replyCommandFooter =
    typeof sessionRef === "string" && sessionRef.trim().length > 0
      ? `Or send /reply ${sessionRef.trim()} your message.`
      : null;

  if (preset === "await-reply" || preset === "completion-checks") {
    segments.push("---------", telegramNotificationFooter);
  }
  if (
    preset === "infinite" ||
    preset === "max-turns-1" ||
    preset === "max-turns-2" ||
    preset === "max-turns-3"
  ) {
    segments.push(
      "---------",
      "Reply to this message in Telegram to replace the prompt that will keep being sent to this Codex chat.",
    );
  }
  if (replyCommandFooter) {
    segments.push(replyCommandFooter);
  }

  return truncateTelegramText(segments.join("\n\n"), telegramMaxMessageLength);
}

function buildTelegramBotUrl(botToken) {
  return `https://api.telegram.org/bot${botToken}/sendMessage`;
}

function getStopMessage(input) {
  return typeof input.last_assistant_message === "string"
    ? input.last_assistant_message.trim()
    : "";
}

function getSelectedNotifications(db, sessionId) {
  return db
    .query(
      `select
        n.id,
        n.label,
        n.channel,
        n.webhook_url,
        n.chat_id,
        n.bot_token,
        n.bot_url,
        n.created_at
      from notifications n
      inner join session_notifications sn on sn.notification_id = n.id
      where sn.session_id = ?
      order by n.created_at asc, n.id asc`,
    )
    .all(sessionId);
}

function getSessionNotificationContext(db, sessionId) {
  const sessionRow = db
    .query("select session_ref, title, archived from sessions where session_id = ?")
    .get(sessionId);
  if (!sessionRow || sessionRow.archived) {
    return null;
  }

  return {
    sessionRef: sessionRow.session_ref ?? null,
    sessionTitle: sessionRow.title ?? null,
    preset: getEffectivePreset(db, sessionId),
  };
}

async function sendSlackNotification(notification, message) {
  const response = await fetch(notification.webhook_url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: message }),
  });
  if (!response.ok) {
    throw new Error(`Slack notification failed with status ${response.status}`);
  }
}

function getTelegramEndpoint(notification) {
  return (
    (typeof notification.bot_token === "string" && notification.bot_token.length > 0
      ? buildTelegramBotUrl(notification.bot_token)
      : notification.bot_url) ?? null
  );
}

async function sendTelegramNotification(db, notification, input, telegramText) {
  const telegramEndpoint = getTelegramEndpoint(notification);
  if (!telegramEndpoint) {
    throw new Error("Telegram notification is missing a bot token.");
  }

  const response = await fetch(telegramEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: new URLSearchParams({
      chat_id: notification.chat_id,
      text: telegramText,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Telegram notification failed with status ${response.status}`);
  }

  const payload = await response.json();
  if (!payload?.ok || typeof payload?.result?.message_id !== "number") {
    throw new Error(payload?.description || "Telegram notification did not return a message id.");
  }

  db.query(
    `insert into telegram_delivery_receipts (
      id,
      notification_id,
      session_id,
      bot_token,
      chat_id,
      telegram_message_id,
      created_at
    ) values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    notification.id,
    input.session_id,
    typeof notification.bot_token === "string" ? notification.bot_token : "",
    notification.chat_id,
    payload.result.message_id,
    nowIsoString(),
  );

  return {
    botToken: typeof notification.bot_token === "string" ? notification.bot_token : "",
    chatId: notification.chat_id,
  };
}

async function deliverNotification(db, notification, input, message, telegramText) {
  if (notification.channel === "slack") {
    await sendSlackNotification(notification, message);
    return null;
  }

  return await sendTelegramNotification(db, notification, input, telegramText);
}

function getFailureRecord(results, notifications) {
  return results.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          {
            notificationId: notifications[index]?.id ?? null,
            channel: notifications[index]?.channel ?? null,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          },
        ]
      : [],
  );
}

async function logNotificationDelivery(input, results, notifications) {
  const failures = getFailureRecord(results, notifications);

  await appendHookDebugLog({
    type: "notification",
    hookEventName: "Stop",
    sessionId: input.session_id,
    deliveredCount: results.length - failures.length,
    failedCount: failures.length,
    failures,
  });
}

export async function sendStopNotifications(db, input) {
  if (input.hook_event_name !== "Stop") {
    return [];
  }

  const message = getStopMessage(input);
  if (message.length === 0) {
    return [];
  }

  const selectedNotifications = getSelectedNotifications(db, input.session_id);
  if (selectedNotifications.length === 0) {
    return [];
  }

  const notificationContext = getSessionNotificationContext(db, input.session_id);
  if (!notificationContext) {
    return [];
  }

  const telegramText = buildTelegramNotificationText(
    notificationContext.sessionRef,
    notificationContext.sessionTitle,
    message,
    notificationContext.preset,
  );
  const results = await Promise.allSettled(
    selectedNotifications.map((notification) =>
      deliverNotification(db, notification, input, message, telegramText),
    ),
  );

  await logNotificationDelivery(input, results, selectedNotifications);
  return results.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : [],
  );
}
