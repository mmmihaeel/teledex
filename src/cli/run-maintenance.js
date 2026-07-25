export async function performRunOnceMaintenance({
  promptFragmentAssembler,
  queuePromptAssembler,
  runtimeObserver,
  scanPendingAgentQueue,
  sessionLifecycleManager,
}) {
  await scanPendingAgentQueue();
  await sessionLifecycleManager.sweepExpiredParkedSessions();
  const completedAt = Date.now();
  await runtimeObserver.noteRetentionSweep(
    new Date(completedAt).toISOString(),
  );
  await promptFragmentAssembler.flushAll();
  await queuePromptAssembler.flushAll();
  return completedAt;
}
