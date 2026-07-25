import { formatPercent, formatResetTime } from "./common.js";

export function buildCodexLimitsStatusLines(
  summary,
  _language = "eng",
) {
  if (summary?.unlimited) {
    return ["limits: unlimited"];
  }

  if (!summary?.available) {
    return ["limits: unavailable"];
  }

  return summary.windows.map((window) =>
    `limits ${window.label}: ${formatPercent(window.remainingPercent)} left -> ${formatResetTime(window.resetsAtIso)}`);
}

export function buildCodexLimitsMenuLines(
  summary,
  _language = "eng",
) {
  if (summary?.unlimited) {
    return ["limits: unlimited"];
  }

  if (!summary?.available) {
    return ["limits: unavailable"];
  }

  return summary.windows.map((window) =>
    `limits ${window.label}: ${formatPercent(window.remainingPercent)} left`);
}

export function formatCodexLimitsMessage(
  summary,
  _language = "eng",
) {
  if (summary?.unlimited) {
    return [
      "Codex limits",
      "",
      "mode: unlimited",
      ...(summary.planType
        ? [`plan: ${summary.planType}`]
        : []),
      ...(summary.limitName
        ? [`limit: ${summary.limitName}`]
        : []),
      ...(summary.source
        ? [`source: ${summary.source}`]
        : []),
      ...(summary.capturedAt
        ? [
            `captured: ${formatResetTime(summary.capturedAt)}`,
          ]
        : []),
    ].join("\n");
  }

  if (!summary?.available) {
    return [
      "Codex limits",
      "",
      "No readable Codex limits snapshot is available right now.",
      ...(summary?.source
        ? [
            "",
            `source: ${summary.source}`,
          ]
        : []),
    ].join("\n");
  }

  const lines = [
    "Codex limits",
    "",
    ...(summary.planType
      ? [`plan: ${summary.planType}`]
      : []),
    ...(summary.limitName
      ? [`limit: ${summary.limitName}`]
      : []),
    ...(summary.source
      ? [`source: ${summary.source}`]
      : []),
    ...(summary.capturedAt
      ? [
          `captured: ${formatResetTime(summary.capturedAt)}`,
        ]
      : []),
    "",
  ];

  for (const window of summary.windows) {
    lines.push(
      `${window.label}: ${formatPercent(window.remainingPercent)} left`,
    );
    lines.push(
      `${window.label} reset: ${formatResetTime(window.resetsAtIso)}`,
    );
  }

  return lines.join("\n");
}
