import {
  getZooCreatureLabel,
  getZooPoseLines,
  getZooPetRefreshStatus,
  getZooPetTemperamentLabel,
} from "./creatures.js";

const ZOO_UI_LANGUAGE = "eng";

export const ZOO_COMMAND = "zoo";
export const ZOO_CALLBACK_PREFIX = "zoo";
export const ZOO_DEFAULT_TOPIC_NAME = "Project Catalog";
export const ZOO_ROOT_PAGE_SIZE = 6;

const STAT_DEFS = [
  {
    id: "security",
    label: "Security",
  },
  {
    id: "shitcode",
    label: "Shitcode",
  },
  {
    id: "junk",
    label: "Junk",
  },
  {
    id: "tests",
    label: "Tests",
  },
  {
    id: "structure",
    label: "Structure",
  },
  {
    id: "docs",
    label: "Docs",
  },
  {
    id: "operability",
    label: "Operability",
  },
];

function truncateLine(text, maxLength = 48) {
  const normalized = String(text || "").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function truncatePetButtonLabel(text, maxLength = 24) {
  const normalized = String(text || "").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const qualifierMatch = normalized.match(/^(.*)\s(\[(?:pub|priv)\])$/u);
  if (!qualifierMatch) {
    return truncateLine(normalized, maxLength);
  }

  const [, baseName, qualifier] = qualifierMatch;
  const suffix = ` ${qualifier}`;
  const available = maxLength - suffix.length;
  if (available <= 3) {
    return truncateLine(normalized, maxLength);
  }

  if (baseName.length <= available) {
    return `${baseName}${suffix}`;
  }

  return `${baseName.slice(0, available - 3)}...${suffix}`;
}

function buildCodeFence(lines) {
  return [
    "```txt",
    ...lines,
    "```",
  ].join("\n");
}

function appendLabeledLine(lines, label, text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return;
  }
  lines.push(`${label}: ${normalized}`);
}

function buildExpandableQuoteBlock(lines) {
  return lines
    .map((line) => (line ? `>> ${line}` : ">>"))
    .join("\n");
}

function renderBar(value) {
  const normalized = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const filled = Math.round(normalized / 10);
  return `[${"#".repeat(filled)}${".".repeat(10 - filled)}]`;
}

function renderTrend(trend) {
  if (trend === "up") {
    return "↑";
  }
  if (trend === "down") {
    return "↓";
  }
  return "=";

}

function buildStatLines(snapshot, _language = ZOO_UI_LANGUAGE) {
  const labelWidth = STAT_DEFS.reduce(
    (maxWidth, definition) => Math.max(maxWidth, definition.label.length),
    0,
  );

  return STAT_DEFS.map((definition) => {
    const label = definition.label.padEnd(labelWidth, " ");
    if (!snapshot) {
      return `${label} [..........]  -- ·`;
    }

    const value = String(snapshot.stats?.[definition.id] ?? 0).padStart(3, " ");
    return `${label} ${renderBar(snapshot.stats?.[definition.id])} ${value} ${renderTrend(snapshot.trends?.[definition.id])}`;
  });

}

function buildPendingAddLines(state, _language = ZOO_UI_LANGUAGE) {
  const pendingAdd = state?.pending_add;
  if (!pendingAdd) {
    return [];
  }

  if (pendingAdd.busy) {
    return [
      "add project:",
      pendingAdd.prompt_hint_text || "searching the workspace",
    ];
  }

  if (pendingAdd.stage === "await_confirmation") {
    return [
      "add project:",
      pendingAdd.prompt_hint_text || "check the candidate below and reply Yes or No",
      ...(pendingAdd.candidate_path ? ["", pendingAdd.candidate_path] : []),
      ...(pendingAdd.candidate_reason ? ["", pendingAdd.candidate_reason] : []),
      "",
      pendingAdd.candidate_question || "Is this the right project? Reply Yes or No.",
    ];
  }

  return [
    "add project:",
    pendingAdd.prompt_hint_text || "reply with a project description so I can find it",
  ];

}

function buildPetDisplayLabel(pet) {
  return pet?.display_name || "project";
}

function buildPetTemperamentLabel(pet, language = ZOO_UI_LANGUAGE) {
  return getZooPetTemperamentLabel(pet, language);
}

