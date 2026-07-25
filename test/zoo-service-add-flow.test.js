import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { ZooService } from "../src/zoo/service.js";
import { isNo, isYes } from "../src/zoo/service-common.js";
import { buildPetIdFromPath, ZooStore } from "../src/zoo/store.js";
import {
  buildConfig,
  createApiStub,
  createDeferred,
  createStateRoot,
} from "../test-support/zoo-fixtures.js";

test("Project Catalog confirmation accepts only its English yes/no tokens", () => {
  assert.equal(isYes("yes"), true);
  assert.equal(isYes("Y"), true);
  assert.equal(isNo("no"), true);
  assert.equal(isNo("N"), true);
  assert.equal(isYes("oui"), false);
  assert.equal(isNo("non"), false);
});

test("ZooService add-project flow captures the description reply", async (t) => {
  const stateRoot = await createStateRoot(t);
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1000000",
    topic_id: "700",
    topic_name: "Project Catalog",
    ui_language: "unexpected",
    menu_message_id: 901,
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("normal sessions should stay out of Project Catalog reply flow");
      },
    },
    zooStore,
  });

  let capturedDescription = null;
  service.beginLookup = async ({
    api: zooApi,
    description,
    message,
  }) => {
    capturedDescription = description;
    await zooApi.deleteMessage({
      chat_id: message.chat.id,
      message_id: message.message_id,
    });
  };

  await service.handleCallbackQuery({
    api,
    callbackQuery: {
      id: "cb1",
      data: "zoo:a:start",
      from: { id: 1001001001, is_bot: false },
      message: {
        chat: { id: -1000000 },
        message_thread_id: 700,
      },
    },
  });

  const topicState = await service.zooStore.loadTopic({ force: true });
  assert.equal(topicState.pending_add.stage, "await_description");
  assert.equal(api.calls.sendMessage.length, 0);
  assert.match(topicState.pending_add.prompt_hint_text, /find it/u);

  const replyResult = await service.maybeHandleIncomingMessage({
    api,
    botUsername: "gatewaybot",
    message: {
      text: "my private Teledex runtime",
      from: { id: 1001001001, is_bot: false },
      chat: { id: -1000000 },
      message_thread_id: 700,
      message_id: 5,
    },
  });

  assert.equal(replyResult.reason, "zoo-lookup-started");
  assert.equal(capturedDescription, "my private Teledex runtime");
  assert.equal(api.calls.deleteMessage.at(-1).message_id, 5);
});

test("ZooService ignores stale lookup completions from an older add flow", async (t) => {
  const stateRoot = await createStateRoot(t);
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1000000",
    topic_id: "700",
    topic_name: "Project Catalog",
    ui_language: "unexpected",
    menu_message_id: 901,
    pending_add: {
      kind: "add_project",
      stage: "await_description",
      busy: true,
      requested_by_user_id: "1001001001",
      lookup_request_id: "lookup-old",
      cleanup_message_ids: [],
    },
  });
  const lookup = createDeferred();
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {
      async resolveBindingPath(requestedPath) {
        return {
          cwd: requestedPath,
          repo_root: requestedPath,
          cwd_relative_to_workspace_root:
            path.relative("/path/to/workspace", requestedPath) || ".",
        };
      },
    },
    zooStore,
    lookupRunner: async (_t) => lookup.promise,
  });

  const runPromise = service.runLookup({
    api,
    description: "gateway",
    requestedByUserId: "1001001001",
    language: "unexpected",
    lookupRequestId: "lookup-old",
  });

  await zooStore.patchTopic({
    pending_add: {
      kind: "add_project",
      stage: "await_description",
      busy: true,
      requested_by_user_id: "1001001001",
      lookup_request_id: "lookup-new",
      cleanup_message_ids: [],
    },
  });

  lookup.resolve({
    candidatePath: "/path/to/workspace/project-a",
    candidateDisplayName: "project-a",
    needsMoreDetail: false,
    reason: "best match",
    question: "Is this the right project?",
  });
  await runPromise;

  const topicState = await zooStore.loadTopic({ force: true });
  assert.equal(topicState.pending_add.lookup_request_id, "lookup-new");
  assert.equal(api.calls.sendMessage.length, 0);
});

