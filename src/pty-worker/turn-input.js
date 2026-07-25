export function buildTurnInput({
  prompt = "",
  imagePaths = [],
}) {
  const input = [];
  const normalizedPrompt = String(prompt || "");
  if (normalizedPrompt.trim()) {
    input.push({
      type: "text",
      text: normalizedPrompt,
    });
  }

  for (const imagePath of imagePaths) {
    input.push({
      type: "localImage",
      path: imagePath,
    });
  }

  return input;
}