function buildPetRoleLabel(pet, language = ZOO_UI_LANGUAGE) {
  return `${getZooCreatureLabel(pet.creature_kind, language)} · ${buildPetTemperamentLabel(pet, language)}`;

}

function getProjectPathLabel(pet) {
  return pet.cwd_relative_to_workspace_root || pet.cwd || pet.resolved_path || pet.display_name;
}

function buildCreatureCardBlock({
  pet,
  isRefreshing = false,
  poseFrameIndex = 0,
  snapshot = null,
  language = ZOO_UI_LANGUAGE,
}) {
  const lines = [
    ...getZooPoseLines({
      creatureKind: pet.creature_kind,
      mode: isRefreshing ? "refresh" : "idle",
      frameIndex: poseFrameIndex,
    }),
  ];

  lines.push("");
  lines.push(...buildStatLines(snapshot, language));

  return buildCodeFence(lines);
}

function buildRefreshStatusLine({
  pet,
  language = ZOO_UI_LANGUAGE,
  poseFrameIndex = 0,
  fallbackText = null,
}) {
  if (fallbackText && poseFrameIndex <= 0) {
    return fallbackText;
  }

  return getZooPetRefreshStatus({
    pet,
    language,
    frameIndex: poseFrameIndex,
  });
}

export function buildZooRootText({
  language = ZOO_UI_LANGUAGE,
  pets = [],
  totalPetCount = pets.length,
  state,
  selectedPet = null,
  selectedSnapshot = null,
  currentPage = 0,
  totalPages = 1,
}) {
  const lines = [
    "Project Pets",
    "",
    `pets: ${totalPetCount}`,
  ];

  if (totalPages > 1) {
    lines.push(`page: ${currentPage + 1}/${totalPages}`);
  }

  const pendingLines = buildPendingAddLines(state, language);
  if (pendingLines.length > 0) {
    lines.push(...pendingLines);
  }
  if (state?.refreshing_pet_id && selectedPet) {
    lines.push(`refresh: ${buildPetDisplayLabel(selectedPet)}`);
  }
  if (state?.last_refresh_error_text && selectedPet) {
    lines.push(`last error: ${state.last_refresh_error_text}`);
  }

  lines.push("");
  if (pets.length === 0) {
    lines.push("Stable is empty. Tap Add project.");
  }

  if (selectedPet && selectedSnapshot && state?.active_screen === "root") {
    lines.push("");
    lines.push(`last viewed: ${selectedPet.display_name}`);
  }

  return lines.join("\n");

}

export function buildZooPetText({
  language = ZOO_UI_LANGUAGE,
  pet,
  snapshot = null,
  state,
  poseFrameIndex = 0,
}) {
  const projectPathLabel = getProjectPathLabel(pet);
  const refreshing = state?.refreshing_pet_id === pet.pet_id;
  const lines = [
    buildPetRoleLabel(pet, language),
    "",
    buildCreatureCardBlock({
      pet,
      language,
      isRefreshing: refreshing,
      poseFrameIndex,
      snapshot,
    }),
  ];

  const detailLines = [];
  if (refreshing) {
    detailLines.push(
      `status: ${buildRefreshStatusLine({
        pet,
        language,
        poseFrameIndex,
        fallbackText: state?.refresh_status_text,
      })}`,
    );
  } else if (snapshot?.mood) {
    detailLines.push(`my mood: ${snapshot.mood}`);
  }

  if (state?.last_refresh_error_text && state?.selected_pet_id === pet.pet_id) {
    detailLines.push(`last error: ${state.last_refresh_error_text}`);
  }

  if (!snapshot) {
    detailLines.push(
      refreshing
        ? "First snapshot is brewing."
        : "No snapshot yet. Tap Refresh.",
    );
    detailLines.push(`project: ${pet.display_name}`);
    detailLines.push(`repo: ${projectPathLabel}`);
    lines.push("");
    lines.push(buildExpandableQuoteBlock(detailLines));
    return lines.join("\n");
  }

  appendLabeledLine(detailLines, "voice", snapshot.flavor_line);
  appendLabeledLine(detailLines, "summary", snapshot.project_summary);
  if (snapshot.next_focus) {
    if (detailLines.at(-1) !== "") {
      detailLines.push("");
    }
    detailLines.push(`next focus: ${snapshot.next_focus}`);
  }
  if (detailLines.at(-1) !== "") {
    detailLines.push("");
  }
  detailLines.push(`project: ${pet.display_name}`);
  detailLines.push(`repo: ${projectPathLabel}`);
  detailLines.push(`refreshed: ${snapshot.refreshed_at}`);
  lines.push("");
  lines.push(buildExpandableQuoteBlock(detailLines));

  return lines.join("\n");

}

