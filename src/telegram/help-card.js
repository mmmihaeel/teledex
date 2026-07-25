import { fileURLToPath } from "node:url";

const HELP_CARD_ASSETS = [
  {
    filePath: fileURLToPath(
      new URL("../../assets/help/telegram-help-card-eng-1.png", import.meta.url),
    ),
    fileName: "teledex-operator-reference-1.png",
  },
  {
    filePath: fileURLToPath(
      new URL("../../assets/help/telegram-help-card-eng-2.png", import.meta.url),
    ),
    fileName: "teledex-operator-reference-2.png",
  },
];

export function getHelpCardAssets() {
  return HELP_CARD_ASSETS;
}
