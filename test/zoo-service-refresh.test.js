import test from "node:test";
import assert from "node:assert/strict";

import { ZooService } from "../src/zoo/service.js";
import { ZooStore } from "../src/zoo/store.js";
import {
  buildConfig,
  createApiStub,
  createDeferred,
  createStateRoot,
} from "../test-support/zoo-fixtures.js";

test("ZooService does not save a snapshot for a pet deleted during refresh", async (t) => {
  const stateRoot = await createStateRoot(t);
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  const petId = "pet-refresh";
  await zooStore.savePet({
    pet_id: petId,
    display_name: "project-a",
    resolved_path: "/path/to/workspace/project-a",
    repo_root: "/path/to/workspace/project-a",
    cwd: "/path/to/workspace/project-a",
    creature_kind: "rabbit",
  });
  await zooStore.patchTopic({
    chat_id: "-1000000",
    topic_id: "700",
    topic_name: "Project Catalog",
    ui_language: "unexpected",
    menu_message_id: 901,
    active_screen: "pet",
    selected_pet_id: petId,
    refreshing_pet_id: petId,
    refresh_status_text: "Analyzing the full project...",
  });
  const analysis = createDeferred();
  const analysisStarted = createDeferred();
  let capturedAnalysisLanguage = null;
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {},
    zooStore,
    analysisRunner: async (input) => {
      capturedAnalysisLanguage = input.language;
      analysisStarted.resolve();
      return analysis.promise;
    },
  });

  const pet = await zooStore.loadPet(petId);
  const refreshPromise = service.runRefresh({
    api,
    pet,
    language: "unexpected",
  });
  await analysisStarted.promise;
  assert.equal(capturedAnalysisLanguage, "eng");
  await zooStore.deletePet(petId);

  analysis.resolve({
    pet_id: petId,
    display_name: "project-a",
    resolved_path: "/path/to/workspace/project-a",
    creature_kind: "rabbit",
    mood: "alert",
    findings: ["one"],
    stats: {
      security: 70,
      shitcode: 40,
      junk: 20,
      tests: 50,
      structure: 60,
      docs: 30,
      operability: 80,
    },
    trends: {
      security: "same",
      shitcode: "same",
      junk: "same",
      tests: "same",
      structure: "same",
      docs: "same",
      operability: "same",
    },
  });
  await refreshPromise;

  const topicState = await zooStore.loadTopic({ force: true });
  assert.equal(topicState.refreshing_pet_id, null);
  assert.equal(topicState.selected_pet_id, null);
  assert.equal(topicState.active_screen, "root");
  assert.equal(await zooStore.loadLatestSnapshot(petId), null);
  assert.equal(
    api.calls.sendMessage.some((call) => /Snapshot refreshed/u.test(call.text)),
    false,
  );
});

test("ZooService clears stale pet selection when a deleted pet refresh fails", async (t) => {
  const stateRoot = await createStateRoot(t);
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  const petId = "pet-refresh-fail";
  await zooStore.savePet({
    pet_id: petId,
    display_name: "project-a",
    resolved_path: "/path/to/workspace/project-a",
    repo_root: "/path/to/workspace/project-a",
    cwd: "/path/to/workspace/project-a",
    creature_kind: "rabbit",
  });
  await zooStore.patchTopic({
    chat_id: "-1000000",
    topic_id: "700",
    topic_name: "Project Catalog",
    ui_language: "unexpected",
    menu_message_id: 901,
    active_screen: "pet",
    selected_pet_id: petId,
    refreshing_pet_id: petId,
    refresh_status_text: "Analyzing the full project...",
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {},
    zooStore,
    analysisRunner: async (_t) => {
      await zooStore.deletePet(petId);
      throw new Error("analysis exploded");
    },
  });

  const pet = await zooStore.loadPet(petId);
  await service.runRefresh({
    api,
    pet,
    language: "unexpected",
  });

  const topicState = await zooStore.loadTopic({ force: true });
  assert.equal(topicState.refreshing_pet_id, null);
  assert.equal(topicState.selected_pet_id, null);
  assert.equal(topicState.active_screen, "root");
  assert.equal(topicState.last_refresh_error_text, null);
});