export function buildZooRemoveConfirmText({
  language = ZOO_UI_LANGUAGE,
  pet,
}) {
  return [
    "Remove this pet?",
    buildPetRoleLabel(pet, language),
    `project: ${pet.display_name}`,
    `repo: ${getProjectPathLabel(pet)}`,
    "",
    "This removes Project Catalog state only.",
  ].join("\n");

}

function buildInlineButton(text, callbackData) {
  return {
    text,
    callback_data: callbackData,
  };
}

function chunkRows(entries, size = 2) {
  const rows = [];
  for (let index = 0; index < entries.length; index += size) {
    rows.push(entries.slice(index, index + size));
  }
  return rows;
}

export function buildZooRootMarkup(pets = [], language = ZOO_UI_LANGUAGE) {
  const currentPage = 0;
  const totalPages = 1;
  return buildZooRootMarkupPage(pets, language, {
    currentPage,
    totalPages,
  });
}

export function buildZooRootMarkupPage(
  pets = [],
  language = ZOO_UI_LANGUAGE,
  {
    currentPage = 0,
    totalPages = 1,
  } = {},
) {
  void language;
  const navigationRow = [];
  if (currentPage > 0) {
    navigationRow.push(
      buildInlineButton(
        "‹ Back",
        `${ZOO_CALLBACK_PREFIX}:p:${currentPage - 1}`,
      ),
    );
  }
  if (currentPage + 1 < totalPages) {
    navigationRow.push(
      buildInlineButton(
        "Next ›",
        `${ZOO_CALLBACK_PREFIX}:p:${currentPage + 1}`,
      ),
    );
  }

  return {
    inline_keyboard: [
      ...chunkRows(
        pets.map((pet) =>
          buildInlineButton(
            truncatePetButtonLabel(buildPetDisplayLabel(pet), 24),
            `${ZOO_CALLBACK_PREFIX}:v:${pet.pet_id}`,
          )),
        2,
      ),
      ...(navigationRow.length > 0 ? [navigationRow] : []),
      [
        buildInlineButton(
          "Add project",
          `${ZOO_CALLBACK_PREFIX}:a:start`,
        ),
        buildInlineButton(
          "Respawn menu",
          `${ZOO_CALLBACK_PREFIX}:m:respawn`,
        ),
      ],
    ],
  };
}

export function buildZooPetMarkup(petId, {
  canRefresh = true,
  canRemove = true,
  language = ZOO_UI_LANGUAGE,
} = {}) {
  void language;
  return {
    inline_keyboard: [
      [
        buildInlineButton(
          "Refresh",
          canRefresh
            ? `${ZOO_CALLBACK_PREFIX}:r:${petId}`
            : `${ZOO_CALLBACK_PREFIX}:noop:refreshing`,
        ),
        buildInlineButton(
          "Remove",
          canRemove
            ? `${ZOO_CALLBACK_PREFIX}:d:${petId}`
            : `${ZOO_CALLBACK_PREFIX}:noop:removing-disabled`,
        ),
      ],
      [
        buildInlineButton(
          "Back",
          `${ZOO_CALLBACK_PREFIX}:n:root`,
        ),
        buildInlineButton(
          "Respawn menu",
          `${ZOO_CALLBACK_PREFIX}:m:respawn`,
        ),
      ],
    ],
  };
}

export function buildZooRemoveConfirmMarkup(petId, language = ZOO_UI_LANGUAGE) {
  void language;
  return {
    inline_keyboard: [
      [
        buildInlineButton(
          "Confirm remove",
          `${ZOO_CALLBACK_PREFIX}:x:${petId}`,
        ),
        buildInlineButton(
          "Cancel",
          `${ZOO_CALLBACK_PREFIX}:v:${petId}`,
        ),
      ],
      [
        buildInlineButton(
          "Back",
          `${ZOO_CALLBACK_PREFIX}:n:root`,
        ),
      ],
    ],
  };
}
