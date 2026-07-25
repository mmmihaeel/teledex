import process from "node:process";

function isInactiveUserServiceError(error) {
  return Number(error?.code) === 3 || Number(error?.code) === 4;
}

export async function assertSmokeSupported(
  serviceName,
  {
    platform = process.platform,
    execFileAsync,
    conflictingServiceNames = [],
  } = {},
) {
  if (platform !== "linux") {
    throw new Error(
      "Smoke scripts are Linux/operator-only. On native Windows use the direct scripts/windows/*.cmd wrappers instead.",
    );
  }

  const serviceNames = Array.from(new Set([
    serviceName,
    ...conflictingServiceNames,
  ].filter(Boolean)));
  for (const candidateServiceName of serviceNames) {
    try {
      await execFileAsync("systemctl", ["--user", "is-active", "--quiet", candidateServiceName]);
      throw new Error(
        `${candidateServiceName} is active; refuse smoke run to avoid Telegram poll conflict`,
      );
    } catch (error) {
      if (
        error?.message?.includes("refuse smoke run to avoid Telegram poll conflict")
      ) {
        throw error;
      }
      if (isInactiveUserServiceError(error)) {
        continue;
      }

      throw new Error(
        `Unable to confirm ${candidateServiceName} is inactive via systemctl --user; fix the user service state first. ${error?.stderr?.trim() || error?.stdout?.trim() || error?.message || ""}`.trim(),
        { cause: error },
      );
    }
  }
}