test("ZooService stores lookup confirmation in menu state instead of sending a chat message", async (t) => {
  const stateRoot = await createStateRoot(t);
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1000000",
    topic_id: "700",
    topic_name: "Project Catalog",
    ui_language: "unexpected",
    menu_message_id: 901,
    pending_add: {
      kind: "add_project",
      stage: "await_description",
      busy: true,
      requested_by_user_id: "1001001001",
      lookup_request_id: "lookup-1",
      cleanup_message_ids: [],
    },
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {
      async resolveBindingPath(requestedPath) {
        return {
          cwd: requestedPath,
          repo_root: requestedPath,
          cwd_relative_to_workspace_root:
            path.relative("/path/to/workspace", requestedPath) || ".",
        };
      },
    },
    zooStore,
    lookupRunner: async (_t) => ({
      candidatePath: "/path/to/workspace/project-a",
      candidateDisplayName: "project-a",
      needsMoreDetail: false,
      reason: "This looks like the requested project.",
      question: "Is this the one?",
    }),
  });

  await service.runLookup({
    api,
    description: "gateway",
    requestedByUserId: "1001001001",
    language: "unexpected",
    lookupRequestId: "lookup-1",
  });

  const topicState = await zooStore.loadTopic({ force: true });
  assert.equal(topicState.pending_add.stage, "await_confirmation");
  assert.equal(topicState.pending_add.candidate_path, "/path/to/workspace/project-a");
  assert.equal(topicState.pending_add.candidate_reason, "This looks like the requested project.");
  assert.equal(topicState.pending_add.candidate_question, "Is this the one?");
  assert.equal(topicState.pending_add.candidate_display_name, "project-a");
  assert.equal(api.calls.sendMessage.length, 0);
});

test("ZooService canonicalizes public/private duplicate names during lookup confirmation", async (t) => {
  const stateRoot = await createStateRoot(t);
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.savePet({
    pet_id: "pet-private",
    display_name: "Shared Project",
    resolved_path: "/path/to/workspace/apps/shared-project",
    repo_root: "/path/to/workspace/apps/shared-project",
    cwd: "/path/to/workspace/apps/shared-project",
    cwd_relative_to_workspace_root: "apps/shared-project",
    creature_kind: "cat",
  });
  await zooStore.patchTopic({
    chat_id: "-1000000",
    topic_id: "700",
    topic_name: "Project Catalog",
    ui_language: "eng",
    menu_message_id: 901,
    pending_add: {
      kind: "add_project",
      stage: "await_description",
      busy: true,
      requested_by_user_id: "1001001001",
      lookup_request_id: "lookup-pub",
      cleanup_message_ids: [],
    },
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {
      async resolveBindingPath(requestedPath) {
        return {
          cwd: requestedPath,
          repo_root: requestedPath,
          cwd_relative_to_workspace_root:
            path.relative("/path/to/workspace", requestedPath) || ".",
        };
      },
    },
    zooStore,
    lookupRunner: async (_t) => ({
      candidatePath: "/path/to/workspace/work/public/automation/shared-project",
      candidateDisplayName: "Shared Project OSS",
      needsMoreDetail: false,
      reason: "Best match in the public workspace.",
      question: "Is this the right project?",
    }),
  });

  await service.runLookup({
    api,
    description: "public shared project",
    requestedByUserId: "1001001001",
    language: "eng",
    lookupRequestId: "lookup-pub",
  });

  const topicState = await zooStore.loadTopic({ force: true });
  assert.equal(
    topicState.pending_add.candidate_display_name,
    "shared-project [pub]",
  );
  const privatePet = await zooStore.loadPet("pet-private");
  assert.equal(privatePet.display_name, "shared-project [priv]");
});

