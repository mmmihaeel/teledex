export const OPERATOR_TOOLBELT_COMMANDS = [
  "bash",
  "git",
  "ssh",
  "rsync",
  "curl",
  "jq",
  "make",
  "rg",
  "fd",
  "bat",
  "tree",
  "htop",
  "lsof",
  "python3",
  "pip3",
  "gh",
  "shellcheck",
  "nc",
  "dig",
  "ss",
  "ip",
];

const OPERATOR_TOOLBELT_APT_PACKAGES = [
  "bash",
  "git",
  "openssh-client",
  "rsync",
  "curl",
  "ca-certificates",
  "gnupg",
  "jq",
  "make",
  "ripgrep",
  "fd-find",
  "bat",
  "tree",
  "htop",
  "lsof",
  "python3",
  "python3-venv",
  "python3-pip",
  "gh",
  "shellcheck",
  "netcat-openbsd",
  "dnsutils",
  "iproute2",
  "procps",
  "tar",
  "gzip",
  "xz-utils",
  "unzip",
  "gawk",
];

const OPERATOR_TOOLBELT_PACMAN_PACKAGES = [
  "bash",
  "git",
  "openssh",
  "rsync",
  "curl",
  "ca-certificates",
  "gnupg",
  "jq",
  "make",
  "ripgrep",
  "fd",
  "bat",
  "tree",
  "htop",
  "lsof",
  "python",
  "python-pip",
  "python-virtualenv",
  "github-cli",
  "shellcheck",
  "openbsd-netcat",
  "bind",
  "iproute2",
  "procps-ng",
  "tar",
  "gzip",
  "xz",
  "unzip",
  "gawk",
];

export function buildOperatorToolbeltInstallScript() {
  return [
    "install_operator_toolbelt() {",
    "  source /etc/os-release",
    "  case \"$ID\" in",
    "    ubuntu|debian)",
    "      sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update",
    `      sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y ${OPERATOR_TOOLBELT_APT_PACKAGES.join(" ")}`,
    "      ;;",
    "    arch)",
    `      sudo -n pacman -Sy --needed --noconfirm ${OPERATOR_TOOLBELT_PACMAN_PACKAGES.join(" ")}`,
    "      ;;",
    "    *) echo \"unsupported-os:$ID\" >&2; exit 1 ;;",
    "  esac",
    "}",
    "ensure_operator_tool_aliases() {",
    "  if ! command -v fd >/dev/null 2>&1 && command -v fdfind >/dev/null 2>&1; then",
    "    sudo -n ln -sf \"$(command -v fdfind)\" /usr/local/bin/fd",
    "  fi",
    "  if ! command -v bat >/dev/null 2>&1 && command -v batcat >/dev/null 2>&1; then",
    "    sudo -n ln -sf \"$(command -v batcat)\" /usr/local/bin/bat",
    "  fi",
    "}",
    buildOperatorToolbeltProbeScript({
      failOnMissing: true,
      functionName: "verify_operator_toolbelt",
    }),
    "install_operator_toolbelt",
    "ensure_operator_tool_aliases",
    "verify_operator_toolbelt",
  ].join("\n");
}

export function buildOperatorToolbeltProbeScript({
  failOnMissing = false,
  functionName = null,
} = {}) {
  const body = [
    "missing_operator_tools=()",
    `for name in ${OPERATOR_TOOLBELT_COMMANDS.map((name) => `"${name}"`).join(" ")}; do`,
    "  if ! command -v \"$name\" >/dev/null 2>&1; then",
    "    missing_operator_tools+=(\"$name\")",
    "  fi",
    "done",
    "if [[ ${#missing_operator_tools[@]} -gt 0 ]]; then",
    "  printf \"operator_toolbelt_missing=%s\\n\" \"$(IFS=,; printf \"%s\" \"${missing_operator_tools[*]}\")\"",
    failOnMissing ? "  exit 1" : "else",
    failOnMissing ? "fi" : "  printf \"operator_toolbelt_missing=\\n\"",
    failOnMissing ? null : "fi",
  ].filter(Boolean);

  if (!functionName) {
    return body.join("\n");
  }

  return [
    `${functionName}() {`,
    ...body.map((line) => `  ${line}`),
    "}",
  ].join("\n");
}

export function parseMissingOperatorTools(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