test("ZooService stores Project Catalog pets at project root even if lookup resolved a nested path", async (t) => {
  const stateRoot = await createStateRoot(t);
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1000000",
    topic_id: "700",
    topic_name: "Project Catalog",
    ui_language: "unexpected",
    pending_add: {
      kind: "add_project",
      stage: "await_confirmation",
      busy: false,
      requested_by_user_id: "1001001001",
      candidate_path: "/path/to/workspace/project-a/src",
      candidate_display_name: "project-a",
      cleanup_message_ids: [],
    },
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {
      async resolveBindingPath() {
        return {
          cwd: "/path/to/workspace/project-a/src",
          repo_root: "/path/to/workspace/project-a",
          cwd_relative_to_workspace_root: "project-a/src",
        };
      },
    },
    zooStore,
  });

  await service.confirmPendingAdd({
    api,
    message: { message_id: 42 },
    topicState: await zooStore.loadTopic({ force: true }),
  });

  const pets = await zooStore.listPets();
  assert.equal(pets.length, 1);
  assert.equal(pets[0].cwd, "/path/to/workspace/project-a");
  assert.equal(pets[0].repo_root, "/path/to/workspace/project-a");
  assert.equal(pets[0].resolved_path, "/path/to/workspace/project-a");
});

test("ZooService resets add-project flow when the confirmed candidate path is gone", async (t) => {
  const stateRoot = await createStateRoot(t);
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1000000",
    topic_id: "700",
    topic_name: "Project Catalog",
    ui_language: "unexpected",
    menu_message_id: 901,
    pending_add: {
      kind: "add_project",
      stage: "await_confirmation",
      busy: false,
      requested_by_user_id: "1001001001",
      candidate_path: "/path/to/workspace/project-gone",
      candidate_display_name: "project-gone",
      cleanup_message_ids: [41],
    },
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {
      async resolveBindingPath() {
        throw new Error("Path is gone");
      },
    },
    zooStore,
  });

  await service.confirmPendingAdd({
    api,
    message: { message_id: 42 },
    topicState: await zooStore.loadTopic({ force: true }),
  });

  const topicState = await zooStore.loadTopic({ force: true });
  assert.equal(topicState.pending_add.stage, "await_description");
  assert.equal(topicState.pending_add.candidate_path, null);
  assert.equal(topicState.pending_add.candidate_display_name, null);
  assert.deepEqual(topicState.pending_add.cleanup_message_ids, [41, 42]);
  assert.match(api.calls.sendMessage[0].text, /Add project failed/u);
  assert.doesNotMatch(api.calls.sendMessage[0].text, /\p{Script=Cyrillic}/u);
  assert.equal(
    api.calls.deleteMessage.some((call) => call.message_id === 42),
    true,
  );
});

test("ZooService assigns random unused identity fields to new pets", async (t) => {
  const stateRoot = await createStateRoot(t);
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.savePet({
    pet_id: "pet-existing-a",
    display_name: "project-a",
    resolved_path: "/path/to/workspace/project-a",
    repo_root: "/path/to/workspace/project-a",
    cwd: "/path/to/workspace/project-a",
    creature_kind: "cat",
    temperament_id: "paladin",
    character_name: "Rainbow Dash",
  });
  await zooStore.savePet({
    pet_id: "pet-existing-b",
    display_name: "project-b",
    resolved_path: "/path/to/workspace/project-b",
    repo_root: "/path/to/workspace/project-b",
    cwd: "/path/to/workspace/project-b",
    creature_kind: "rabbit",
    temperament_id: "gremlin",
    character_name: "Pinkie Pie",
  });
  await zooStore.patchTopic({
    chat_id: "-1000000",
    topic_id: "700",
    topic_name: "Project Catalog",
    ui_language: "unexpected",
    pending_add: {
      kind: "add_project",
      stage: "await_confirmation",
      busy: false,
      requested_by_user_id: "1001001001",
      candidate_path: "/path/to/workspace/project-c",
      candidate_display_name: "project-c",
      cleanup_message_ids: [],
    },
  });
  const randomValues = [0, 0, 0];
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {
      async resolveBindingPath() {
        return {
          cwd: "/path/to/workspace/project-c",
          repo_root: "/path/to/workspace/project-c",
          cwd_relative_to_workspace_root: "project-c",
        };
      },
    },
    zooStore,
    randomSource: () => randomValues.shift() ?? 0,
  });

  await service.confirmPendingAdd({
    api,
    message: { message_id: 42 },
    topicState: await zooStore.loadTopic({ force: true }),
  });

  const pet = await zooStore.loadPet(buildPetIdFromPath("/path/to/workspace/project-c"));
  assert.equal(pet.display_name, "project-c");
  assert.equal(pet.creature_kind, "fox");
  assert.equal(pet.temperament_id, "scout");
  assert.equal(pet.character_name, "Twilight Sparkle");
});
